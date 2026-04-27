import {
  type EvenAppBridge,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import { HUD_CONTAINER_ID, HUD_CONTAINER_NAME } from './evenHud.ts'

function containerMatches(
  id: number | string | undefined,
  name: string | undefined,
): boolean {
  const idOk =
    id === HUD_CONTAINER_ID ||
    id === String(HUD_CONTAINER_ID) ||
    Number(id) === HUD_CONTAINER_ID
  const nameOk = name === HUD_CONTAINER_NAME
  return idOk || nameOk
}

/**
 * Temple / ring gestures on the G2 text container → app actions.
 * - Single click: “what did I miss” style recap (caller supplies handler)
 * - Double click: replay last HUD cue (caller supplies handler)
 * - Scroll up / down: optional extras
 */
export function attachGlassesTapHandlers(
  bridge: EvenAppBridge,
  handlers: {
    onHudTapSingle: () => void | Promise<void>
    onHudTapDouble: () => void | Promise<void>
    onHudScrollUp?: () => void | Promise<void>
    onHudScrollDown?: () => void | Promise<void>
  },
): () => void {
  const unsub = bridge.onEvenHubEvent((event) => {
    const te = event.textEvent
    if (!te) return
    if (!containerMatches(te.containerID, te.containerName)) return

    const et = te.eventType
    if (et === OsEventTypeList.CLICK_EVENT) {
      void handlers.onHudTapSingle()
      return
    }
    if (et === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      void handlers.onHudTapDouble()
      return
    }
    if (et === OsEventTypeList.SCROLL_TOP_EVENT) {
      void handlers.onHudScrollUp?.()
      return
    }
    if (et === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
      void handlers.onHudScrollDown?.()
      return
    }
  })

  return unsub
}
