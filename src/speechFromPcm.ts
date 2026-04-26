import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

export interface PcmSpeechStubOptions {
  rmsThreshold?: number
  emitIntervalMs?: number
  onStatus?: (msg: string) => void
  onLog?: (msg: string, data?: unknown) => void
}

/** Demo lines that exercise vocative + questions + other cues (hackathon stub). */
const STUB_TRANSCRIPT_ROTATION = [
  'Trish - are you ready for the review?',
  'Can you send the deck by 5 PM Friday?',
  'We need to follow up on the OAuth rollout before EOD.',
  'The API latency spike might be in the GRPC layer.',
]

function normalizePcm(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) return raw
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw)
  if (Array.isArray(raw)) return new Uint8Array(raw as number[])
  return new Uint8Array()
}

/** 16-bit little-endian mono PCM → RMS normalized ~[0,1]. */
function pcmChunkRms(pcm: Uint8Array): number {
  if (pcm.length < 2) return 0
  const len = pcm.byteLength - (pcm.byteLength % 2)
  const view = new DataView(pcm.buffer, pcm.byteOffset, len)
  let sum = 0
  const n = len / 2
  for (let i = 0; i < len; i += 2) {
    const s = view.getInt16(i, true)
    sum += s * s
  }
  if (n === 0) return 0
  return Math.sqrt(sum / n) / 32768
}

/**
 * Opens Even mic, listens for `audioEvent` PCM, and emits **stub** transcript lines when
 * voice activity (RMS) crosses threshold — swap `STUB_TRANSCRIPT_ROTATION` for real STT later.
 */
export function attachPcmSpeechStub(
  bridge: EvenAppBridge,
  onTranscriptLine: (line: string) => void,
  options: PcmSpeechStubOptions = {},
): () => void {
  const rmsThreshold = options.rmsThreshold ?? 0.025
  const emitIntervalMs = options.emitIntervalMs ?? 3200
  let lastEmit = 0
  let stubIdx = 0
  let micOpen = false

  const openMic = async () => {
    try {
      await bridge.audioControl(true)
      micOpen = true
      options.onStatus?.('PCM → speech stub: mic on')
      options.onLog?.('audioControl(true) ok')
    } catch (e) {
      options.onLog?.('audioControl failed', e)
      options.onStatus?.('PCM stub: mic unavailable')
    }
  }

  void openMic()

  const unsub = bridge.onEvenHubEvent((event) => {
    const rawPcm = event.audioEvent?.audioPcm
    if (rawPcm == null) return
    const pcm = normalizePcm(rawPcm as unknown)
    if (pcm.length === 0) return

    const rms = pcmChunkRms(pcm)
    const now = Date.now()
    if (rms < rmsThreshold || now - lastEmit < emitIntervalMs) return

    lastEmit = now
    const script = STUB_TRANSCRIPT_ROTATION[stubIdx % STUB_TRANSCRIPT_ROTATION.length]
    stubIdx += 1
    options.onLog?.('PCM stub VAD tick', { rms: Math.round(rms * 1000) / 1000, bytes: pcm.length })
    onTranscriptLine(`[stub] ${script}`)
  })

  return () => {
    unsub()
    if (micOpen) {
      void bridge.audioControl(false).catch(() => {
        /* ignore */
      })
    }
  }
}

/** Minimal typing for Web Speech in WebView (prefix varies by engine). */
interface WebSpeechRecognition extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  start(): void
  stop(): void
  onresult: ((this: WebSpeechRecognition, ev: SpeechRecognitionEvent) => void) | null
  onerror: ((this: WebSpeechRecognition, ev: SpeechRecognitionErrorEvent) => void) | null
}

type SpeechRecognitionCtor = new () => WebSpeechRecognition

/** Optional: browser Web Speech (phone mic) — not fed by Even PCM, but useful in WebView demos. */
export function attachWebSpeechRecognition(
  onFinalLine: (line: string) => void,
  onStatus: (msg: string) => void,
): () => void {
  const W = window as Window & {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  const R = W.SpeechRecognition ?? W.webkitSpeechRecognition
  if (!R) {
    onStatus('Web Speech API not available in this WebView')
    return () => {}
  }

  const rec = new R()

  rec.continuous = true
  rec.interimResults = false
  rec.lang = navigator.language || 'en-US'

  rec.onresult = (ev: SpeechRecognitionEvent) => {
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      if (!ev.results[i].isFinal) continue
      const t = ev.results[i][0].transcript.trim()
      if (t) onFinalLine(`[mic] ${t}`)
    }
  }

  rec.onerror = (ev: SpeechRecognitionErrorEvent) => {
    onStatus(`Web Speech: ${ev.error}`)
  }

  try {
    rec.start()
    onStatus('Web Speech: listening (phone mic)')
  } catch (e) {
    onStatus(`Web Speech: could not start (${String(e)})`)
    return () => {}
  }

  return () => {
    try {
      rec.stop()
    } catch {
      /* ignore */
    }
  }
}
