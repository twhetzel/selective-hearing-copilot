import './style.css'
import {
  classifyUtterance,
  defaultEnabledFilters,
  filterCues,
  formatHudLine,
  pickTopCue,
  type Cue,
  type CueType,
} from './classifier.ts'
import { attachGcpGlassesStt } from './glassesGcpStt.ts'
import { attachGlassesTapHandlers } from './evenTapHandlers.ts'
import { clearEvenHudSessionFlag, initEvenHud } from './evenHud.ts'
import { attachWebSpeechRecognition } from './speechFromPcm.ts'

const BUFFER_MAX = 10
const MISSED_LINES = 6

const CUE_LABELS: Record<CueType, string> = {
  questions: 'Questions directed at me',
  deadlines: 'Times/deadlines',
  names: 'Names',
  actions: 'Action items',
  technical: 'Technical concepts',
}

const DEMO_A = `Hey Jordan, can you review the API latency by Friday 5pm?
I'm Sarah from infra. We need to deploy the OAuth changes before EOD.
Does anyone have blockers for the 3:30 sync?`

const DEMO_B = `What do you think about the Postgres migration timeline?
Call me Alex if you need anything on the BLE stack.`

const DEMO_C = `The GRPC timeout might be misconfigured. Please follow up with the SDK team.
Deadline is March 15 for the architecture review.`

/** Strip `[stub]` / `[mic]` prefixes so classifiers see spoken text. */
function normalizeIngestLine(raw: string): string {
  const t = raw.trim()
  const stripped = t.replace(/^\[[^\]]+\]\s*/u, '').trim()
  return stripped || t
}

function el<T extends HTMLElement = HTMLElement>(sel: string): T {
  const n = document.querySelector(sel)
  if (!n) throw new Error(`Missing ${sel}`)
  return n as T
}

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div class="app-shell">
    <header class="app-header">
      <h1 class="app-title">Selective Hearing Co-Pilot</h1>
      <p class="app-sub">Accessibility-first cues on G2 — only what you enable reaches the glasses.</p>
      <p id="bridge-status" class="bridge-status" role="status">Even bridge: …</p>
      <p id="speech-status" class="speech-status" role="status">Live speech: …</p>
      <p class="hud-reset-row">
        <button type="button" id="btn-reset-hud-session" class="btn btn-small">Reset HUD session &amp; reload</button>
        <span class="live-hint">Use this if you see <code>invalid (1)</code> after a refresh, or glasses stay blank.</span>
      </p>
    </header>

    <main class="layout">
      <section class="panel hud-panel" aria-labelledby="hud-heading">
        <h2 id="hud-heading" class="panel-title">G2 HUD preview (576×288)</h2>
        <p class="hint">Glasses: tap HUD = missed summary · double-tap = replay cue · scroll = same</p>
        <div id="hud-preview" class="hud-preview" role="img" aria-label="HUD text mirror"></div>
      </section>

      <section class="panel controls-panel" aria-labelledby="filters-heading">
        <h2 id="filters-heading" class="panel-title">Hear on glasses</h2>
        <fieldset class="filters">
          <legend class="visually-hidden">Cue filters</legend>
          <label class="check"><input type="checkbox" name="cue" value="questions" checked /> ${CUE_LABELS.questions}</label>
          <label class="check"><input type="checkbox" name="cue" value="deadlines" checked /> ${CUE_LABELS.deadlines}</label>
          <label class="check"><input type="checkbox" name="cue" value="names" checked /> ${CUE_LABELS.names}</label>
          <label class="check"><input type="checkbox" name="cue" value="actions" checked /> ${CUE_LABELS.actions}</label>
          <label class="check"><input type="checkbox" name="cue" value="technical" checked /> ${CUE_LABELS.technical}</label>
        </fieldset>

        <div class="live-row">
          <button type="button" id="btn-web-speech" class="btn">Start / stop live speech</button>
          <span class="live-hint">With <code>VITE_GCP_STT_WS_URL</code> + <code>npm run stt-proxy</code>, glasses audio goes to Google STT <strong>and</strong> the phone mic still runs Web Speech for room pickup (both feed the transcript). HUD only shows enabled cue types.</span>
        </div>

        <div class="transcript-block">
          <label for="transcript-input" class="label">Mock transcript</label>
          <p class="transcript-hint">Text here is not classified until you press <strong>Submit</strong> (or <kbd>Ctrl</kbd>+<kbd>Enter</kbd>). The HUD preview shows the <em>last submitted</em> line — not whatever is left in the box after &quot;What did I miss?&quot;</p>
          <textarea id="transcript-input" class="transcript-input" rows="5" placeholder="Type or paste a line, then Submit…"></textarea>
          <div class="row">
            <button type="button" id="btn-submit" class="btn primary">Submit</button>
            <button type="button" id="btn-clear-transcript" class="btn secondary" aria-label="Clear mock transcript text">Clear</button>
            <button type="button" id="demo-a" class="btn">Demo: standup</button>
            <button type="button" id="demo-b" class="btn">Demo: questions</button>
            <button type="button" id="demo-c" class="btn">Demo: tech</button>
          </div>
        </div>

        <div class="missed-block">
          <button type="button" id="btn-missed" class="btn secondary">What did I miss?</button>
          <div id="missed-output" class="missed-output" role="region" aria-live="polite"></div>
        </div>
      </section>
    </main>
  </div>
