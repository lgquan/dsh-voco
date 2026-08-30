import { useEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button, IconBranchOutline16, IconEditOutline16, IconEllipsisOutline16,
  IconTrashOutline16, Menu, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { VoiceHistorySnapshot } from './voice-history.ts'
import { isSessionEffectivelyArchived } from './session-archive.ts'
import css from './VoiceSessionMarkers.module.css'

/** Root overlay that annotates the host-owned session rows with Voice markers. */
export interface VoiceSessionMarkersInjected {
  hooks: {
    voiceHistory: { getSnapshot(): VoiceHistorySnapshot; subscribe(listener: () => void): () => void }
  }
  openSession: (id: SessionId) => void
  childActions?: {
    rename?: (id: SessionId, title: string) => Promise<void>
    fork?: (id: SessionId) => Promise<void>
    /** Optional archive-manager capability; absent when that plugin is not installed. */
    delete?: (id: SessionId, title: string) => Promise<void>
  }
  refreshSubagents: (parentSessionId: SessionId) => void
  setSubagentCatalogOpen: (parentSessionId: SessionId, open: boolean) => void
}

export type VoiceSessionMarkersProps =
  PropsRuntime<'shell.overlay'> & InjectFace<VoiceSessionMarkersInjected>

/**
 * The workspace package currently owns the session-row renderer and filters
 * subagent children from its top-level list. This decorator adds the voice
 * marker and a small parent-owned child tree. Child actions are forwarded to
 * the same runtime/registry operations used by the Host row menu.
 */
export function VoiceSessionMarkers({ useSessions, useWorkspaces, useVoiceHistory, openSession, childActions, refreshSubagents, setSubagentCatalogOpen }: VoiceSessionMarkersProps) {
  const sessions = useSessions(state => state)
  const archivedSessionIds = useWorkspaces(state => state.archivedSessionIds)
  const history = useVoiceHistory(state => state)
  const expandedParents = useRef(new Set<SessionId>())
  const requestedParents = useRef(new Set<SessionId>())

  useEffect(() => {
    const voiceTitles = new Set<SessionId>(history.entries.map(entry => entry.sessionId))
    // A session list can outlive the local parent index (for example after a
    // profile reload). Delegation cards persist the child -> Voice parent
    // association, which is enough to recover the parent's disclosure row.
    for (const entry of history.taskActivity ?? []) {
      if (entry.parentSessionId !== undefined) voiceTitles.add(entry.parentSessionId)
    }
    const taskActivity = new Map((history.taskActivity ?? []).map(entry => [entry.sessionId, entry.lastActiveAt]))
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
        renderSubagentChildren(row, parentId, catalog?.entries ?? [], expanded, sessions.current, sessions.byId, new Set(archivedSessionIds), taskActivity, openSession, childActions)
      }
    }
    const schedule = (): void => {
      if (frame !== 0) return
      frame = requestAnimationFrame(decorate)
    }
    decorate()
    const clock = window.setInterval(schedule, 60_000)
    const observer = new MutationObserver(schedule)
    const suppressChildHover = (event: Event): void => {
      const target = event.target
      if (!(target instanceof Element)) return
      const child = target.closest<HTMLElement>('[data-voice-subagent-child]')
      if (child === null) return
      event.stopPropagation()
      suppressHostHover(child)
    }
    // The Host HoverCard listens high in the tree. Capture-phase suppression
    // is needed because stopping a child bubble event is already too late for
    // a delegated host listener.
    document.addEventListener('pointerover', suppressChildHover, true)
    document.addEventListener('mouseover', suppressChildHover, true)
    document.addEventListener('pointerenter', suppressChildHover, true)
    document.addEventListener('mouseenter', suppressChildHover, true)
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      document.removeEventListener('pointerover', suppressChildHover, true)
      document.removeEventListener('mouseover', suppressChildHover, true)
      document.removeEventListener('pointerenter', suppressChildHover, true)
      document.removeEventListener('mouseenter', suppressChildHover, true)
      window.clearInterval(clock)
      if (frame !== 0) cancelAnimationFrame(frame)
      document.querySelectorAll('[data-voice-session-marker]').forEach(node => { node.remove() })
      document.querySelectorAll('[data-voice-session-marker-slot]').forEach(node => { node.remove() })
      document.querySelectorAll<HTMLElement>('[data-voice-subagent-list]').forEach(node => {
        unmountChildMenus(node)
        node.remove()
      })
      document.querySelectorAll('[data-voice-subagent-toggle]').forEach(node => { node.remove() })
    }
  }, [history, sessions, archivedSessionIds, openSession, childActions, refreshSubagents, setSubagentCatalogOpen])

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
  entries: readonly { readonly kind: string; readonly id: SessionId; readonly label?: string; readonly activity?: string; readonly updatedAt?: number }[],
  expanded: boolean,
  current: SessionId | undefined,
  summaries: Readonly<Record<SessionId, { readonly updatedAt?: number; readonly parentId?: SessionId }>>,
  archivedSessionIds: ReadonlySet<SessionId>,
  taskActivity: ReadonlyMap<SessionId, number>,
  openSession: (id: SessionId) => void,
  childActions?: VoiceSessionMarkersInjected['childActions'],
): void {
  let list = findSubagentList(row, parentId)
  if (!expanded) {
    if (list !== undefined && list !== null) unmountChildMenus(list)
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
  const children = entries.filter(entry => entry.kind !== 'parent' && !isSessionEffectivelyArchived(
    entry.id,
    archivedSessionIds,
    summaries,
    id => id === entry.id ? parentId : undefined,
  ))
  const signature = children.map(entry => `${entry.id}:${entry.label ?? ''}:${entry.activity ?? ''}:${childUpdatedAt(entry.id, entry, summaries, taskActivity) ?? ''}`).join('|')
  if (list.dataset.signature === signature && list.dataset.current === String(current ?? '')) return
  list.dataset.signature = signature
  list.dataset.current = String(current ?? '')
  unmountChildMenus(list)
  list.replaceChildren(...children.map(entry => {
    const child = document.createElement('div')
    child.className = css.child ?? 'voice-subagent-child'
    child.dataset.voiceSubagentChild = ''
    child.dataset.sessionId = String(entry.id)
    ;(child as HTMLElement & { disabled?: boolean }).disabled = entry.kind !== 'child'
    if (entry.kind !== 'child') child.dataset.state = 'unavailable'
    child.setAttribute('role', 'treeitem')
    child.tabIndex = entry.kind === 'child' ? 0 : -1
    child.setAttribute('aria-current', entry.id === current ? 'page' : 'false')
    const unavailableLabel = entry.kind === 'diagnostic'
      ? '会话记录损坏'
      : '子会话暂时不可用'
    const displayLabel = entry.label ?? (entry.kind === 'child' ? String(entry.id) : unavailableLabel)
    child.addEventListener('mouseenter', event => suppressHostHover(child, event), true)
    child.addEventListener('mouseover', event => suppressHostHover(child, event), true)
    child.addEventListener('pointerenter', event => suppressHostHover(child, event), true)
    child.addEventListener('click', event => {
      if (event.target !== child || entry.kind !== 'child') return
      openSession(entry.id)
    })
    const dot = document.createElement('span')
    dot.className = css.childDot ?? 'voice-subagent-child-dot'
    dot.dataset.activity = entry.activity ?? 'inactive'
    const label = document.createElement('span')
    label.className = css.childLabel ?? 'voice-subagent-child-label'
    label.textContent = displayLabel
    const open = document.createElement('button')
    open.type = 'button'
    open.className = css.childMain ?? 'voice-subagent-child-main'
    open.disabled = entry.kind !== 'child'
    open.append(dot, label)
    child.append(open)
    const updatedAt = childUpdatedAt(entry.id, entry, summaries, taskActivity)
    if (updatedAt !== undefined) {
      const time = document.createElement('span')
      time.className = css.childTime ?? 'voice-subagent-child-time'
      time.dataset.voiceSubagentChildTime = ''
      time.dataset.updatedAt = String(updatedAt)
      time.textContent = relativeTimeLabel(updatedAt, Date.now())
      open.append(time)
    }
    open.addEventListener('click', event => {
      event.stopPropagation()
      if (entry.kind !== 'child') return
      openSession(entry.id)
    })
    if (entry.kind === 'child') mountChildMenu(child, entry.id, displayLabel, childActions)
    return child
  }))
}

function suppressHostHover(child: HTMLElement, event?: Event): void {
  event?.stopPropagation()
  child.dataset.voiceChildHover = 'true'
  const list = child.closest<HTMLElement>('[data-voice-subagent-list]')
  const parentRow = list?.previousElementSibling
  if (!(parentRow instanceof HTMLElement)) return
  // HoverCard is controlled by the parent SessionNodeItem. A synthetic leave
  // clears that state when the pointer moves into our sibling child row.
  const outside = document.body
  if (typeof PointerEvent === 'function') {
    parentRow.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false, relatedTarget: outside }))
    parentRow.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: outside }))
  }
  parentRow.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false, relatedTarget: outside }))
  parentRow.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: outside }))
}

