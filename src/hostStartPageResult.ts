import { StartUpPageCreateResult } from '@evenrealities/even_hub_sdk'

/**
 * The SDK's `StartUpPageCreateResult.normalize()` maps `null`, `{}`, and many object
 * shapes to `invalid (1)` even when the Flutter host meant success (e.g. `{ code: 0 }`
 * or a void JS handler return). Normalize host payloads the way real devices often send them.
 */
export function interpretHostStartPageResult(raw: unknown): StartUpPageCreateResult {
  if (raw === true) {
    return StartUpPageCreateResult.success
  }

  if (raw === null || raw === undefined) {
    console.warn(
      '[EvenHub] createStartUpPageContainer returned null/undefined — treating as success. Some WebViews omit the int return; confirm on G2.',
    )
    return StartUpPageCreateResult.success
  }

  if (typeof raw === 'number') {
    return StartUpPageCreateResult.normalize(raw)
  }

  if (typeof raw === 'string') {
    const t = raw.trim()
    if (/^[0-3]$/.test(t)) return StartUpPageCreateResult.fromInt(Number(t))
    return StartUpPageCreateResult.normalize(raw)
  }

  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>
    const preferredKeys = [
      'EhStartUpPageCreateResult',
      'ehStartUpPageCreateResult',
      'startUpPageCreateResult',
      'code',
      'result',
      'data',
      'value',
      'ret',
    ]
    for (const k of preferredKeys) {
      if (!(k in o)) continue
      const v = o[k]
      if (typeof v === 'number' && v >= 0 && v <= 3) {
        return StartUpPageCreateResult.fromInt(v)
      }
      if (typeof v === 'string' && /^[0-3]$/.test(v.trim())) {
        return StartUpPageCreateResult.fromInt(Number(v.trim()))
      }
    }
  }

  return StartUpPageCreateResult.normalize(raw)
}
