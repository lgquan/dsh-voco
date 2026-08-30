import {
  createSnapshotStore, type SessionId, type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'

const STORAGE_KEY = 'dsh.voice.history.v1'

/** One locally indexed durable Voice Session. */
export interface VoiceHistoryEntry {
  readonly sessionId: SessionId
  readonly lastActiveAt: number
}

/** Latest durable activity observed for one delegated child session. */
export interface VoiceTaskActivityEntry {
  readonly sessionId: SessionId
  readonly lastActiveAt: number
}

/** Browser-persistent Voice Session index. */
export interface VoiceHistorySnapshot {
  readonly entries: readonly VoiceHistoryEntry[]
  readonly taskActivity?: readonly VoiceTaskActivityEntry[]
}

interface StoredVoiceHistory {
  readonly version: 1
  readonly entries: readonly VoiceHistoryEntry[]
  readonly taskActivity?: readonly VoiceTaskActivityEntry[]
}

function parseEntry(input: unknown): VoiceHistoryEntry | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const value = input as Record<string, unknown>
  if (typeof value.sessionId !== 'string' || value.sessionId === '') return undefined
  if (typeof value.lastActiveAt !== 'number' || !Number.isFinite(value.lastActiveAt) || value.lastActiveAt < 0) {
    return undefined
  }
  return { sessionId: value.sessionId as SessionId, lastActiveAt: value.lastActiveAt }
}

function readHistory(storage: Storage | undefined): VoiceHistorySnapshot {
  if (storage === undefined) return { entries: [], taskActivity: [] }
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (raw === null) return { entries: [], taskActivity: [] }
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) return { entries: [], taskActivity: [] }
    const value = parsed as Record<string, unknown>
    if (value.version !== 1 || !Array.isArray(value.entries)) return { entries: [], taskActivity: [] }
    const entries: VoiceHistoryEntry[] = []
    const seen = new Set<SessionId>()
    for (const candidate of value.entries) {
      const entry = parseEntry(candidate)
      if (entry === undefined || seen.has(entry.sessionId)) continue
      seen.add(entry.sessionId)
      entries.push(entry)
    }
    entries.sort((left, right) => right.lastActiveAt - left.lastActiveAt)
    const taskActivity: VoiceTaskActivityEntry[] = []
    const taskSeen = new Set<SessionId>()
    if (Array.isArray(value.taskActivity)) {
      for (const candidate of value.taskActivity) {
        if (typeof candidate !== 'object' || candidate === null) continue
        const item = candidate as Record<string, unknown>
        if (typeof item.sessionId !== 'string' || item.sessionId === ''
          || typeof item.lastActiveAt !== 'number' || !Number.isFinite(item.lastActiveAt)
          || item.lastActiveAt < 0) continue
        const sessionId = item.sessionId as SessionId
        if (taskSeen.has(sessionId)) continue
        taskSeen.add(sessionId)
        taskActivity.push({ sessionId, lastActiveAt: item.lastActiveAt })
      }
      taskActivity.sort((left, right) => right.lastActiveAt - left.lastActiveAt)
    }
    return { entries, taskActivity }
  } catch (error: unknown) {
    console.error('voice history rehydration failed:', error)
    return { entries: [], taskActivity: [] }
  }
}

/** Own the local history index without adding Voice metadata to Host session projections. */
export class VoiceHistoryStore {
  readonly snapshot: SnapshotStore<VoiceHistorySnapshot>
  private readonly storage: Storage | undefined
  private readonly unsubscribe: () => void

  constructor(storage: Storage | undefined = typeof localStorage === 'undefined' ? undefined : localStorage) {
    this.storage = storage
    this.snapshot = createSnapshotStore(readHistory(storage))
    this.unsubscribe = this.snapshot.subscribe(() => { this.persist() })
  }

  /** Move one successfully opened Voice Session to the front of the index. */
  record(sessionId: SessionId, lastActiveAt = Date.now()): void {
    this.snapshot.set({
      entries: [
        { sessionId, lastActiveAt },
        ...this.snapshot.getSnapshot().entries.filter(entry => entry.sessionId !== sessionId),
      ],
    })
  }

  /** Retain the latest timestamp seen in a delegated task's durable events. */
  recordTaskActivity(sessionId: SessionId, lastActiveAt: number): void {
    if (!Number.isFinite(lastActiveAt) || lastActiveAt < 0) return
    const entries = this.snapshot.getSnapshot().taskActivity ?? []
    const previous = entries.find(entry => entry.sessionId === sessionId)?.lastActiveAt ?? 0
    const nextTime = Math.max(previous, lastActiveAt)
    if (nextTime === previous) return
    const next = [
      { sessionId, lastActiveAt: nextTime },
      ...entries.filter(entry => entry.sessionId !== sessionId),
    ]
    this.snapshot.set({ ...this.snapshot.getSnapshot(), taskActivity: next })
  }

  /** Stop persistence notifications. */
  dispose(): void {
    this.unsubscribe()
  }

  private persist(): void {
    if (this.storage === undefined) return
    const snapshot = this.snapshot.getSnapshot()
    const value: StoredVoiceHistory = {
      version: 1,
      entries: snapshot.entries,
      ...(snapshot.taskActivity === undefined ? {} : { taskActivity: snapshot.taskActivity }),
    }
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(value))
    } catch (error: unknown) {
      console.error('voice history persistence failed:', error)
    }
  }
}
