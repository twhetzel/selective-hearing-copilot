import {
  CreateStartUpPageContainer,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { interpretHostStartPageResult } from './hostStartPageResult.ts'

export const HUD_CONTAINER_ID = 1
export const HUD_CONTAINER_NAME = 'main'

/**
 * After a successful startup page once, we must NOT call `createStartUpPageContainer` again in the same
 * browsing session — a reload or Vite HMR would get `invalid (1)`. Skip create and use upgrades only.
 */
export const HUD_SESSION_STORAGE_KEY = 'shc.evenHud.startupPageOk'

function readHudSessionOk(): boolean {
  try {
    return sessionStorage.getItem(HUD_SESSION_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function writeHudSessionOk(): void {
  try {
    sessionStorage.setItem(HUD_SESSION_STORAGE_KEY, '1')
  } catch {
    /* private mode / blocked storage */
  }
}

/** Call before a full reload if glasses stay blank or you need a fresh `createStartUpPageContainer`. */
export function clearEvenHudSessionFlag(): void {
  try {
    sessionStorage.removeItem(HUD_SESSION_STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

const INITIAL_MAX = 1000
const UPGRADE_MAX = 2000
const BRIDGE_WAIT_MS = 4000

const CREATE_RESULT_LABEL: Record<StartUpPageCreateResult, string> = {
  [StartUpPageCreateResult.success]: 'success (0) — OK',
  [StartUpPageCreateResult.invalid]: 'invalid (1) — container spec rejected',
  [StartUpPageCreateResult.oversize]: 'oversize (2) — content/count limits',
  [StartUpPageCreateResult.outOfMemory]: 'outOfMemory (3)',
}

function describeCreateResult(code: StartUpPageCreateResult): string {
  return CREATE_RESULT_LABEL[code] ?? `unknown (${String(code)})`
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('bridge-timeout')), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

function clampText(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max - 1)}…`
}

export type BridgeMode = 'connected' | 'preview-only'

export interface EvenHudController {
  mode: BridgeMode
  setHudText: (text: string) => Promise<void>
  /** Non-null when `waitForEvenAppBridge` resolved (Even WebView). */
  bridge: EvenAppBridge | null
  /** Normalized host result after `createStartUpPageContainer`; null if bridge never connected or threw before create. */
  lastCreateResult: StartUpPageCreateResult | null
  /** Raw host return value for debugging. */
  lastCreateRaw: unknown
}

/**
 * Wait for Even App bridge (with timeout for desktop dev), create full-screen G2 text container, return updater.
 */
export async function initEvenHud(
  previewEl: HTMLElement,
  onStatus: (label: string, mode: BridgeMode) => void,
): Promise<EvenHudController> {
  let bridge: EvenAppBridge | null = null
  let mode: BridgeMode = 'preview-only'
  let createFailed = false
  let loggedUpgradeError = false
  let lastCreateResult: StartUpPageCreateResult | null = null
  let lastCreateRaw: unknown = null

  const applyPreview = (text: string) => {
    previewEl.textContent = text || ' '
  }

  try {
    bridge = await withTimeout(waitForEvenAppBridge(), BRIDGE_WAIT_MS)
    mode = 'connected'
    onStatus('Even bridge: connected', mode)

    try {
      const w = window as unknown as Record<string, unknown>
      const hintKeys = Object.keys(w).filter((k) =>
        /even|widget|hub|eh/i.test(k),
      )
      if (hintKeys.length) {
        console.info('[EvenHub] window.* keys (hint):', hintKeys)
      }
    } catch {
      /* ignore */
    }

    // Match official first-app sample (ASCII, no smart punctuation) for maximum host compatibility.
    const initialContent = clampText('Hello from G2!', INITIAL_MAX)
    const textProp = new TextContainerProperty({
      xPosition: 0,
      yPosition: 0,
      width: 576,
      height: 288,
      borderWidth: 0,
      borderColor: 5,
      borderRadius: 0,
      paddingLength: 4,
      containerID: HUD_CONTAINER_ID,
      containerName: HUD_CONTAINER_NAME,
      content: initialContent,
      isEventCapture: 1,
    })

    const payload = new CreateStartUpPageContainer({
      containerTotalNum: 1,
      textObject: [textProp],
    })

    if (readHudSessionOk()) {
      lastCreateRaw = 'skipped:session-reuse'
      lastCreateResult = StartUpPageCreateResult.success
      createFailed = false
      console.info(
        '[EvenHub] Skipping createStartUpPageContainer — startup already succeeded in this tab (reload/HMR safe).',
        'To force a new create: clear session key',
        HUD_SESSION_STORAGE_KEY,
        'then reload.',
      )
      onStatus(
        'Even bridge: connected (HUD session reuse — upgrades only; use Reset if glasses are blank)',
        mode,
      )
    } else {
      try {
        const payloadJson = payload.toJson()
        console.info('[EvenHub] createStartUpPageContainer payload (JSON):', payloadJson)
      } catch {
        console.info('[EvenHub] createStartUpPageContainer payload (object):', payload)
      }

      try {
        await Promise.resolve()

        lastCreateRaw = await bridge.createStartUpPageContainer(payload)
        lastCreateResult = interpretHostStartPageResult(lastCreateRaw)

        console.info(
          '[EvenHub] createStartUpPageContainer raw host return:',
          lastCreateRaw,
          '(typeof',
          typeof lastCreateRaw,
          ')',
        )
        if (lastCreateRaw !== null && typeof lastCreateRaw === 'object') {
          try {
            console.info('[EvenHub] raw JSON:', JSON.stringify(lastCreateRaw))
          } catch {
            /* ignore */
          }
        }
        console.info(
          '[EvenHub] createStartUpPageContainer interpreted:',
          lastCreateResult,
          '—',
          describeCreateResult(lastCreateResult),
        )

        if (lastCreateResult !== StartUpPageCreateResult.success) {
          console.warn(
            '[EvenHub] createStartUpPageContainer not success — trying rebuildPageContainer once (some hosts expect this path).',
          )
          try {
            const rebuildPayload = new RebuildPageContainer({
              containerTotalNum: 1,
              textObject: [textProp],
            })
            const rebuilt = await bridge.rebuildPageContainer(rebuildPayload)
            console.info('[EvenHub] rebuildPageContainer return:', rebuilt)
            if (rebuilt === true) {
              lastCreateResult = StartUpPageCreateResult.success
              createFailed = false
              mode = 'connected'
              writeHudSessionOk()
              onStatus(
                'Even bridge: connected (HUD via rebuild — textContainerUpgrade enabled)',
                mode,
              )
              console.info('[EvenHub] rebuild OK — textContainerUpgrade enabled')
            } else {
              createFailed = true
              mode = 'preview-only'
              onStatus(
                `Even bridge: connected (HUD create failed — ${describeCreateResult(lastCreateResult)}; rebuild also false — try Reset HUD session + reload)`,
                mode,
              )
            }
          } catch (rebuildErr) {
            createFailed = true
            mode = 'preview-only'
            console.warn('[EvenHub] rebuildPageContainer threw:', rebuildErr)
            onStatus(
              `Even bridge: connected (HUD create failed — ${describeCreateResult(lastCreateResult)})`,
              mode,
            )
          }
        } else {
          writeHudSessionOk()
          console.info('[EvenHub] createStartUpPageContainer OK — textContainerUpgrade enabled')
        }
      } catch (createErr) {
        createFailed = true
        mode = 'preview-only'
        lastCreateResult = StartUpPageCreateResult.invalid
        lastCreateRaw = createErr
        console.warn('[EvenHub] createStartUpPageContainer threw (host/bridge exception):', createErr)
        onStatus(
          'Even bridge: connected (HUD create threw — preview only; see console)',
          mode,
        )
      }
    }
  } catch (e) {
    bridge = null
    mode = 'preview-only'
    lastCreateResult = null
    lastCreateRaw = null
    console.info('[EvenHub] Bridge unavailable or timeout (desktop dev?):', e)
    onStatus('Even bridge: preview only (open in Even app for G2)', mode)
  }

  applyPreview('Waiting for cues…')

  const setHudText = async (text: string) => {
    const safe = clampText(text.trim() || ' ', UPGRADE_MAX)
    applyPreview(safe)

    if (!bridge || createFailed || mode !== 'connected') return

    try {
      const upgrade = new TextContainerUpgrade({
        containerID: HUD_CONTAINER_ID,
        containerName: HUD_CONTAINER_NAME,
        content: safe,
        contentOffset: 0,
        contentLength: safe.length,
      })
      await bridge.textContainerUpgrade(upgrade)
    } catch (e) {
      if (!loggedUpgradeError) {
        loggedUpgradeError = true
        console.warn('[EvenHub] textContainerUpgrade failed:', e)
      }
    }
  }

  return {
    mode,
    setHudText,
    bridge,
    lastCreateResult,
    lastCreateRaw,
  }
}