const childMenuRoots = new WeakMap<HTMLElement, Root>()

function mountChildMenu(
  child: HTMLElement,
  id: SessionId,
  title: string,
  actions: VoiceSessionMarkersInjected['childActions'],
): void {
  const wrapper = document.createElement('span')
  wrapper.className = css.childActions ?? 'voice-subagent-child-actions'
  wrapper.dataset.voiceChildMenuRoot = ''
  child.append(wrapper)
  const root = createRoot(wrapper)
  childMenuRoots.set(wrapper, root)
  root.render(<OfficialChildMenu id={id} title={title} actions={actions} onOpenChange={open => {
    child.dataset.menuOpen = String(open)
  }} />)
}

function unmountChildMenus(list: HTMLElement): void {
  list.querySelectorAll<HTMLElement>('[data-voice-child-menu-root]').forEach(root => {
    childMenuRoots.get(root)?.unmount()
    childMenuRoots.delete(root)
  })
}

function OfficialChildMenu({ id, title, actions, onOpenChange }: {
  id: SessionId
  title: string
  actions: VoiceSessionMarkersInjected['childActions']
  onOpenChange: (open: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const items = [
    { id: 'rename', label: '重命名', icon: <IconEditOutline16 /> },
    { id: 'fork', label: '分叉会话', icon: <IconBranchOutline16 /> },
    ...actions?.delete === undefined ? [] : [{
      id: 'delete', label: '删除会话', icon: <IconTrashOutline16 />, danger: true,
    }],
  ]
  const setMenuOpen = (next: boolean): void => {
    setOpen(next)
    onOpenChange(next)
  }
  const closeDelete = (): void => {
    if (deleting) return
    setDeleteOpen(false)
    setDeleteError(null)
  }
  const confirmDelete = (): void => {
    if (deleting || actions?.delete === undefined) return
    setDeleting(true)
    setDeleteError(null)
    void actions.delete(id, title).then(() => {
      setDeleting(false)
      setDeleteOpen(false)
    }, cause => {
      setDeleting(false)
      setDeleteError(cause instanceof Error ? cause.message : String(cause))
    })
  }
  return <>
    <Menu
      open={open}
      onClose={() => { setMenuOpen(false) }}
      items={items}
      onSelect={selected => {
        setMenuOpen(false)
        setActionError(null)
        if (selected === 'delete') {
          setDeleteError(null)
          setDeleteOpen(true)
          return
        }
        const run = selected === 'rename'
          ? (() => {
            if (actions?.rename === undefined) return undefined
            const next = window.prompt('重命名会话', title)
            return next === null ? undefined : actions.rename(id, next)
          })()
          : actions?.fork?.(id)
        void run?.catch(error => {
          console.warn('voice child action failed:', error)
          setActionError(error instanceof Error ? error.message : String(error))
        })
      }}
      portal
      closeOnPointerLeave
      anchor={<button
        type="button"
        className={css.childMenuButton ?? 'voice-subagent-child-menu-button'}
        aria-label={`会话“${title}”的操作`}
        onClick={event => { event.stopPropagation(); setMenuOpen(!open) }}
      ><IconEllipsisOutline16 /></button>}
    />
    <Modal
      open={deleteOpen}
      onClose={closeDelete}
      closeLabel="关闭"
      title="删除会话"
      description={`将永久删除会话“${title}”及其子代理（含正在运行的）和全部记录（对话内容、统计、缓存），此操作不可恢复。`}
      footer={<>
        <Button variant="outline" disabled={deleting} onClick={closeDelete}>取消</Button>
        <Button
          variant="outline"
          className={css.deleteAction ?? 'voice-subagent-delete-action'}
          disabled={deleting}
          onClick={confirmDelete}
        >删除会话</Button>
      </>}
    >
      {deleting && <div className={css.deleteStatus} role="status">正在删除会话…</div>}
      {deleteError !== null && <div className={css.deleteError} role="alert">删除会话失败：{deleteError}</div>}
    </Modal>
    <Modal
      open={actionError !== null}
      onClose={() => { setActionError(null) }}
      closeLabel="关闭"
      title="会话操作失败"
      description={actionError ?? ''}
      footer={<Button variant="outline" onClick={() => { setActionError(null) }}>关闭</Button>}
    />
  </>
}

function childUpdatedAt(
  id: SessionId,
  entry: { readonly updatedAt?: number },
  summaries: Readonly<Record<SessionId, { readonly updatedAt?: number }>>,
  taskActivity: ReadonlyMap<SessionId, number>,
): number | undefined {
  if (typeof entry.updatedAt === 'number' && entry.updatedAt > 0) return entry.updatedAt
  const summaryTime = summaries[id]?.updatedAt
  if (typeof summaryTime === 'number' && summaryTime > 0) return summaryTime
  const taskTime = taskActivity.get(id)
  return typeof taskTime === 'number' && taskTime > 0 ? taskTime : undefined
}

/** Match the Host workspace's compact relative-time buckets for child rows. */
export function relativeTimeLabel(updatedAt: number, now: number, language = typeof navigator !== 'undefined' ? navigator.language : 'en-US'): string {
  const diff = Math.max(0, now - updatedAt)
  const minute = 60_000
  const hour = 3_600_000
  const day = 86_400_000
  const chinese = language.toLowerCase().startsWith('zh')
  if (diff < minute) return chinese ? '刚刚' : 'now'
  if (diff < hour) {
    const n = Math.floor(diff / minute)
    return chinese ? `${n}分钟` : `${n}min`
  }
  if (diff < day) {
    const n = Math.floor(diff / hour)
    return chinese ? `${n}小时` : `${n}h`
  }
  if (diff < 30 * day) {
    const n = Math.floor(diff / day)
    return chinese ? `${n}天` : `${n}d`
  }
  if (diff < 365 * day) {
    const n = Math.floor(diff / (30 * day))
    return chinese ? `${n}个月` : `${n}mo`
  }
  const n = Math.floor(diff / (365 * day))
  return chinese ? `${n}年` : `${n}y`
}

function findSubagentList(row: HTMLElement, parentId: SessionId): HTMLElement | undefined {
  return [...(row.parentElement?.querySelectorAll<HTMLElement>('[data-voice-subagent-list]') ?? [])]
    .find(candidate => candidate.dataset.voiceSubagentList === String(parentId))
}

function removeSubagentList(row: HTMLElement, parentId: SessionId | undefined): void {
  if (parentId === undefined) return
  const list = findSubagentList(row, parentId)
  if (list === undefined) return
  unmountChildMenus(list)
  list.remove()
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
