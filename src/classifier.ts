/** Checkbox / filter keys — questions, deadlines, names, actions, technical. */
export type CueType = 'questions' | 'deadlines' | 'names' | 'actions' | 'technical'

export interface Cue {
  type: CueType
  /** Snippet safe for HUD (may be truncated). */
  text: string
}

/** HUD priority: surface directed speech and time-sensitive items first (accessibility). */
const CUE_PRIORITY: readonly CueType[] = [
  'questions',
  'deadlines',
  'actions',
  'names',
  'technical',
]

const NAME_BLOCKLIST = new Set(
  [
    'the',
    'and',
    'but',
    'for',
    'our',
    'your',
    'this',
    'that',
    'they',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
    'sunday',
    'january',
    'february',
    'march',
    'april',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
  ].map((w) => w.toLowerCase()),
)

/** First token of a vocative is probably not a person name (ASR / English junk). */
const VOCATIVE_BLOCKLIST = new Set(
  [
    ...NAME_BLOCKLIST,
    'so',
    'ok',
    'okay',
    'well',
    'now',
    'all',
    'any',
    'yes',
    'no',
    'hi',
    'hey',
    'oh',
    'um',
    'uh',
    'when',
    'what',
    'where',
    'why',
    'how',
    'who',
    'which',
    'can',
    'could',
    'would',
    'should',
    'team',
    'everyone',
    'folks',
  ].map((w) => w.toLowerCase()),
)

const ACRONYM_BLOCKLIST = new Set([
  'AM',
  'PM',
  'OK',
  'US',
  'UK',
  'EU',
  'HR',
  'IT',
  'CEO',
  'CFO',
  'CTO',
  'VP',
  'PR',
  'FYI',
])

function clip(s: string, max = 280): string {
  const t = s.trim()
  if (t.length <= max) return t
  return `${t.slice(0, max - 1)}…`
}

/** Core “reads like a question” — works on full line or remainder after vocative. */
export function isQuestionShaped(raw: string, lower: string): boolean {
  const t = raw.trim()
  if (!t) return false
  return (
    /\?/.test(t) ||
    /^(do|does|did|can|could|would|will|should|must|is|are|was|were|have|has|had|what|when|where|why|how|who|which)\b/i.test(
      t,
    ) ||
    /\b(can you|could you|would you|did you|do you|are you|will you)\b/i.test(lower)
  )
}

export interface VocativeSplit {
  token: string
  rest: string
  restLower: string
}

/**
 * Spoken forms: "Trish - are you ready?", "trish, can you hear me?", "Alex: are we good?"
 * Dash/comma/colon after a short token + question-shaped remainder ⇒ directed-at-you question.
 */
