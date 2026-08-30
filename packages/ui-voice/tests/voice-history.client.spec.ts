// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { VoiceHistoryStore } from '../src/client/voice-history.ts'

afterEach(() => {
  if (typeof localStorage !== 'undefined') localStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('VoiceHistoryStore', () => {
  it('rehydrates validated unique entries and persists newest-first updates', () => {
    localStorage.setItem('dsh.voice.history.v1', JSON.stringify({
      version: 1,
      entries: [
        { sessionId: 'older', lastActiveAt: 1 },
        { sessionId: 'newer', lastActiveAt: 3 },
        { sessionId: 'older', lastActiveAt: 2 },
        { sessionId: '', lastActiveAt: 4 },
        { sessionId: 'bad-time', lastActiveAt: -1 },
        null,
      ],
    }))
    const history = new VoiceHistoryStore()
    expect(history.snapshot.getSnapshot().entries.map(entry => entry.sessionId)).toEqual(['newer', 'older'])
    history.record('older' as SessionId, 5)
    expect(history.snapshot.getSnapshot().entries).toEqual([
      { sessionId: 'older', lastActiveAt: 5 },
      { sessionId: 'newer', lastActiveAt: 3 },
    ])
    expect(JSON.parse(localStorage.getItem('dsh.voice.history.v1') ?? '{}')).toEqual({
      version: 1,
      entries: [
        { sessionId: 'older', lastActiveAt: 5 },
        { sessionId: 'newer', lastActiveAt: 3 },
      ],
    })
    history.dispose()
  })

  it('starts empty for absent, incompatible, and unreadable storage', () => {
    vi.stubGlobal('localStorage', undefined)
    const absent = new VoiceHistoryStore()
    absent.record('memory-only' as SessionId, 1)
    expect(absent.snapshot.getSnapshot().entries).toHaveLength(1)
    absent.dispose()
    vi.unstubAllGlobals()

    localStorage.setItem('dsh.voice.history.v1', JSON.stringify({ version: 2, entries: [] }))
    const incompatible = new VoiceHistoryStore()
    expect(incompatible.snapshot.getSnapshot().entries).toEqual([])
    incompatible.dispose()

    localStorage.setItem('dsh.voice.history.v1', '1')
    const primitive = new VoiceHistoryStore()
    expect(primitive.snapshot.getSnapshot().entries).toEqual([])
    primitive.dispose()

    localStorage.setItem('dsh.voice.history.v1', JSON.stringify({ version: 1, entries: 'invalid' }))
    const invalidEntries = new VoiceHistoryStore()
    expect(invalidEntries.snapshot.getSnapshot().entries).toEqual([])
    invalidEntries.dispose()

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const broken = {
      getItem: vi.fn(() => { throw new Error('read failed') }),
      setItem: vi.fn(() => { throw new Error('write failed') }),
    } as unknown as Storage
    const unreadable = new VoiceHistoryStore(broken)
    unreadable.record('session' as SessionId, 1)
    expect(consoleError).toHaveBeenCalledTimes(2)
    unreadable.dispose()
  })

  it('persists delegated child ownership and can fill it without a newer timestamp', () => {
    localStorage.setItem('dsh.voice.history.v1', JSON.stringify({
      version: 1,
      entries: [],
      taskActivity: [{ sessionId: 'child', lastActiveAt: 10 }],
    }))
    const history = new VoiceHistoryStore()
    history.recordTaskActivity('child' as SessionId, 10, 'voice-parent' as SessionId)
    expect(history.snapshot.getSnapshot().taskActivity).toEqual([{
      sessionId: 'child', lastActiveAt: 10, parentSessionId: 'voice-parent',
    }])
    expect(JSON.parse(localStorage.getItem('dsh.voice.history.v1') ?? '{}').taskActivity).toEqual([{
      sessionId: 'child', lastActiveAt: 10, parentSessionId: 'voice-parent',
    }])
    history.dispose()
  })
})
