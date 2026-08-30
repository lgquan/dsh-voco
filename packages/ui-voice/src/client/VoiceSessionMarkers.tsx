import { useEffect, useRef } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { VoiceHistorySnapshot } from './voice-history.ts'
import css from './VoiceSessionMarkers.module.css'

/** Root overlay that annotates the host-owned session rows with Voice markers. */
export interface VoiceSessionMarkersInjected {
  hooks: {
    voiceHistory: { getSnapshot(): VoiceHistorySnapshot; subscribe(listener: () => void): () => void }
  }
  openSession: (id: SessionId) => void
  refreshSubagents: (parentSessionId: SessionId) => void
  setSubagentCatalogOpen: (parentSessionId: SessionId, open: boolean) => void
}

export type VoiceSessionMarkersProps =
  PropsRuntime<'shell.overlay'> & InjectFace<VoiceSessionMarkersInjected>

/**
 * The workspace package currently owns the session-row renderer and filters
 * subagent children from its top-level list. This decorator adds the voice
 * marker and a small parent-owned child tree without taking over host row
 * selection, menu, archive, or drag behaviour.
 */
export function VoiceSessionMarkers({ useSessions, useVoiceHistory, openSession, refreshSubagents, setSubagentCatalogOpen }: VoiceSessionMarkersProps) {
  const sessions = useSessions(state => state)
  const history = useVoiceHistory(state => state.entries)
  const expandedParents = useRef(new Set<SessionId>())
  const requestedParents = useRef(new Set<SessionId>())

  useEffect(() => {
    const voiceTitles = new Set<SessionId>(history.map(entry => entry.sessionId))
    const sessionIds = new Set(Object.keys(sessions.byId))
    for (const parentId of voiceTitles) {
      if (!requestedParents.current.has(parentId)) {
        requestedParents.current.add(parentId)
        refreshSubagents(parentId)
      }
    }

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
          row.querySelector('[data-voice-subagent-toggle]')?.remove()
          removeSubagentList(row, sessionId as SessionId | undefined)
          continue
        }
        const target = slot ?? createMarkerSlot(row)
        if (marker === null) target.append(createMarker())
        const parentId = sessionId as SessionId
        const catalog = sessions.subagentsByParent[parentId]
        // The host's catalog can remain pending while its header already
        // knows that children exist. Keep the disclosure affordance mounted
        // for every Voice parent so a pending/error catalog is still
        // reachable and retryable.
        const hasChildren = true
        if (!hasChildren) {
          row.querySelector('[data-voice-subagent-toggle]')?.remove()
          removeSubagentList(row, parentId)
          continue
        }
        const expanded = expandedParents.current.has(parentId)
        const toggle = row.querySelector<HTMLButtonElement>('[data-voice-subagent-toggle]') ?? createSubagentToggle(parentId, expanded, () => {
          const next = !expandedParents.current.has(parentId)
          if (next) expandedParents.current.add(parentId)
          else expandedParents.current.delete(parentId)
          setSubagentCatalogOpen(parentId, next)
          if (next) refreshSubagents(parentId)
          decorate()
        })
        updateSubagentToggle(toggle, parentId, expanded, () => {
          const next = !expandedParents.current.has(parentId)
          if (next) expandedParents.current.add(parentId)
          else expandedParents.current.delete(parentId)
          setSubagentCatalogOpen(parentId, next)
          if (next) refreshSubagents(parentId)
          decorate()
        })
        const title = row.querySelector<HTMLElement>('[class*="title"]')
        if (toggle.parentElement !== row) row.insertBefore(toggle, title ?? null)
        renderSubagentChildren(row, parentId, catalog?.entries ?? [], expanded, sessions.current, openSession)
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
      document.querySelectorAll('[data-voice-subagent-toggle], [data-voice-subagent-list]').forEach(node => { node.remove() })
    }
  }, [history, sessions, openSession, refreshSubagents, setSubagentCatalogOpen])

  return null
}

