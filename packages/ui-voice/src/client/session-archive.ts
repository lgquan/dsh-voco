import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'

/** Minimal session shape needed to walk the Host-owned parent chain. */
export interface SessionArchiveSummary {
  readonly parentId?: SessionId
}

/**
 * Returns whether a session is archived itself or inherits archive state from
 * any known ancestor. The optional fallback resolves a parent when the
 * summary is not present yet (for example while a subagent route is loading).
 * Cycles terminate the walk without throwing in render paths.
 */
export function isSessionEffectivelyArchived(
  sessionId: SessionId,
  archivedSessionIds: ReadonlySet<SessionId> | readonly SessionId[],
  summaries: Readonly<Record<SessionId, unknown>>,
  fallbackParent?: (id: SessionId) => SessionId | undefined,
): boolean {
  const archived = archivedSessionIds instanceof Set
    ? archivedSessionIds
    : new Set(archivedSessionIds)
  const visited = new Set<SessionId>()
  let current: SessionId | undefined = sessionId
  while (current !== undefined && !visited.has(current)) {
    if (archived.has(current)) return true
    visited.add(current)
    const summary: unknown = summaries[current]
    const parentId: SessionId | undefined = summary !== null && typeof summary === 'object' && 'parentId' in summary
      ? (summary as SessionArchiveSummary).parentId
      : undefined
    current = parentId ?? fallbackParent?.(current)
  }
  return false
}