export function parseVocativePrefix(raw: string): VocativeSplit | null {
  const t = raw.trim()
  // "hey trish - are you ready" — greeting + name + dash (common in speech / ASR)
  const heyDash = t.match(/^(?:hey|hi|yo)\s+([\w'-]{2,20})\s*[-–—]\s*(.+)$/iu)
  if (heyDash) {
    return {
      token: heyDash[1],
      rest: heyDash[2],
      restLower: heyDash[2].toLowerCase(),
    }
  }
  const dash = t.match(/^([\w'-]{2,24})\s*[-–—]\s*(.+)$/u)
  if (dash) {
    return {
      token: dash[1],
      rest: dash[2],
      restLower: dash[2].toLowerCase(),
    }
  }
  const comma = t.match(/^([\w'-]{2,24})\s*,\s*(.+)$/u)
  if (comma) {
    return {
      token: comma[1],
      rest: comma[2],
      restLower: comma[2].toLowerCase(),
    }
  }
  const colon = t.match(/^([\w'-]{2,24})\s*:\s*(.+)$/u)
  if (colon) {
    return {
      token: colon[1],
      rest: colon[2],
      restLower: colon[2].toLowerCase(),
    }
  }
  return null
}

export function isVocativeDirectedQuestion(raw: string): boolean {
  const v = parseVocativePrefix(raw)
  if (!v) return false
  const tok = v.token.toLowerCase()
  if (VOCATIVE_BLOCKLIST.has(tok)) return false
  return isQuestionShaped(v.rest, v.restLower)
}

export function classifyLine(line: string): Cue[] {
  const raw = line.trim()
  if (!raw) return []

  const lower = raw.toLowerCase()
  const cues: Cue[] = []
  const seen = new Set<CueType>()

  const add = (type: CueType, text: string) => {
    if (seen.has(type)) return
    seen.add(type)
    cues.push({ type, text: clip(text) })
  }

  const directedQ = isVocativeDirectedQuestion(raw)
  const questionShaped = isQuestionShaped(raw, lower)

  if (questionShaped || directedQ) {
    add('questions', raw)
  }

  if (directedQ) {
    const v = parseVocativePrefix(raw)
    if (v && !VOCATIVE_BLOCKLIST.has(v.token.toLowerCase())) {
      add('names', v.token)
    }
  }

  if (
    /\d{1,2}:\d{2}/.test(raw) ||
    /\b\d{1,2}\s*(?:am|pm)\b/i.test(raw) ||
    /\b(?:deadline|due date|due\b|eod|end of day|by eod|asap)\b/i.test(lower) ||
    /\bby\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(
      lower,
    ) ||
    /\b(?:o['']clock|oclock)\b/i.test(lower) ||
    /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?\b/i.test(
      raw,
    ) ||
    /\d{4}-\d{2}-\d{2}/.test(raw)
  ) {
    add('deadlines', raw)
  }

  const heyName = raw.match(/\bhey,?\s+([A-Za-z][a-z]+)\b/)
  if (heyName) {
    add('names', `Hey ${heyName[1]}`)
  }
  const imName = raw.match(/\b(?:I'm|I am)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/)
  if (imName) {
    add('names', imName[1])
  }
  const callMe = raw.match(/\bcall me\s+([A-Za-z]+(?:\s+[A-Za-z]+)?)\b/i)
  if (callMe) {
    add('names', callMe[1])
  }
  const thisIs = raw.match(
    /\bthis is\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/,
  )
  if (thisIs) {
    add('names', thisIs[1])
  }

  const titlePair = raw.match(/\b([A-Z][a-z]+)\s+([A-Z][a-z]+)\b/)
  if (titlePair) {
    const a = titlePair[1].toLowerCase()
    const b = titlePair[2].toLowerCase()
    if (!NAME_BLOCKLIST.has(a) && !NAME_BLOCKLIST.has(b)) {
      add('names', `${titlePair[1]} ${titlePair[2]}`)
    }
  }

  if (
    /\b(need to|we need to|i need to|please\b|follow(?:\s+|-)?up|action item|don't forget|do not forget|we should\b|i'll\b|i will\b|remind (?:me|us|everyone)|\btodo\b|assigned to|assign to)\b/i.test(
      raw,
    )
  ) {
    add('actions', raw)
  }

  if (
    /\b(api|oauth|oauth2|gpu|cpu|sql|http|https|rest|json|xml|sdk|ble|grpc|websocket|kubernetes|k8s|docker|lambda|database|postgres|mysql|redis|cache|latency|throughput|deploy(?:ment)?|architecture|microservice|protobuf|typescript|javascript|frontend|backend)\b/i.test(
      raw,
    )
  ) {
    add('technical', raw)
  } else {
    const ac = raw.match(/\b[A-Z]{2,5}\b/g)
    if (ac) {
      const hit = ac.find((w) => !ACRONYM_BLOCKLIST.has(w))
      if (hit) add('technical', raw)
    }
  }

  return cues
}

export function filterCues(cues: Cue[], enabled: ReadonlySet<CueType>): Cue[] {
  return cues.filter((c) => enabled.has(c.type))
}

export function pickTopCue(cues: Cue[]): Cue | null {
  if (cues.length === 0) return null
  let best: Cue | null = null
  let bestIdx = Infinity
  for (const c of cues) {
    const idx = CUE_PRIORITY.indexOf(c.type)
    if (idx === -1) continue
    if (idx < bestIdx) {
      bestIdx = idx
      best = c
    }
  }
  return best
}

const HUD_LABEL: Record<CueType, string> = {
  questions: 'Q',
  deadlines: 'Due',
  actions: 'Do',
  names: 'Name',
  technical: 'Tech',
}

export function formatHudLine(cue: Cue): string {
  return `${HUD_LABEL[cue.type]}: ${cue.text}`
}

export function defaultEnabledFilters(): Set<CueType> {
  return new Set(CUE_PRIORITY)
}
