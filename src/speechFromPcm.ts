/** Minimal typing for Web Speech in WebView (prefix varies by engine). */
interface WebSpeechRecognition extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  start(): void
  stop(): void
  onresult: ((this: WebSpeechRecognition, ev: SpeechRecognitionEvent) => void) | null
  onerror: ((this: WebSpeechRecognition, ev: SpeechRecognitionErrorEvent) => void) | null
  onend: (() => void) | null
}

type SpeechRecognitionCtor = new () => WebSpeechRecognition

export interface WebSpeechOptions {
  /**
   * Request mic with weaker echo-cancellation / AGC before Web Speech (default true).
   * Best effort for “room” pickup on phone; still uses device mic in the WebView.
   */
  ambientRoom?: boolean
}

/**
 * Prime mic access with constraints tuned for environmental pickup, then release.
 * Triggers permission prompt; on some Android/Chrome builds this nudges input before Web Speech.
 */
async function primeAmbientListening(onStatus: (msg: string) => void): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    onStatus('Room: getUserMedia unavailable — using default mic for speech')
    return
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        ...({
          googEchoCancellation: false,
          googNoiseSuppression: false,
          googAutoGainControl: false,
        } as Record<string, boolean>),
      },
    })
    for (const track of stream.getTracks()) {
      track.stop()
    }
    onStatus('Room: ambient mic profile set — starting speech…')
  } catch (e) {
    onStatus(`Room: could not use ambient mic (${String(e)}) — starting speech anyway`)
  }
}

/**
 * Phone / browser mic → Web Speech API. In the Even app WebView this is the practical way to get
 * real text for classification and the HUD. (Glasses PCM is not wired to a cloud STT in this repo.)
 */
export async function attachWebSpeechRecognition(
  onFinalLine: (line: string) => void,
  onStatus: (msg: string) => void,
  options: WebSpeechOptions = {},
): Promise<(() => void) | null> {
  const ambient = options.ambientRoom !== false
  if (ambient) {
    await primeAmbientListening(onStatus)
  }

  const W = window as Window & {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  const R = W.SpeechRecognition ?? W.webkitSpeechRecognition
  if (!R) {
    onStatus('Web Speech API not available in this WebView')
    return null
  }

  const rec = new R()

  rec.continuous = true
  rec.interimResults = false
  rec.lang = navigator.language || 'en-US'

  let intentActive = true

  rec.onresult = (ev: SpeechRecognitionEvent) => {
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      if (!ev.results[i].isFinal) continue
      const t = ev.results[i][0].transcript.trim()
      if (t) onFinalLine(`[mic] ${t}`)
    }
  }

  rec.onerror = (ev: SpeechRecognitionErrorEvent) => {
    if (ev.error === 'no-speech' || ev.error === 'aborted') return
    onStatus(`Web Speech: ${ev.error}`)
  }

  rec.onend = () => {
    if (!intentActive) return
    try {
      rec.start()
    } catch {
      onStatus('Web Speech: session ended (could not restart)')
    }
  }

  const stop = () => {
    intentActive = false
    try {
      rec.stop()
    } catch {
      /* ignore */
    }
  }

  try {
    rec.start()
    onStatus('Room: listening — HUD shows only cues that match your filters')
  } catch (e) {
    onStatus(`Web Speech: could not start (${String(e)})`)
    return null
  }

  return stop
}
