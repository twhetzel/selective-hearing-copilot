/**
 * Local WebSocket proxy: browser forwards Even glasses PCM → Google Cloud Speech streaming STT.
 * Set GOOGLE_APPLICATION_CREDENTIALS to a service account JSON with Speech-to-Text enabled.
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json node server/gcp-stt-proxy.mjs
 *   STT_PROXY_PORT=8787 (default)
 */
import { WebSocketServer } from 'ws'
import { SpeechClient } from '@google-cloud/speech'

const PORT = Number(process.env.STT_PROXY_PORT || 8787)
const client = new SpeechClient()

function safeSend(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj))
}

const wss = new WebSocketServer({ port: PORT, host: '0.0.0.0' })

wss.on('connection', (ws, req) => {
  /** @type {import('stream').Duplex | null} */
  let recognizeStream = null
  const remote = req.socket?.remoteAddress ?? '?'
  console.info('[gcp-stt-proxy] client connected from', remote)

  ws.on('error', (err) => {
    console.error('[gcp-stt-proxy] socket error', err)
  })

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'start') {
          if (recognizeStream) {
            try {
              recognizeStream.end()
            } catch {
              /* ignore */
            }
            recognizeStream = null
          }
          const sampleRateHertz = Number(msg.sampleRateHertz) || 16000
          const languageCode =
            typeof msg.languageCode === 'string' ? msg.languageCode : 'en-US'

          try {
            recognizeStream = client
              .streamingRecognize({
                config: {
                  encoding: 'LINEAR16',
                  sampleRateHertz,
                  languageCode,
                },
                interimResults: true,
              })
              .on('error', (err) => {
                console.error('[gcp-stt-proxy] stream error', err)
                safeSend(ws, {
                  type: 'error',
                  message: err instanceof Error ? err.message : String(err),
                })
                recognizeStream = null
              })
              .on('data', (response) => {
                if (!response.results?.length) return
                const result = response.results[0]
                const alt = result.alternatives?.[0]
                if (!alt?.transcript) return
                safeSend(ws, {
                  type: 'result',
                  transcript: alt.transcript,
                  isFinal: Boolean(result.isFinal),
                })
              })

            safeSend(ws, { type: 'ready', sampleRateHertz, languageCode })
          } catch (e) {
            console.error('[gcp-stt-proxy] failed to start streamingRecognize', e)
            safeSend(ws, {
              type: 'error',
              message:
                e instanceof Error
                  ? e.message
                  : `Could not start Speech stream: ${String(e)}`,
            })
          }
        }
      } catch (e) {
        safeSend(ws, { type: 'error', message: `Bad JSON: ${String(e)}` })
      }
      return
    }

    if (!recognizeStream) {
      safeSend(ws, {
        type: 'error',
        message: 'Send {"type":"start",...} before binary PCM',
      })
      return
    }

    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    if (!buf.length) return
    try {
      recognizeStream.write(buf)
    } catch (e) {
      console.error('[gcp-stt-proxy] write PCM failed', e)
      safeSend(ws, {
        type: 'error',
        message: e instanceof Error ? e.message : String(e),
      })
    }
  })

  ws.on('close', (code, reason) => {
    console.info(
      '[gcp-stt-proxy] client disconnected',
      remote,
      code,
      reason?.toString() ?? '',
    )
    if (recognizeStream) {
      try {
        recognizeStream.end()
      } catch {
        /* ignore */
      }
      recognizeStream = null
    }
  })
})

console.info(
  `[gcp-stt-proxy] Listening on ws://0.0.0.0:${PORT} (Speech-to-Text streaming)`,
)
console.info(
  '[gcp-stt-proxy] Expect GOOGLE_APPLICATION_CREDENTIALS for a service account with Speech API.',
)
