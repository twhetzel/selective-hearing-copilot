import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

export interface GcpGlassesSttOptions {
  wsUrl: string
  sampleRateHertz: number
  languageCode: string
  /** Called with finalized transcript segments from Google STT. */
  onFinalLine: (text: string) => void
  onStatus: (msg: string) => void
  onLog?: (msg: string, data?: unknown) => void
}

function closeHint(code: number, usedLocalhost: boolean): string {
  if (code === 1006)
    return ' — abnormal close (often wrong host, firewall, or proxy crash; check laptop IP + port 8787).'
  if (usedLocalhost)
    return ' — use ws://YOUR_LAN_IP:8787 in .env.local, not localhost.'
  if (code === 1000) return ''
  return ' — confirm GOOGLE_APPLICATION_CREDENTIALS on the machine running stt-proxy.'
}

function normalizePcm(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) return raw
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw)
  if (Array.isArray(raw)) return new Uint8Array(raw as number[])
  return new Uint8Array()
}

/**
 * Open glasses MIC via bridge, forward `audioEvent.audioPcm` to a local/reachable WebSocket
 * that runs `server/gcp-stt-proxy.mjs` (Google Cloud Speech streaming). Sends **16‑bit LE PCM**
 * chunks as the proxy expects; match `sampleRateHertz` to what the Even host delivers.
 */
export function attachGcpGlassesStt(
  bridge: EvenAppBridge,
  options: GcpGlassesSttOptions,
): () => void {
  let ws: WebSocket | null = null
  let micOpen = false
  let closed = false

  const log = options.onLog ?? (() => {})

  const sendPcm = (pcm: Uint8Array) => {
    if (!ws || ws.readyState !== WebSocket.OPEN || pcm.length === 0) return
    const slice = pcm.buffer.slice(
      pcm.byteOffset,
      pcm.byteOffset + pcm.byteLength,
    ) as ArrayBuffer
    ws.send(slice)
  }

  const warnLocalhost =
    /^(ws|wss):\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/i.test(options.wsUrl)

  const connect = () => {
    if (closed) return
    if (warnLocalhost) {
      options.onStatus(
        'Glasses STT: VITE_GCP_STT_WS_URL uses localhost — use your laptop LAN IP (e.g. ws://192.168.x.x:8787) so the phone can reach the proxy.',
      )
    }
    const socket = new WebSocket(options.wsUrl)
    socket.binaryType = 'arraybuffer'
    ws = socket

    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: 'start',
          sampleRateHertz: options.sampleRateHertz,
          languageCode: options.languageCode,
        }),
      )
      options.onStatus('Glasses STT: WebSocket connected — waiting for PCM…')
    }

    socket.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return
      try {
        const msg = JSON.parse(ev.data) as {
          type?: string
          transcript?: string
          isFinal?: boolean
          message?: string
        }
        if (msg.type === 'error' && msg.message) {
          options.onStatus(`Glasses STT: ${msg.message}`)
        }
        if (msg.type === 'ready') {
          options.onStatus('Glasses STT: Google streaming session ready')
        }
        if (msg.type === 'result' && msg.isFinal && msg.transcript?.trim()) {
          options.onFinalLine(msg.transcript.trim())
        }
      } catch {
        /* ignore */
      }
    }

    socket.onerror = () => {
      options.onStatus(
        'Glasses STT: WebSocket error — is `npm run stt-proxy` running and is the URL reachable from this device?',
      )
    }

    socket.onclose = (ev: CloseEvent) => {
      if (!closed && ws === socket) {
        const hint = closeHint(ev.code, warnLocalhost)
        options.onStatus(
          `Glasses STT: connection closed (code ${ev.code}${ev.reason ? `: ${ev.reason}` : ''})${hint}`,
        )
      }
    }
  }

  void bridge
    .audioControl(true)
    .then(() => {
      micOpen = true
      options.onStatus('Glasses STT: bridge audio on')
      log('audioControl(true) ok')
    })
    .catch((e) => {
      log('audioControl failed', e)
      options.onStatus('Glasses STT: could not open bridge mic')
    })

  connect()

  const unsub = bridge.onEvenHubEvent((event) => {
    const rawPcm = event.audioEvent?.audioPcm
    if (rawPcm == null) return
    const pcm = normalizePcm(rawPcm as unknown)
    if (pcm.length === 0) return
    sendPcm(pcm)
  })

  return () => {
    closed = true
    unsub()
    try {
      ws?.close()
    } catch {
      /* ignore */
    }
    ws = null
    if (micOpen) {
      void bridge.audioControl(false).catch(() => {
        /* ignore */
      })
    }
  }
}
