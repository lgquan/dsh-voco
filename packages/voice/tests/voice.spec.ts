import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import VoiceRuntime, {
  VoiceCommandCallId,
  VoiceSessionId,
  VoiceTaskId,
  VoiceTaskMessageId,
  VoiceUtteranceId,
  type TaskObservation,
  type VoiceProviderSession,
} from '@flowingspring/dsh-voice'
import { describe, expect, it, vi } from 'vitest'

interface FakeProviderSession {
  session: VoiceProviderSession
  spies: {
    appendAudio: ReturnType<typeof vi.fn>
    beginManualUtterance: ReturnType<typeof vi.fn>
    commitAudio: ReturnType<typeof vi.fn>
    interruptResponse: ReturnType<typeof vi.fn>
    playbackEnded: ReturnType<typeof vi.fn>
    appendTaskObservation: ReturnType<typeof vi.fn>
    requestResponse: ReturnType<typeof vi.fn>
    completeTaskCommand: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
  }
}

function providerSession(): FakeProviderSession {
  const spies = {
    appendAudio: vi.fn(),
    beginManualUtterance: vi.fn(),
    commitAudio: vi.fn(),
    interruptResponse: vi.fn(),
    playbackEnded: vi.fn(),
    appendTaskObservation: vi.fn(),
    requestResponse: vi.fn(),
    completeTaskCommand: vi.fn(),
    close: vi.fn(() => Promise.resolve()),
  }
  return { spies, session: {
    audio: { inputSampleRate: 16_000, outputSampleRate: 24_000, format: 'pcm_s16le' },
    interactionMode: 'frontend-agent',
    beginManualUtterance: spies.beginManualUtterance,
    appendAudio: spies.appendAudio,
    commitAudio: spies.commitAudio,
    interruptResponse: spies.interruptResponse,
    playbackEnded: spies.playbackEnded,
    appendTaskObservation: spies.appendTaskObservation,
    requestResponse: spies.requestResponse,
    completeTaskCommand: spies.completeTaskCommand,
    close: spies.close,
  } }
}

