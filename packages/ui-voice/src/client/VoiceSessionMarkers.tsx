import { useEffect } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { VoiceHistorySnapshot } from './voice-history.ts'
import css from './VoiceSessionMarkers.module.css'

/** Root overlay that annotates the host-owned session rows with Voice markers. */
export interface VoiceSessionMarkersInjected {
  hooks: {
    voiceHistory: { getSnapshot(): VoiceHistorySnapshot; subscribe(listener: () => void): () => void }
  }
}

export type VoiceSessionMarkersProps =
  PropsRuntime<'shell.overlay'> & InjectFace<VoiceSessionMarkersInjected>

/**
 * The workspace package currently owns the session-row renderer and does not
 * expose a row-level slot. This small, read-only decorator keeps the marker in
 * sync with that renderer while leaving row interactions and layout intact.
 */
export function VoiceSessionMarkers({ useSessions, useVoiceHistory }: VoiceSessionMarkersProps) {
  const sessions = useSessions(state => state.byId)
  const history = useVoiceHistory(state => state.entries)

  useEffect(() => {
    const voiceTitles = new Set<SessionId>(history.map(entry => entry.sessionId))
    const sessionIds = new Set(Object.keys(sessions))

    let frame = 0
    const decorate = (): void => {
      frame = 0
      const rows = document.querySelectorAll<HTMLElement>('[role="treeitem"].sessionRow, [role="treeitem"][class*="sessionRow"]')
      for (const row of rows) {
        const slot = row.querySelector<HTMLElement>('[class*="slot"]')
        const marker = row.querySelector<HTMLElement>('[data-voice-session-marker]')
        const sessionId = findSessionKey(row, sessionIds)
        const isVoice = sessionId !== undefined && voiceTitles.has(sessionId as SessionId)
        if (!isVoice) {
          marker?.remove()
          continue
        }
        if (marker !== null) continue
        const target = slot ?? createMarkerSlot(row)
        target.append(createMarker())
      }
    }
    const schedule = (): void => {
      if (frame !== 0) return
      frame = requestAnimationFrame(decorate)
    }
    decorate()
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      if (frame !== 0) cancelAnimationFrame(frame)
      document.querySelectorAll('[data-voice-session-marker]').forEach(node => { node.remove() })
      document.querySelectorAll('[data-voice-session-marker-slot]').forEach(node => { node.remove() })
    }
  }, [history, sessions])

  return null
}

/** React keeps the keyed SessionNodeItem identity on the row's owner fiber. */
function findSessionKey(row: HTMLElement, sessionIds: Set<string>): string | undefined {
  const fiberKey = Object.keys(row).find(key => key.startsWith('__reactFiber$'))
  if (fiberKey === undefined) return undefined
  let fiber = (row as unknown as Record<string, unknown>)[fiberKey] as { key: string | null; return?: unknown } | undefined
  while (fiber !== undefined) {
    if (fiber.key !== null && sessionIds.has(fiber.key)) return fiber.key
    fiber = fiber.return as typeof fiber | undefined
  }
  return undefined
}

function createMarkerSlot(row: HTMLElement): HTMLSpanElement {
  const slot = document.createElement('span')
  slot.dataset.voiceSessionMarkerSlot = ''
  slot.className = css.slot ?? 'voice-session-marker-slot'
  const title = row.querySelector<HTMLElement>('[class*="title"]')
  row.insertBefore(slot, title ?? row.firstChild ?? null)
  return slot
}

function createMarker(): HTMLSpanElement {
  const marker = document.createElement('span')
  marker.dataset.voiceSessionMarker = ''
  marker.className = css.marker ?? 'voice-session-marker'
  marker.setAttribute('aria-hidden', 'true')
  marker.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h1.5M6 5v6M9 3.5v9M12 5.5v5M14 7h-1" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/></svg>'
  return marker
}