`

const hudPreview = el('#hud-preview')
const bridgeStatus = el('#bridge-status')
const speechStatus = el('#speech-status')
const btnWebSpeech = el<HTMLButtonElement>('#btn-web-speech')
const transcriptInput = el<HTMLTextAreaElement>('#transcript-input')
const missedOutput = el('#missed-output')
const checkboxes = document.querySelectorAll<HTMLInputElement>('input[name="cue"]')

let enabled = defaultEnabledFilters()
let ring: string[] = []
let lastSubmittedLine = ''
/** True while Web Speech session is active (room listening mode). */
let liveSpeechRunning = false

const HUD_ROOM_IDLE = 'Room: listening…\n\nOnly cues matching your filters appear here.'
const HUD_ROOM_NO_MATCH = 'Room: listening…\n\nNo selective cue in the last utterance.'

let setHudTextRef: (text: string) => Promise<void> = async () => {}

function readEnabledFromDom(): Set<CueType> {
  const s = new Set<CueType>()
  checkboxes.forEach((cb) => {
    if (cb.checked) s.add(cb.value as CueType)
  })
  return s
}

function pushLines(lines: string[]) {
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    ring.push(t)
    if (ring.length > BUFFER_MAX) ring = ring.slice(-BUFFER_MAX)
    lastSubmittedLine = t
  }
}

function ingestTranscriptLine(raw: string) {
  const line = normalizeIngestLine(raw)
  if (!line) return
  pushLines([line])
  transcriptInput.value = [transcriptInput.value.replace(/\s*$/u, ''), line].filter(Boolean).join('\n')
  void refreshHud(setHudTextRef)
}

async function refreshHud(setHudText: (t: string) => Promise<void>) {
  if (!lastSubmittedLine) {
    await setHudText(
      liveSpeechRunning
        ? HUD_ROOM_IDLE
        : 'Selective Hearing Co-Pilot\n\nSubmit a line to preview a cue.',
    )
    return
  }
  const all = classifyUtterance(lastSubmittedLine)
  const filtered = filterCues(all, enabled)
  const top = pickTopCue(filtered)
  if (!top) {
    await setHudText(liveSpeechRunning ? HUD_ROOM_NO_MATCH : '(No cue for this line with current filters.)')
    return
  }
  await setHudText(formatHudLine(top))
}

function buildMissedHudDigest(): string {
  const lines = ring.slice(-MISSED_LINES)
  if (lines.length === 0) return 'Missed: no recent lines yet.'
  const hidden: string[] = []
  for (const line of lines) {
    for (const c of classifyUtterance(line)) {
      if (!enabled.has(c.type)) {
        hidden.push(`• ${CUE_LABELS[c.type]}: ${c.text}`)
      }
    }
  }
  if (hidden.length === 0) {
    return 'Missed: nothing filtered out in recent lines.'
  }
  return `Missed cues:\n${hidden.slice(0, 14).join('\n')}`.slice(0, 950)
}

function renderMissed() {
  const lines = ring.slice(-MISSED_LINES)
  if (lines.length === 0) {
    missedOutput.textContent = 'Submit some lines first.'
    return
  }

  const hidden: Cue[] = []
  for (const line of lines) {
    for (const c of classifyUtterance(line)) {
      if (!enabled.has(c.type)) hidden.push(c)
    }
  }

  if (hidden.length === 0) {
    missedOutput.textContent =
      'Nothing was hidden by your filters in the last few lines.'
    return
  }

  const ul = document.createElement('ul')
  ul.className = 'missed-list'
  for (const c of hidden) {
    const li = document.createElement('li')
    li.textContent = `[${CUE_LABELS[c.type]}] ${c.text}`
    ul.appendChild(li)
  }
  missedOutput.replaceChildren(ul)
}

async function boot() {
  const { setHudText, bridge } = await initEvenHud(hudPreview, (label) => {
    bridgeStatus.textContent = label
  })
  setHudTextRef = setHudText

  speechStatus.textContent = bridge
    ? 'Live speech: starting…'
    : 'Live speech: off (Even bridge not connected — use the button to try the device mic)'

  let detachTap: (() => void) | undefined
  let stopWebSpeech: (() => void) | null = null
  let detachGlassesGcp: (() => void) | undefined

  const gcpSttWsUrl = import.meta.env.VITE_GCP_STT_WS_URL?.trim()
  const sttSampleRateHz = Number(import.meta.env.VITE_STT_SAMPLE_RATE_HZ || 16000)
  const sttLanguage =
    import.meta.env.VITE_STT_LANGUAGE?.trim() || 'en-US'

  const setSpeechRunningUi = (running: boolean) => {
    btnWebSpeech.textContent = running ? 'Stop live speech' : 'Start live speech'
  }

  const startGlassesGcp = () => {
    if (!bridge || !gcpSttWsUrl || detachGlassesGcp) return
    detachGlassesGcp = attachGcpGlassesStt(bridge, {
      wsUrl: gcpSttWsUrl,
      sampleRateHertz: Number.isFinite(sttSampleRateHz) ? sttSampleRateHz : 16000,
      languageCode: sttLanguage,
      onFinalLine: (text) => {
        ingestTranscriptLine(`[gcp] ${text}`)
      },
      onStatus: (m) => {
        speechStatus.textContent = m
      },
      onLog: (msg, data) => {
        console.info('[Glasses GCP STT]', msg, data ?? '')
      },
    })
    liveSpeechRunning = true
    setSpeechRunningUi(true)
    void refreshHud(setHudText)
  }

  const startWebSpeechOnly = async () => {
    if (stopWebSpeech) return
    const detach = await attachWebSpeechRecognition(
      ingestTranscriptLine,
      (m) => {
        speechStatus.textContent = m
      },
      { ambientRoom: true },
    )
    if (detach == null) {
      if (!detachGlassesGcp) {
        setSpeechRunningUi(false)
        liveSpeechRunning = false
      }
      return
    }
    stopWebSpeech = detach
    liveSpeechRunning = true
    setSpeechRunningUi(true)
    void refreshHud(setHudText)
  }

  const startLiveSpeech = async () => {
    if (stopWebSpeech || detachGlassesGcp) return
    if (bridge && gcpSttWsUrl) {
      startGlassesGcp()
      await startWebSpeechOnly()
      return
    }
    await startWebSpeechOnly()
  }

  const stopLiveSpeech = () => {
    detachGlassesGcp?.()
    detachGlassesGcp = undefined
    stopWebSpeech?.()
    stopWebSpeech = null
    liveSpeechRunning = false
    setSpeechRunningUi(false)
    speechStatus.textContent = bridge
      ? 'Live speech: stopped (tap Start to resume)'
      : 'Live speech: stopped'
    void refreshHud(setHudText)
  }

  if (bridge) {
    await startLiveSpeech()
    detachTap = attachGlassesTapHandlers(bridge, {
      onHudTapSingle: async () => {
        renderMissed()
        await setHudText(buildMissedHudDigest())
      },
      onHudTapDouble: async () => {
        await refreshHud(setHudText)
      },
      onHudScrollUp: async () => {
        renderMissed()
        await setHudText(buildMissedHudDigest())
      },
      onHudScrollDown: async () => {
        await refreshHud(setHudText)
      },
    })
  } else {
    setSpeechRunningUi(false)
  }

  checkboxes.forEach((cb) => {
    cb.addEventListener('change', () => {
      enabled = readEnabledFromDom()
      void refreshHud(setHudText)
    })
  })

  el('#btn-submit').addEventListener('click', () => {
    const text = transcriptInput.value
    const lines = text.split(/\r?\n/)
    pushLines(lines)
    void refreshHud(setHudText)
  })

  const loadDemo = (s: string) => {
    transcriptInput.value = s
    pushLines(s.split(/\r?\n/))
    void refreshHud(setHudText)
  }

  el('#demo-a').addEventListener('click', () => loadDemo(DEMO_A))
  el('#demo-b').addEventListener('click', () => loadDemo(DEMO_B))
  el('#demo-c').addEventListener('click', () => loadDemo(DEMO_C))

  el('#btn-clear-transcript').addEventListener('click', () => {
    transcriptInput.value = ''
    transcriptInput.focus()
  })

  el('#btn-missed').addEventListener('click', () => {
    renderMissed()
    // Keep the web HUD preview on the primary cue; missed list is in the panel below.
    void refreshHud(setHudText)
  })

  transcriptInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || (!e.ctrlKey && !e.metaKey)) return
    e.preventDefault()
    el('#btn-submit').click()
  })

  el('#btn-reset-hud-session').addEventListener('click', () => {
    clearEvenHudSessionFlag()
    window.location.reload()
  })

  btnWebSpeech.addEventListener('click', () => {
    if (stopWebSpeech) {
      stopLiveSpeech()
    } else {
      void startLiveSpeech()
    }
  })

  window.addEventListener('beforeunload', () => {
    detachTap?.()
    detachGlassesGcp?.()
    stopWebSpeech?.()
  })

  await refreshHud(setHudText)
}

void boot()
