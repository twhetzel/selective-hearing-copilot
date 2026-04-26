import './style.css'
import {
  classifyLine,
  defaultEnabledFilters,
  filterCues,
  formatHudLine,
  pickTopCue,
  type Cue,
  type CueType,
} from './classifier.ts'
import { attachGlassesTapHandlers } from './evenTapHandlers.ts'
import { clearEvenHudSessionFlag, initEvenHud } from './evenHud.ts'
import {
  attachPcmSpeechStub,
  attachWebSpeechRecognition,
} from './speechFromPcm.ts'

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
      <p id="pcm-status" class="pcm-status" role="status">PCM / speech: …</p>
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
          <button type="button" id="btn-web-speech" class="btn">Phone mic (Web Speech)</button>
          <span class="live-hint">PCM stub runs in Even app when bridge connects (VAD → demo lines). Web Speech uses the phone microphone in the WebView.</span>
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
const pcmStatus = el('#pcm-status')
const transcriptInput = el<HTMLTextAreaElement>('#transcript-input')
const missedOutput = el('#missed-output')
const checkboxes = document.querySelectorAll<HTMLInputElement>('input[name="cue"]')

let enabled = defaultEnabledFilters()
let ring: string[] = []
let lastSubmittedLine = ''

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
    await setHudText('Selective Hearing Co-Pilot\n\nSubmit a line to show a cue.')
    return
  }
  const all = classifyLine(lastSubmittedLine)
  const filtered = filterCues(all, enabled)
  const top = pickTopCue(filtered)
  if (!top) {
    await setHudText('(No cue for this line with current filters.)')
    return
  }
  await setHudText(formatHudLine(top))
}

function buildMissedHudDigest(): string {
  const lines = ring.slice(-MISSED_LINES)
  if (lines.length === 0) return 'Missed: no recent lines yet.'
  const hidden: string[] = []
  for (const line of lines) {
    for (const c of classifyLine(line)) {
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
    for (const c of classifyLine(line)) {
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

  pcmStatus.textContent =
    bridge
      ? 'PCM / speech: ready (stub attaches below)'
      : 'PCM / speech: bridge offline (desktop preview)'

  let detachPcm: (() => void) | undefined
  let detachTap: (() => void) | undefined
  let stopWebSpeech: (() => void) | null = null

  if (bridge) {
    detachPcm = attachPcmSpeechStub(bridge, ingestTranscriptLine, {
      onStatus: (m) => {
        pcmStatus.textContent = m
      },
      onLog: (msg, data) => {
        console.info('[PCM stub]', msg, data ?? '')
      },
    })

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

  el('#btn-web-speech').addEventListener('click', () => {
    if (stopWebSpeech) {
      stopWebSpeech()
      stopWebSpeech = null
      pcmStatus.textContent = bridge
        ? 'Web Speech stopped. PCM stub still active if connected.'
        : 'Web Speech stopped.'
      return
    }
    stopWebSpeech = attachWebSpeechRecognition(ingestTranscriptLine, (m) => {
      pcmStatus.textContent = m
    })
  })

  window.addEventListener('beforeunload', () => {
    detachPcm?.()
    detachTap?.()
    stopWebSpeech?.()
  })

  await refreshHud(setHudText)
}

void boot()