describe('voice runtime', () => {
  it('routes audio and the explicit observation/response pair through one provider session', async () => {
    const ctx = new Context()
    await ctx.plugin(VoiceRuntime, { provider: 'test' })
    const connected = providerSession()
    let emit: Parameters<Parameters<typeof ctx.voice.registerProvider>[0]['connect']>[0]['emit'] | undefined
    ctx.voice.registerProvider({
      id: 'test',
      available: () => true,
      connect: (input) => { emit = input.emit; return Promise.resolve(connected.session) },
    })
    const opened = await ctx.voice.open(SessionId('agent-1'))
    const events: unknown[] = []
    const unsubscribe = ctx.voice.subscribe(opened.id, (event) => { events.push(event) })
    const observation: TaskObservation = {
      taskId: VoiceTaskId('task-1'),
      status: 'running',
      voiceMessage: { id: VoiceTaskMessageId('m1'), text: 'done' },
    }

    ctx.voice.appendAudio(opened.id, new Uint8Array([1, 2]))
    ctx.voice.beginManualUtterance(opened.id)
    ctx.voice.commitAudio(opened.id)
    ctx.voice.interruptResponse(opened.id)
    ctx.voice.playbackEnded(opened.id)
    ctx.voice.appendTaskObservation(opened.id, observation)
    ctx.voice.requestResponse(opened.id, { kind: 'automatic' })
    emit?.({ type: 'transcription.completed', utteranceId: VoiceUtteranceId('utterance-1'), text: 'hello' })

    expect(connected.spies.appendAudio).toHaveBeenCalledWith(new Uint8Array([1, 2]))
    expect(connected.spies.beginManualUtterance).toHaveBeenCalledOnce()
    expect(connected.spies.commitAudio).toHaveBeenCalledOnce()
    expect(connected.spies.interruptResponse).toHaveBeenCalledOnce()
    expect(connected.spies.playbackEnded).toHaveBeenCalledOnce()
    expect(connected.spies.appendTaskObservation).toHaveBeenCalledWith(observation)
    expect(connected.spies.requestResponse).toHaveBeenCalledWith({ kind: 'automatic' })
    expect(events).toEqual([
      { type: 'task.observation', observation },
      { type: 'transcription.completed', utteranceId: VoiceUtteranceId('utterance-1'), text: 'hello' },
    ])
    unsubscribe()
    await ctx.voice.close(opened.id)
    expect(connected.spies.close).toHaveBeenCalledOnce()
  })

  it('fails selection instead of depending on provider registration order', async () => {
    const ctx = new Context()
    await ctx.plugin(VoiceRuntime)
    const connect = () => Promise.resolve(providerSession().session)
    ctx.voice.registerProvider({ id: 'one', available: () => true, connect })
    ctx.voice.registerProvider({ id: 'two', available: () => true, connect })
    await expect(ctx.voice.open(SessionId('agent-1'))).rejects.toThrow('multiple usable voice providers')
  })

  it('validates provider registration and every provider-selection failure', async () => {
    const missing = new Context()
    await missing.plugin(VoiceRuntime, { provider: 'missing' })
    await expect(missing.voice.open(SessionId('agent-1'))).rejects.toThrow('is not registered')

    const unavailable = new Context()
    await unavailable.plugin(VoiceRuntime, { provider: 'offline' })
    unavailable.voice.registerProvider({
      id: 'offline',
      available: () => false,
      connect: () => Promise.resolve(providerSession().session),
    })
    await expect(unavailable.voice.open(SessionId('agent-1'))).rejects.toThrow('is unavailable')

    const empty = new Context()
    await empty.plugin(VoiceRuntime)
    await expect(empty.voice.open(SessionId('agent-1'))).rejects.toThrow('no usable voice provider')

    const implicit = new Context()
    await implicit.plugin(VoiceRuntime)
    const connected = providerSession()
    const dispose = implicit.voice.registerProvider({
      id: 'sole',
      available: () => true,
      connect: () => Promise.resolve(connected.session),
    })
    expect(() => {
      implicit.voice.registerProvider({
        id: 'sole',
        available: () => true,
        connect: () => Promise.resolve(providerSession().session),
      })
    }).toThrow('already registered')
    const opened = await implicit.voice.open(SessionId('agent-1'))
    await implicit.voice.close(opened.id)
    dispose()
    await expect(implicit.voice.open(SessionId('agent-1'))).rejects.toThrow('no usable voice provider')
  })

  it('applies constructor defaults and disposes a successful provider session', async () => {
    const ctx = new Context()
    const runtime = new VoiceRuntime(ctx)
    const connected = providerSession()
    runtime.registerProvider({
      id: 'sole',
      available: () => true,
      connect: () => Promise.resolve(connected.session),
    })
    await runtime.open(SessionId('agent-defaults'))

    await ctx.fiber.dispose()
    expect(connected.spies.close).toHaveBeenCalledOnce()
  })

  it('drops provider events emitted before connect returns', async () => {
    const ctx = new Context()
    await ctx.plugin(VoiceRuntime, { provider: 'test' })
    const sessionEvents: unknown[] = []
    ctx.on('voice/session-event', (_session, event) => { sessionEvents.push(event) })
    ctx.voice.registerProvider({
      id: 'test',
      available: () => true,
      connect: (input) => {
        input.emit({
          type: 'transcription.completed',
          utteranceId: VoiceUtteranceId('too-early'),
          text: 'too early',
        })
        return Promise.resolve(providerSession().session)
      },
    })

    const opened = await ctx.voice.open(SessionId('agent-1'))
    expect(sessionEvents).toEqual([])
    await ctx.voice.close(opened.id)
  })

  it('contains subscriber failures and continues later event delivery', async () => {
    const ctx = new Context()
    await ctx.plugin(VoiceRuntime, { provider: 'test' })
    const connected = providerSession()
    let emit: Parameters<Parameters<typeof ctx.voice.registerProvider>[0]['connect']>[0]['emit'] | undefined
    ctx.voice.registerProvider({
      id: 'test',
      available: () => true,
      connect: (input) => { emit = input.emit; return Promise.resolve(connected.session) },
    })
    const opened = await ctx.voice.open(SessionId('agent-listeners'))
    const delivered: unknown[] = []
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    ctx.voice.subscribe(opened.id, () => { throw new Error('listener error') })
    ctx.voice.subscribe(opened.id, () => { throw 'listener value' })
    ctx.voice.subscribe(opened.id, (event) => { delivered.push(event) })

    emit?.({
      type: 'transcription.completed',
      utteranceId: VoiceUtteranceId('listener-event'),
      text: 'delivered',
    })

    expect(delivered).toEqual([{
      type: 'transcription.completed',
      utteranceId: VoiceUtteranceId('listener-event'),
      text: 'delivered',
    }])
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'listener error' }))
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'listener value' }))
    await ctx.voice.close(opened.id)
  })

  it('publishes closure before provider teardown and drops provider events from the closing session', async () => {
    const ctx = new Context()
    await ctx.plugin(VoiceRuntime, { provider: 'test' })
    const connected = providerSession()
    const providerClose = Promise.withResolvers<undefined>()
    connected.spies.close.mockReturnValue(providerClose.promise)
    let emit: Parameters<Parameters<typeof ctx.voice.registerProvider>[0]['connect']>[0]['emit'] | undefined
    ctx.voice.registerProvider({
      id: 'test',
      available: () => true,
      connect: (input) => { emit = input.emit; return Promise.resolve(connected.session) },
    })
    const opened = await ctx.voice.open(SessionId('agent-closing'))
    const lifecycle: string[] = []
    const events: unknown[] = []
    ctx.on('voice/session-closed', () => { lifecycle.push('closed') })
    ctx.voice.subscribe(opened.id, (event) => { events.push(event) })

    const closing = ctx.voice.close(opened.id)
    expect(lifecycle).toEqual(['closed'])
    expect(connected.spies.close).toHaveBeenCalledOnce()
    emit?.({ type: 'transcription.completed', utteranceId: VoiceUtteranceId('late'), text: 'late' })
    expect(events).toEqual([])
    expect(() => { ctx.voice.requestResponse(opened.id, { kind: 'automatic' }) }).toThrow('is not open')

    providerClose.resolve(undefined)
    await closing
  })

  it('reattaches a detached browser to the same provider conversation', async () => {
    const ctx = new Context()
    await ctx.plugin(VoiceRuntime, { provider: 'test', reconnectGraceMs: 1_000 })
    const connected = providerSession()
    let emit: Parameters<Parameters<typeof ctx.voice.registerProvider>[0]['connect']>[0]['emit'] | undefined
    const connect = vi.fn((input: Parameters<Parameters<typeof ctx.voice.registerProvider>[0]['connect']>[0]) => {
      emit = input.emit
      return Promise.resolve(connected.session)
    })
    ctx.voice.registerProvider({ id: 'test', available: () => true, connect })
    const lifecycle: string[] = []
    ctx.on('voice/session-opened', (session) => { lifecycle.push(`opened:${session.id}`) })
    ctx.on('voice/session-detached', (session) => { lifecycle.push(`detached:${session.id}`) })
    ctx.on('voice/session-closed', (session) => { lifecycle.push(`closed:${session.id}`) })

    const first = await ctx.voice.open(SessionId('agent-reconnect'))
    const firstEvents: unknown[] = []
    ctx.voice.subscribe(first.id, (event) => { firstEvents.push(event) })
    ctx.voice.detach(first.id)
    emit?.({ type: 'transcription.completed', utteranceId: VoiceUtteranceId('offline'), text: 'offline' })

    const second = await ctx.voice.open(SessionId('agent-reconnect'))
    const secondEvents: unknown[] = []
    ctx.voice.subscribe(second.id, (event) => { secondEvents.push(event) })
    emit?.({ type: 'transcription.completed', utteranceId: VoiceUtteranceId('online'), text: 'online' })

    expect(second).toEqual(first)
    expect(connect).toHaveBeenCalledOnce()
    expect(connected.spies.close).not.toHaveBeenCalled()
    expect(firstEvents).toEqual([])
    expect(secondEvents).toEqual([
      { type: 'transcription.completed', utteranceId: VoiceUtteranceId('online'), text: 'online' },
    ])
    expect(lifecycle).toEqual([
      `opened:${first.id}`,
      `detached:${first.id}`,
      `opened:${first.id}`,
    ])
    await ctx.voice.close(second.id)
  })

  it('restores memory only for fresh provider conversations and manages one memory source', async () => {
    const ctx = new Context()
    await ctx.plugin(VoiceRuntime, { provider: 'test', reconnectGraceMs: 1_000 })
    const sessions = [providerSession(), providerSession()]
    const connect = vi.fn((input: Parameters<Parameters<typeof ctx.voice.registerProvider>[0]['connect']>[0]) => (
      Promise.resolve(sessions[connect.mock.calls.length - 1]!.session)
    ))
    ctx.voice.registerProvider({ id: 'test', available: () => true, connect })
    const memory = {
      items: [
        { role: 'user' as const, text: '还记得之前的问题吗？' },
        { role: 'assistant' as const, text: '记得，我们继续。' },
      ],
    }
    const loadMemory = vi.fn(async (sessionId: SessionId) => {
      expect(sessionId).toBe(SessionId('agent-memory'))
      return memory
    })
    const disposeMemory = ctx.voice.registerMemorySource(loadMemory)
    expect(() => { ctx.voice.registerMemorySource(async () => undefined) }).toThrow('already registered')

    const first = await ctx.voice.open(SessionId('agent-memory'))
    ctx.voice.detach(first.id)
    const reattached = await ctx.voice.open(SessionId('agent-memory'))
    expect(reattached).toEqual(first)
    expect(loadMemory).toHaveBeenCalledOnce()
    expect(connect).toHaveBeenCalledOnce()

    await ctx.voice.close(reattached.id)
    const restarted = await ctx.voice.open(SessionId('agent-memory'))
    expect(loadMemory).toHaveBeenCalledTimes(2)
    expect(connect).toHaveBeenCalledTimes(2)
    expect(connect.mock.calls.map(([input]) => input.memory)).toEqual([memory, memory])

    disposeMemory()
    const disposeReplacement = ctx.voice.registerMemorySource(async () => undefined)
    disposeReplacement()
    await ctx.voice.close(restarted.id)
  })

  it('closes a detached provider after the configured reconnect grace', async () => {
    vi.useFakeTimers()
    try {
      const ctx = new Context()
      await ctx.plugin(VoiceRuntime, { provider: 'test', reconnectGraceMs: 25 })
      const connected = providerSession()
      ctx.voice.registerProvider({
        id: 'test',
        available: () => true,
        connect: () => Promise.resolve(connected.session),
      })
      const opened = await ctx.voice.open(SessionId('agent-expiry'))

      ctx.voice.detach(opened.id)
      expect(connected.spies.close).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(25)

      expect(connected.spies.close).toHaveBeenCalledOnce()
      expect(() => { ctx.voice.appendAudio(opened.id, new Uint8Array()) }).toThrow('is not open')
    } finally {
      vi.useRealTimers()
    }
  })

  it('handles idempotent detach and logs interruption and grace-close failures', async () => {
    vi.useFakeTimers()
    try {
      const ctx = new Context()
      await ctx.plugin(VoiceRuntime, { provider: 'test', reconnectGraceMs: 25 })
      const first = providerSession()
      first.spies.interruptResponse.mockImplementation(() => { throw new Error('interrupt error') })
      first.spies.close.mockRejectedValue(new Error('close error'))
      const second = providerSession()
      second.spies.interruptResponse.mockImplementation(() => { throw 'interrupt value' })
      second.spies.close.mockRejectedValue('close value')
      const sessions = [first.session, second.session]
      const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
      ctx.voice.registerProvider({
        id: 'test',
        available: () => true,
        connect: () => Promise.resolve(sessions.shift() as VoiceProviderSession),
      })
      const firstOpened = await ctx.voice.open(SessionId('agent-expiry-error-1'))
      const secondOpened = await ctx.voice.open(SessionId('agent-expiry-error-2'))

      ctx.voice.detach(VoiceSessionId('missing'))
      ctx.voice.detach(firstOpened.id)
      ctx.voice.detach(firstOpened.id)
      ctx.voice.detach(secondOpened.id)
      expect(() => { ctx.voice.requestResponse(firstOpened.id, { kind: 'automatic' }) }).toThrow('is detached')
      await vi.advanceTimersByTimeAsync(25)

      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'interrupt error' }))
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'interrupt value' }))
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'close error' }))
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'close value' }))
      await ctx.voice.close(firstOpened.id)
      await ctx.voice.close(secondOpened.id)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a detached grace timer on explicit final close', async () => {
    vi.useFakeTimers()
    try {
      const ctx = new Context()
      await ctx.plugin(VoiceRuntime, { provider: 'test', reconnectGraceMs: 25 })
      const connected = providerSession()
      ctx.voice.registerProvider({
        id: 'test',
        available: () => true,
        connect: () => Promise.resolve(connected.session),
      })
      const opened = await ctx.voice.open(SessionId('agent-explicit-close'))

      ctx.voice.detach(opened.id)
      await ctx.voice.close(opened.id)
      await ctx.voice.close(opened.id)
      await vi.advanceTimersByTimeAsync(25)

      expect(connected.spies.close).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('admits commands while detached and finalizes a provider-reported close', async () => {
    const ctx = new Context()
    await ctx.plugin(VoiceRuntime, { provider: 'test' })
    const connected = providerSession()
    connected.spies.close
      .mockRejectedValueOnce('provider close value')
      .mockRejectedValueOnce(new Error('provider close error'))
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    let emit: Parameters<Parameters<typeof ctx.voice.registerProvider>[0]['connect']>[0]['emit'] | undefined
    ctx.voice.registerProvider({
      id: 'test',
      available: () => true,
      connect: (input) => { emit = input.emit; return Promise.resolve(connected.session) },
    })
    const lifecycle: string[] = []
    const events: unknown[] = []
    ctx.on('voice/session-detached', () => { lifecycle.push('detached') })
    ctx.on('voice/session-closed', () => { lifecycle.push('closed') })
    ctx.on('voice/session-event', (_session, event) => { events.push(event) })
    const opened = await ctx.voice.open(SessionId('agent-detached-command'))
    const call = {
      id: VoiceCommandCallId('detached-call'),
      command: { type: 'realtime_delegation' as const, input: 'continue offline' },
    }

    ctx.voice.detach(opened.id)
    emit?.({ type: 'transcription.completed', utteranceId: VoiceUtteranceId('offline'), text: 'drop' })
    emit?.({ type: 'task.command', call })
    ctx.voice.completeTaskCommand(opened.id, call.id, {
      kind: 'accepted', taskId: VoiceTaskId('task-detached'),
    })
    emit?.({ type: 'closed', reason: 'provider ended' })

    expect(events).toEqual([
      { type: 'task.command', call },
      { type: 'closed', reason: 'provider ended' },
    ])
    expect(lifecycle).toEqual(['detached', 'closed'])
    expect(connected.spies.completeTaskCommand).toHaveBeenCalledWith(call.id, {
      kind: 'accepted', taskId: VoiceTaskId('task-detached'),
    })
    await vi.waitFor(() => { expect(connected.spies.close).toHaveBeenCalledOnce() })
    expect(() => { ctx.voice.playbackEnded(opened.id) }).toThrow('is not open')

    await ctx.voice.open(SessionId('agent-provider-close-error'))
    emit?.({ type: 'closed' })
    await vi.waitFor(() => {
      expect(connected.spies.close).toHaveBeenCalledTimes(2)
      expect(warn).toHaveBeenCalledTimes(2)
    })
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'provider close value' }))
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'provider close error' }))
  })

  it('admits a command once and replays its result for duplicate provider delivery', async () => {
    const ctx = new Context()
    await ctx.plugin(VoiceRuntime, { provider: 'test' })
    const connected = providerSession()
    let emit: Parameters<Parameters<typeof ctx.voice.registerProvider>[0]['connect']>[0]['emit'] | undefined
    ctx.voice.registerProvider({
      id: 'test',
      available: () => true,
      connect: (input) => { emit = input.emit; return Promise.resolve(connected.session) },
    })
    const opened = await ctx.voice.open(SessionId('agent-1'))
    const events: unknown[] = []
    ctx.voice.subscribe(opened.id, (event) => { events.push(event) })
    const call = {
      id: VoiceCommandCallId('call-1'),
      command: { type: 'realtime_delegation' as const, input: 'inspect the repository' },
    }

    emit?.({ type: 'task.command', call })
    emit?.({ type: 'task.command', call })
    expect(connected.spies.completeTaskCommand).not.toHaveBeenCalled()
    ctx.voice.completeTaskCommand(opened.id, call.id, { kind: 'accepted', taskId: VoiceTaskId('task-1') })
    emit?.({ type: 'task.command', call })

    expect(events).toEqual([{ type: 'task.command', call }])
    expect(connected.spies.completeTaskCommand).toHaveBeenCalledTimes(2)
    expect(connected.spies.completeTaskCommand).toHaveBeenLastCalledWith(call.id, {
      kind: 'accepted', taskId: VoiceTaskId('task-1'),
    })
    expect(() => {
      ctx.voice.completeTaskCommand(opened.id, call.id, {
        kind: 'accepted', taskId: VoiceTaskId('task-1'),
      })
    }).toThrow('already completed')
    expect(() => {
      ctx.voice.completeTaskCommand(opened.id, VoiceCommandCallId('missing'), {
        kind: 'rejected', code: 'invalid_command', message: 'missing',
      })
    }).toThrow('is not pending')
  })

  it('admits an attached browser task command through the same command boundary', async () => {
    const ctx = new Context()
    await ctx.plugin(VoiceRuntime, { provider: 'test' })
    const connected = providerSession()
    ctx.voice.registerProvider({
      id: 'test', available: () => true, connect: () => Promise.resolve(connected.session),
    })
    const opened = await ctx.voice.open(SessionId('browser-command-source'))
    const events: unknown[] = []
    ctx.voice.subscribe(opened.id, event => { events.push(event) })
    const call = {
      id: VoiceCommandCallId('browser-cancel'),
      command: { type: 'cancel_task' as const, taskId: VoiceTaskId('task-1') },
    }

    ctx.voice.submitTaskCommand(opened.id, call)
    expect(events).toEqual([{ type: 'task.command', call }])
  })

  it('projects browser-typed text as a transcript and routes it through the voice command boundary', async () => {
    const ctx = new Context()
    await ctx.plugin(VoiceRuntime, { provider: 'test' })
    const connected = providerSession()
    ctx.voice.registerProvider({
      id: 'test', available: () => true, connect: () => Promise.resolve(connected.session),
    })
    const opened = await ctx.voice.open(SessionId('typed-voice-source'))
    const events: unknown[] = []
    ctx.voice.subscribe(opened.id, event => { events.push(event) })

    ctx.voice.submitText(opened.id, '  手动输入也请语音回复  ')

    expect(connected.spies.interruptResponse).toHaveBeenCalledOnce()
    expect(events).toEqual([
      expect.objectContaining({ type: 'transcription.started' }),
      expect.objectContaining({ type: 'transcription.completed', text: '手动输入也请语音回复' }),
      expect.objectContaining({
        type: 'task.command',
        call: expect.objectContaining({
          command: { type: 'route_transcription', input: '手动输入也请语音回复' },
        }),
      }),
    ])
    expect(() => { ctx.voice.submitText(opened.id, '   ') }).toThrow('requires non-empty text')
  })

  it('rejects call-id reuse with changed arguments and fingerprints every command kind', async () => {
    const ctx = new Context()
    await ctx.plugin(VoiceRuntime, { provider: 'test' })
    const connected = providerSession()
    let emit: Parameters<Parameters<typeof ctx.voice.registerProvider>[0]['connect']>[0]['emit'] | undefined
    ctx.voice.registerProvider({
      id: 'test',
      available: () => true,
      connect: (input) => { emit = input.emit; return Promise.resolve(connected.session) },
    })
    const opened = await ctx.voice.open(SessionId('agent-command-kinds'))
    const events: unknown[] = []
    ctx.voice.subscribe(opened.id, (event) => { events.push(event) })
    const send = {
      id: VoiceCommandCallId('send'),
      command: {
        type: 'send_task_message' as const,
        taskId: VoiceTaskId('task-1'),
        message: 'continue',
      },
    }
    const cancel = {
      id: VoiceCommandCallId('cancel'),
      command: { type: 'cancel_task' as const, taskId: VoiceTaskId('task-1') },
    }

    emit?.({ type: 'task.command', call: send })
    emit?.({ type: 'task.command', call: cancel })
    emit?.({
      type: 'task.command',
      call: { ...send, command: { ...send.command, message: 'different' } },
    })

    expect(events).toEqual([
      { type: 'task.command', call: send },
      { type: 'task.command', call: cancel },
      { type: 'error', message: 'voice command call "send" was reused with different arguments' },
    ])
  })

  it('rejects admission when the bounded command history is full', async () => {
    const ctx = new Context()
    await ctx.plugin(VoiceRuntime, { provider: 'test', maxCommandCalls: 1 })
    const connected = providerSession()
    let emit: Parameters<Parameters<typeof ctx.voice.registerProvider>[0]['connect']>[0]['emit'] | undefined
    ctx.voice.registerProvider({
      id: 'test',
      available: () => true,
      connect: (input) => { emit = input.emit; return Promise.resolve(connected.session) },
    })
    const opened = await ctx.voice.open(SessionId('agent-1'))
    const events: unknown[] = []
    ctx.voice.subscribe(opened.id, (event) => { events.push(event) })
    const first = { id: VoiceCommandCallId('call-1'), command: { type: 'realtime_delegation' as const, input: 'one' } }
    const second = { id: VoiceCommandCallId('call-2'), command: { type: 'realtime_delegation' as const, input: 'two' } }

    emit?.({ type: 'task.command', call: first })
    ctx.voice.completeTaskCommand(opened.id, first.id, { kind: 'accepted', taskId: VoiceTaskId('task-1') })
    emit?.({ type: 'task.command', call: second })
    emit?.({ type: 'task.command', call: first })

    expect(events).toEqual([{ type: 'task.command', call: first }])
    expect(connected.spies.completeTaskCommand).toHaveBeenCalledWith(second.id, {
      kind: 'rejected',
      code: 'capacity_exceeded',
      message: 'voice session already tracks 1 command calls',
    })
    expect(connected.spies.completeTaskCommand).toHaveBeenLastCalledWith(first.id, {
      kind: 'accepted', taskId: VoiceTaskId('task-1'),
    })
  })

  it('closes every live provider on service disposal even when one close fails', async () => {
    const ctx = new Context()
    await ctx.plugin(VoiceRuntime, { provider: 'test' })
    const first = providerSession()
    const second = providerSession()
    const failure = new Error('second close failed')
    second.spies.close.mockRejectedValue(failure)
    const sessions = [first.session, second.session]
    ctx.voice.registerProvider({
      id: 'test',
      available: () => true,
      connect: () => Promise.resolve(sessions.shift() as VoiceProviderSession),
    })
    await ctx.voice.open(SessionId('agent-1'))
    await ctx.voice.open(SessionId('agent-2'))

    await ctx.fiber.dispose()
    expect(first.spies.close).toHaveBeenCalledOnce()
    expect(second.spies.close).toHaveBeenCalledOnce()
  })
})