function createSubagentToggle(parentId: SessionId, expanded: boolean, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.dataset.voiceSubagentToggle = ''
  button.className = css.toggle ?? 'voice-subagent-toggle'
  updateSubagentToggle(button, parentId, expanded, onClick)
  button.onclick = event => {
    event.stopPropagation()
    onClick()
  }
  button.dataset.parentSessionId = parentId
  return button
}

function updateSubagentToggle(button: HTMLButtonElement, parentId: SessionId, expanded: boolean, onClick: () => void): void {
  button.dataset.parentSessionId = parentId
  const label = expanded ? '收起语音子会话' : '展开语音子会话'
  if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label)
  const expandedValue = String(expanded)
  if (button.getAttribute('aria-expanded') !== expandedValue) button.setAttribute('aria-expanded', expandedValue)
  if (button.title !== label) button.title = label
  const icon = expanded ? '⌄' : '›'
  if (button.textContent !== icon) button.innerHTML = `<span aria-hidden="true">${icon}</span>`
  button.onclick = event => {
    event.stopPropagation()
    onClick()
  }
}

function renderSubagentChildren(
  row: HTMLElement,
  parentId: SessionId,
  entries: readonly { readonly kind: string; readonly id: SessionId; readonly label?: string; readonly activity?: string }[],
  expanded: boolean,
  current: SessionId | undefined,
  openSession: (id: SessionId) => void,
): void {
  let list = findSubagentList(row, parentId)
  if (!expanded) {
    list?.remove()
    return
  }
  if (list === null || list === undefined) {
    list = document.createElement('div')
    list.dataset.voiceSubagentList = String(parentId)
    list.className = css.children ?? 'voice-subagent-children'
    row.parentElement?.insertBefore(list, row.nextSibling)
  }
  // Keep broken/stale catalog rows visible as diagnostics instead of making
  // an expanded parent look empty. Only healthy child entries are navigable.
  const children = entries.filter(entry => entry.kind !== 'parent')
  const signature = children.map(entry => `${entry.id}:${entry.label ?? ''}:${entry.activity ?? ''}`).join('|')
  if (list.dataset.signature === signature && list.dataset.current === String(current ?? '')) return
  list.dataset.signature = signature
  list.dataset.current = String(current ?? '')
  list.replaceChildren(...children.map(entry => {
    const child = document.createElement('button')
    child.type = 'button'
    child.className = css.child ?? 'voice-subagent-child'
    child.dataset.voiceSubagentChild = ''
    child.dataset.sessionId = String(entry.id)
    child.disabled = entry.kind !== 'child'
    if (entry.kind !== 'child') child.dataset.state = 'unavailable'
    child.setAttribute('role', 'treeitem')
    child.setAttribute('aria-current', entry.id === current ? 'page' : 'false')
    const unavailableLabel = entry.kind === 'diagnostic'
      ? '会话记录损坏'
      : '子会话暂时不可用'
    const displayLabel = entry.label ?? (entry.kind === 'child' ? String(entry.id) : unavailableLabel)
    child.title = displayLabel
    const dot = document.createElement('span')
    dot.className = css.childDot ?? 'voice-subagent-child-dot'
    dot.dataset.activity = entry.activity ?? 'inactive'
    const label = document.createElement('span')
    label.className = css.childLabel ?? 'voice-subagent-child-label'
    label.textContent = displayLabel
    child.append(dot, label)
    child.addEventListener('click', event => {
      event.stopPropagation()
      if (entry.kind !== 'child') return
      openSession(entry.id)
    })
    return child
  }))
}

function findSubagentList(row: HTMLElement, parentId: SessionId): HTMLElement | undefined {
  return [...(row.parentElement?.querySelectorAll<HTMLElement>('[data-voice-subagent-list]') ?? [])]
    .find(candidate => candidate.dataset.voiceSubagentList === String(parentId))
}

function removeSubagentList(row: HTMLElement, parentId: SessionId | undefined): void {
  if (parentId === undefined) return
  findSubagentList(row, parentId)?.remove()
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
