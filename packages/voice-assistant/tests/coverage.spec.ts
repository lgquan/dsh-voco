import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  SessionId,
  type SessionEvent,
  type UserMessage,
} from '@deepseek-ai/dsh-session'
import {
  VoiceCommandCallId,
  VoiceResponseId,
  VoiceSessionId,
  VoiceTaskId,
  VoiceUtteranceId,
  type TaskCommandCall,
  type TaskObservation,
  type VoiceEvent,
  type VoiceInteractionMode,
  type VoiceSessionInfo,
} from '@lgquan/dsh-voice'
import type { VoiceMessageInput, VoiceMessageReceipt } from '../src/tool.ts'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const toolState = vi.hoisted(() => ({
  mode: 'normal' as 'normal' | 'missing' | 'throw',
  installError: undefined as unknown,
  nextDispose: { throws: false, error: undefined } as { throws: boolean; error: unknown },
  senders: [] as Array<(input: VoiceMessageInput) => VoiceMessageReceipt>,
  disposers: [] as Array<ReturnType<typeof vi.fn>>,
}))

vi.mock('../src/tool.ts', () => ({
  installVoiceMessageTool: (
    _agentCtx: Context,
    send: (input: VoiceMessageInput) => VoiceMessageReceipt,
  ): (() => void) => {
    if (toolState.mode === 'throw') throw toolState.installError
    if (toolState.mode === 'missing') return undefined as unknown as () => void
    toolState.senders.push(send)
    const behavior = toolState.nextDispose
    toolState.nextDispose = { throws: false, error: undefined }
    const dispose = vi.fn(() => {
      if (behavior.throws) throw behavior.error
    })
    toolState.disposers.push(dispose)
    return dispose
  },
}))

import { apply } from '../src/index.ts'

type Listener = (...args: unknown[]) => unknown

interface FakeSession {
  readonly id: SessionId
  readonly header: {
    readonly cwd?: string
    readonly agentPreset?: string
  }
  readonly events: SessionEvent[]
  readonly append: (type: string, data: unknown, options?: unknown) => void
}

interface CapturedTask {
  readonly id: VoiceTaskId
  interactionMode: VoiceInteractionMode
  readonly taskSessionId: SessionId
  readonly messageIds: Set<string>
  agent: Agent
  taskTurn?: number
  lastAssistantMessage?: { readonly id: string; readonly text: string }
  completionMessage?: { readonly id: string; readonly text: string }
  completionDetail?: string
  disposeVoiceMessage?: () => void
  cancelling: boolean
  waitingUser: boolean
}

interface CapturedBinding {
  readonly sessionId: SessionId
  agent?: Agent
  voiceSessionId: VoiceSessionId | undefined
  interactionMode: VoiceInteractionMode | undefined
  voiceAttached: boolean
  active: CapturedTask | undefined
  continuousTaskAgent: {
    readonly taskSessionId: SessionId
    readonly agent: Agent
    readonly disposeVoiceMessage: () => void
  } | undefined
  lastTerminalTaskId: VoiceTaskId | undefined
  readonly pending: TaskObservation[]
  readonly utterances: Map<string, unknown>
  chain: Promise<void>
}

interface Harness {
  readonly ctx: Context
  readonly sessions: Map<SessionId, FakeSession>
  readonly agents: Map<SessionId, Agent>
  readonly bindings: Map<SessionId, CapturedBinding>
  readonly taskBindings: Map<SessionId, CapturedBinding>
  readonly handles: Map<SessionId, AgentHandle>
  readonly listeners: Map<string, Listener>
  readonly observations: TaskObservation[]
  readonly completions: Array<{ readonly callId: string; readonly result: unknown }>
  readonly warnings: unknown[]
  readonly created: Agent[]
  readonly handleDisposers: Array<ReturnType<typeof vi.fn>>
  readonly loadMemory: (sessionId: SessionId) => Promise<unknown>
  readonly behavior: {
    createError: unknown
    resumeError: unknown
    skipSetup: boolean
    nextFollowup: { throws: boolean; error: unknown }
    nextHandleDispose: { throws: boolean; error: unknown }
  }
  readonly services: {
    persistence: { inspect: ReturnType<typeof vi.fn> } | undefined
    presets: {
      mount: ReturnType<typeof vi.fn>
      composeFrom: ReturnType<typeof vi.fn>
    } | undefined
    workspaceRegistry: { list: ReturnType<typeof vi.fn> } | undefined
  }
  cleanup: (() => Promise<void>) | undefined
  makeSession: (id: SessionId, meta?: { cwd?: string; agentPreset?: string }) => FakeSession
  makeAgent: (session: FakeSession, options?: { provider?: string; model?: string }) => Agent
  dispatch: (event: string, ...args: unknown[]) => Promise<void>
  flush: () => Promise<void>
  open: (sessionId: SessionId, mode: VoiceInteractionMode, id?: VoiceSessionId) => Promise<VoiceSessionInfo>
  voiceEvent: (session: VoiceSessionInfo, event: VoiceEvent) => Promise<void>
}

function sessionInfo(
  agentSessionId: SessionId,
  interactionMode: VoiceInteractionMode,
  id = VoiceSessionId(`voice-${agentSessionId}`),
): VoiceSessionInfo {
  return { id, agentSessionId, interactionMode } as VoiceSessionInfo
}

function makeHarness(config: Parameters<typeof apply>[1] = {}): Harness {
  const sessions = new Map<SessionId, FakeSession>()
  const agents = new Map<SessionId, Agent>()
  const listeners = new Map<string, Listener>()
  const observations: TaskObservation[] = []
  const completions: Array<{ callId: string; result: unknown }> = []
  const warnings: unknown[] = []
  const created: Agent[] = []
  const handleDisposers: Array<ReturnType<typeof vi.fn>> = []
  let memorySource: ((sessionId: SessionId) => Promise<unknown>) | undefined
  const behavior = {
    createError: undefined as unknown,
    resumeError: undefined as unknown,
    skipSetup: false,
    nextFollowup: { throws: false, error: undefined as unknown },
    nextHandleDispose: { throws: false, error: undefined as unknown },
  }
  const services: Harness['services'] = {
    persistence: undefined,
    presets: undefined,
    workspaceRegistry: undefined,
  }

  const makeSession = (
    id: SessionId,
    meta: { cwd?: string; agentPreset?: string } = {},
  ): FakeSession => {
    const events: SessionEvent[] = []
    const session: FakeSession = {
      id,
      header: { ...meta },
      events,
      append(type, data, options) {
        events.push({
          type,
          data,
          seq: events.length,
          time: events.length,
          ...(options === undefined ? {} : options as object),
        } as SessionEvent)
      },
    }
    sessions.set(id, session)
    return session
  }

  const makeAgent = (
    session: FakeSession,
    options: { provider?: string; model?: string } = {},
  ): Agent => ({
    id: session.id,
    options,
    session: session as unknown as Agent['session'],
    inbox: {} as Agent['inbox'],
    status: 'idle',
    ctx: {} as Context,
    cancel: vi.fn(),
    whenIdle: () => Promise.resolve(),
    runMaintenance: () => Promise.reject(new Error('unused')),
    send: vi.fn(),
    steer: vi.fn(),
    inject: vi.fn(),
    followup: vi.fn(),
  })

  const createHandle = async (options: CreateAgentOptions): Promise<AgentHandle> => {
    if (behavior.createError !== undefined) throw behavior.createError
    const session = makeSession(options.sessionId, options.meta)
    const agent = makeAgent(session, options.agentOptions)
    const followupBehavior = behavior.nextFollowup
    behavior.nextFollowup = { throws: false, error: undefined }
    if (followupBehavior.throws) {
      (agent.followup as ReturnType<typeof vi.fn>).mockImplementation(() => { throw followupBehavior.error })
    }
    if (!behavior.skipSetup) {
      const commit = await options.setup?.({} as Context)
      commit?.commit()
    }
    const disposeBehavior = behavior.nextHandleDispose
    behavior.nextHandleDispose = { throws: false, error: undefined }
    const dispose = vi.fn(async () => {
      if (disposeBehavior.throws) throw disposeBehavior.error
    })
    handleDisposers.push(dispose)
    agents.set(agent.id, agent)
    created.push(agent)
    return { agent, dispose }
  }

  const resume = async (options: {
    resumeSessionId: SessionId
    agentOptions?: object
    setup?: (ctx: Context) => Promise<void>
  }): Promise<AgentHandle> => {
    if (behavior.resumeError !== undefined) throw behavior.resumeError
    const session = sessions.get(options.resumeSessionId)
    if (session === undefined) throw new Error('resume fixture session missing')
    await options.setup?.({} as Context)
    const agent = makeAgent(session, options.agentOptions)
    const dispose = vi.fn(async () => {})
    handleDisposers.push(dispose)
    agents.set(agent.id, agent)
    created.push(agent)
    return { agent, dispose }
  }

  const context = {
    sessions: { get: (id: SessionId) => sessions.get(id) },
    agents: {
      get: (id: SessionId) => agents.get(id),
      create: createHandle,
      resume,
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) },
    voice: {
      registerMemorySource: (source: (sessionId: SessionId) => Promise<unknown>) => {
        memorySource = source
        return () => { memorySource = undefined }
      },
      appendTaskObservation: (_id: VoiceSessionId, observation: TaskObservation) => { observations.push(observation) },
      requestResponse: vi.fn(),
      completeTaskCommand: (id: VoiceSessionId, callId: string, result: unknown) => {
        void id
        completions.push({ callId, result })
      },
    },
    logger: { warn: (error: unknown) => { warnings.push(error) } },
    get: (name: string) => {
      if (name === 'sessionPersistence') return services.persistence
      if (name === 'agentPresets') return services.presets
      if (name === 'workspaceRegistry') return services.workspaceRegistry
      return undefined
    },
    on: (event: string, listener: Listener) => {
      listeners.set(event, listener)
      return () => { listeners.delete(event) }
    },
    effect: (register: () => () => Promise<void>) => {
      harness.cleanup = register()
      return () => {}
    },
  }
  const harness = {
    ctx: context as unknown as Context,
    sessions,
    agents,
    bindings: undefined as unknown as Map<SessionId, CapturedBinding>,
    taskBindings: undefined as unknown as Map<SessionId, CapturedBinding>,
    handles: undefined as unknown as Map<SessionId, AgentHandle>,
    listeners,
    observations,
    completions,
    warnings,
    created,
    handleDisposers,
    loadMemory: async (sessionId: SessionId) => memorySource?.(sessionId),
    behavior,
    services,
    cleanup: undefined as Harness['cleanup'],
    makeSession,
    makeAgent,
    async flush() {
      await Promise.resolve()
      await Promise.all([...harness.bindings.values()].map(binding => binding.chain))
      await Promise.resolve()
    },
    async dispatch(event: string, ...args: unknown[]) {
      const listener = listeners.get(event)
      if (listener === undefined) throw new Error(`missing listener ${event}`)
      await listener(...args)
      await harness.flush()
    },
    async open(sessionId: SessionId, mode: VoiceInteractionMode, id?: VoiceSessionId) {
      const info = sessionInfo(sessionId, mode, id)
      await harness.dispatch('voice/session-opened', info)
      return info
    },
    async voiceEvent(session: VoiceSessionInfo, event: VoiceEvent) {
      await harness.dispatch('voice/session-event', session, event)
    },
  } satisfies Harness

  const nativeMap = globalThis.Map
  const tracked: Array<Map<unknown, unknown>> = []
  class TrackingMap<K, V> extends nativeMap<K, V> {
    constructor() {
      super()
      tracked.push(this)
    }
  }
  globalThis.Map = TrackingMap
  try {
    apply(harness.ctx, config)
  } finally {
    globalThis.Map = nativeMap
  }
  harness.bindings = tracked[0] as Map<SessionId, CapturedBinding>
  harness.taskBindings = tracked[1] as Map<SessionId, CapturedBinding>
  harness.handles = tracked[2] as Map<SessionId, AgentHandle>
  return harness
}

function assistantEvent(turn: number, text: string): SessionEvent {
  return {
    type: 'assistant/message',
    data: {
      turn,
      step: 1,
      message: createAssistantMessage({
        content: text === '' ? [] : [{ type: 'text', text }],
        source: { provider: 'test', model: 'test' },
      }),
    },
    seq: 0,
    time: 0,
  }
}

function turnEnd(turn: number, kind: 'completed' | 'aborted' | 'failed'): SessionEvent {
  return {
    type: 'turn/end',
    data: kind === 'aborted'
      ? { turn, reason: { kind, reason: { kind: 'user' } } }
      : { turn, reason: { kind } },
    seq: 0,
    time: 0,
  } as SessionEvent
}

async function startDelegation(harness: Harness, session: VoiceSessionInfo, input = 'task'): Promise<VoiceTaskId> {
  const callId = VoiceCommandCallId(`start-${harness.completions.length}`)
  await harness.voiceEvent(session, {
    type: 'task.command',
    call: { id: callId, command: { type: 'realtime_delegation', input } },
  })
  const result = harness.completions.find(item => item.callId === callId)?.result as {
    readonly kind: string
    readonly taskId?: VoiceTaskId
  } | undefined
  if (result?.kind !== 'accepted' || result.taskId === undefined) {
    throw new Error(`delegation was not accepted: ${JSON.stringify(result)}`)
  }
  return result.taskId
}

beforeEach(() => {
  toolState.mode = 'normal'
  toolState.installError = undefined
  toolState.nextDispose = { throws: false, error: undefined }
  toolState.senders.length = 0
  toolState.disposers.length = 0
})

describe('voice assistant branch coverage', () => {
  it('restores only bounded completed utterances from live or persisted source sessions', async () => {
    const harness = makeHarness({ maxRestoredUtterances: 2 })
    const sessionId = SessionId('memory-source')
    const session = harness.makeSession(sessionId)
    session.append('voice/utterance-end', {
      utteranceId: VoiceUtteranceId('u1'), role: 'user', text: ' first ', state: 'completed',
    })
    session.append('voice/utterance-end', {
      utteranceId: VoiceUtteranceId('a1'), role: 'assistant', text: ' second ', state: 'completed',
    })
    session.append('voice/utterance-end', {
      utteranceId: VoiceUtteranceId('ignored'), role: 'assistant', text: 'interrupted', state: 'interrupted',
    })
    session.append('voice/utterance-end', {
      utteranceId: VoiceUtteranceId('u2'), role: 'user', text: ' third ', state: 'completed',
    })
    expect(await harness.loadMemory(sessionId)).toEqual({
      items: [
        { role: 'assistant', text: 'second' },
        { role: 'user', text: 'third' },
      ],
    })

    harness.sessions.delete(sessionId)
    harness.services.persistence = { inspect: vi.fn(async () => ({ events: session.events })) }
    expect(await harness.loadMemory(sessionId)).toEqual({
      items: [
        { role: 'assistant', text: 'second' },
        { role: 'user', text: 'third' },
      ],
    })
    expect(harness.services.persistence.inspect).toHaveBeenCalledWith(sessionId)

    const disabled = makeHarness({ restoreConversation: false })
    expect(await disabled.loadMemory(sessionId)).toBeUndefined()
  })

  it('persists every utterance lifecycle and ignores stale or carrier-only events', async () => {
    const harness = makeHarness()
    const sessionId = SessionId('utterances')
    const record = harness.makeSession(sessionId)
    const first = sessionInfo(sessionId, 'frontend-agent', VoiceSessionId('voice-first'))
    const second = sessionInfo(sessionId, 'frontend-agent', VoiceSessionId('voice-second'))
    const opened = harness.listeners.get('voice/session-opened')
    if (opened === undefined) throw new Error('missing open listener')
    opened(first)
    opened(second)
    await harness.flush()
    await harness.dispatch('voice/session-opened', second)

    const sessionEvent = harness.listeners.get('voice/session-event')
    if (sessionEvent === undefined) throw new Error('missing voice-event listener')
    sessionEvent(second, {
      type: 'task.command',
      call: {
        id: VoiceCommandCallId('detached-before-dispatch'),
        command: { type: 'realtime_delegation', input: 'ignored' },
      },
    } satisfies VoiceEvent)
    const binding = harness.bindings.get(sessionId)
    if (binding === undefined) throw new Error('utterance binding missing')
    binding.voiceSessionId = VoiceSessionId('changed-before-dispatch')
    await harness.flush()
    binding.voiceSessionId = second.id

    await harness.voiceEvent(first, {
      type: 'transcription.started', utteranceId: VoiceUtteranceId('stale'),
    })
    await harness.voiceEvent(second, {
      type: 'transcription.started', utteranceId: VoiceUtteranceId('user'),
    })
    await harness.voiceEvent(second, {
      type: 'transcription.started', utteranceId: VoiceUtteranceId('user'),
    })
    await harness.voiceEvent(second, {
      type: 'transcription.updated', utteranceId: VoiceUtteranceId('user'), text: 'partial',
    })
    await harness.voiceEvent(second, {
      type: 'transcription.completed', utteranceId: VoiceUtteranceId('user'), text: 'final',
    })
    await harness.voiceEvent(second, {
      type: 'transcription.failed', utteranceId: VoiceUtteranceId('failed'), message: 'noise',
    })

    const responseA = VoiceResponseId('response-a')
    const responseB = VoiceResponseId('response-b')
    await harness.voiceEvent(second, {
      type: 'output_text.started', utteranceId: VoiceUtteranceId('assistant-a'), responseId: responseA,
    })
    await harness.voiceEvent(second, {
      type: 'output_text.delta', utteranceId: VoiceUtteranceId('assistant-a'), responseId: responseA, text: 'A',
    })
    await harness.voiceEvent(second, {
      type: 'output_text.done', utteranceId: VoiceUtteranceId('assistant-a'), responseId: responseA, text: '',
    })
    await harness.voiceEvent(second, {
      type: 'output_text.started', utteranceId: VoiceUtteranceId('assistant-b'), responseId: responseB,
    })
    await harness.voiceEvent(second, {
      type: 'output_text.started', utteranceId: VoiceUtteranceId('assistant-c'), responseId: responseA,
    })
    await harness.voiceEvent(second, {
      type: 'transcription.started', utteranceId: VoiceUtteranceId('open-user'),
    })
    await harness.voiceEvent(second, {
      type: 'transcription.updated', utteranceId: VoiceUtteranceId('open-user'), text: 'old snapshot',
    })
    await harness.voiceEvent(second, {
      type: 'transcription.updated', utteranceId: VoiceUtteranceId('open-user'), text: 'revised snapshot',
    })
    await harness.voiceEvent(second, { type: 'response.interrupted', responseId: responseA })
    await harness.voiceEvent(second, { type: 'response.interrupted' })

    await harness.voiceEvent(second, {
      type: 'transcription.started', utteranceId: VoiceUtteranceId('reused'),
    })
    await harness.voiceEvent(second, {
      type: 'output_text.started', utteranceId: VoiceUtteranceId('reused'), responseId: responseA,
    })
    expect(harness.warnings).toHaveLength(1)

    for (const event of [
      { type: 'output_audio.started', responseId: responseA },
      { type: 'output_audio.delta', responseId: responseA, audio: 'AA==' },
      { type: 'output_audio.done', responseId: responseA },
      { type: 'task.observation', observation: { taskId: VoiceTaskId('x'), status: 'accepted' } },
      { type: 'error', error: new Error('provider') },
      { type: 'closed' },
    ] as VoiceEvent[]) await harness.voiceEvent(second, event)

    await expect(harness.voiceEvent(second, { type: 'unknown' } as unknown as VoiceEvent))
      .rejects.toThrow('unexpected task command')
    expect(harness.warnings).toHaveLength(1)

    const staleClose = sessionInfo(sessionId, 'frontend-agent', VoiceSessionId('stale-close'))
    await harness.dispatch('voice/session-detached', staleClose)
    await harness.dispatch('voice/session-detached', second)
    expect(binding.voiceAttached).toBe(false)
    await harness.dispatch('voice/session-opened', second)
    expect(binding.voiceAttached).toBe(true)
    await harness.dispatch('voice/session-closed', sessionInfo(
      SessionId('never-opened'),
      'frontend-agent',
      VoiceSessionId('never-opened'),
    ))
    await harness.dispatch('voice/session-closed', staleClose)
    await harness.dispatch('voice/session-closed', second)
    expect(record.events.some(event => event.type === 'voice/utterance-end'
      && event.data.utteranceId === VoiceUtteranceId('open-user')
      && event.data.text === 'revised snapshot')).toBe(true)
    expect(record.events.some(event => event.type === 'voice/utterance-end'
      && event.data.utteranceId === VoiceUtteranceId('reused'))).toBe(true)
  })

  it('drives speech-shell turns through steer, claims, output, and every terminal status', async () => {
    const harness = makeHarness({
      completedAnnouncement: 'done',
      failedAnnouncement: 'failed',
      cancelledAnnouncement: 'cancelled',
    })
    const sessionId = SessionId('speech')
    const record = harness.makeSession(sessionId)
    const agent = harness.makeAgent(record, { provider: 'live', model: 'live' })
    harness.agents.set(sessionId, agent)
    const voice = await harness.open(sessionId, 'speech-shell')
    await harness.voiceEvent(voice, {
      type: 'task.command',
      call: {
        id: VoiceCommandCallId('speech-command-ignored'),
        command: { type: 'realtime_delegation', input: 'ignored' },
      },
    })

    await harness.voiceEvent(voice, {
      type: 'transcription.completed', utteranceId: VoiceUtteranceId('blank'), text: '   ',
    })
    await harness.voiceEvent(voice, {
      type: 'transcription.completed', utteranceId: VoiceUtteranceId('first'), text: 'first',
    })
    const binding = harness.bindings.get(sessionId)
    if (binding?.active === undefined) throw new Error('speech task missing')
    const firstTask = binding.active
    await harness.voiceEvent(voice, {
      type: 'transcription.completed', utteranceId: VoiceUtteranceId('second'), text: 'second',
    })
    // oxlint-disable-next-line typescript/unbound-method -- The fake Agent method is a context-free vi.fn spy.
    expect(agent.steer).toHaveBeenCalledTimes(1)

    await harness.dispatch('agent/inbox/claimed', {
      agent: harness.makeAgent(harness.makeSession(SessionId('unrelated'))),
      message: createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } }),
      turn: 1,
    })
    await harness.dispatch('session/event', record, assistantEvent(1, 'ignored'))
    await harness.dispatch('agent/inbox/claimed', {
      agent,
      message: createUserMessage({ content: [{ type: 'text', text: 'wrong' }], source: { kind: 'user' } }),
      turn: 1,
    })
    const followed = (agent.followup as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as UserMessage | undefined
    if (followed === undefined) throw new Error('speech followup missing')
    await harness.dispatch('agent/inbox/claimed', { agent, message: followed, turn: 1 })
    expect(firstTask.taskTurn).toBe(1)
    await harness.voiceEvent(voice, {
      type: 'transcription.completed', utteranceId: VoiceUtteranceId('third'), text: 'third',
    })
    await harness.dispatch('agent/inbox/claimed', { agent, message: followed, turn: 2 })

    await harness.dispatch('session/event', record, assistantEvent(2, 'wrong turn'))
    await harness.dispatch('session/event', record, assistantEvent(1, ''))
    await harness.dispatch('session/event', record, assistantEvent(1, 'spoken output'))
    await harness.dispatch('session/event', record, {
      type: 'step/start', data: { turn: 1, step: 1 }, seq: 0, time: 0,
    })
    await harness.dispatch('session/event', record, turnEnd(2, 'completed'))
    await harness.dispatch('session/event', record, turnEnd(1, 'completed'))
    expect(harness.observations.at(-1)?.status).toBe('completed')
    expect(harness.observations.at(-1)).not.toHaveProperty('voiceMessage')

    for (const [name, reason] of [
      ['no-output', 'completed'],
      ['failed-task', 'failed'],
      ['cancelled-task', 'aborted'],
    ] as const) {
      await harness.voiceEvent(voice, {
        type: 'transcription.completed', utteranceId: VoiceUtteranceId(name), text: name,
      })
      const task = binding.active
      if (task === undefined) throw new Error('next speech task missing')
      const message = (agent.followup as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as UserMessage
      await harness.dispatch('agent/inbox/claimed', { agent, message, turn: 3 })
      await harness.dispatch('session/event', record, turnEnd(3, reason))
    }
    expect(harness.observations
      .filter(item => ['completed', 'failed', 'cancelled'].includes(item.status))
      .slice(-3)
      .map(item => item.status)).toEqual(['completed', 'failed', 'cancelled'])
  })

  it('uses cached Agents and falls back from reasoning blocks to the final assistant text', async () => {
    const harness = makeHarness()
    const sessionId = SessionId('cached-agent')
    const record = harness.makeSession(sessionId)
    const sourceAgent = harness.makeAgent(record)
    await harness.dispatch('voice/session-event', sessionInfo(
      sessionId,
      'frontend-agent',
      VoiceSessionId('not-attached'),
    ), { type: 'closed' })
    const binding = harness.bindings.get(sessionId)
    if (binding === undefined) throw new Error('cached binding missing')
    binding.agent = sourceAgent
    const voice = await harness.open(sessionId, 'frontend-agent')
    toolState.nextDispose = { throws: true, error: new Error('terminal tool disposal') }
    const taskId = await startDelegation(harness, voice)
    const task = binding.active
    if (task === undefined) throw new Error('cached task missing')

    await harness.voiceEvent(voice, {
      type: 'task.command',
      call: {
        id: VoiceCommandCallId('message-before-claim'),
        command: { type: 'send_task_message', taskId, message: 'before claim' },
      },
    })
    expect(harness.completions.at(-1)?.result).toMatchObject({ kind: 'accepted' })
    const initial = (task.agent.followup as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as UserMessage
    await harness.dispatch('agent/inbox/claimed', { agent: task.agent, message: initial, turn: 1 })
    await harness.voiceEvent(voice, {
      type: 'task.command',
      call: {
        id: VoiceCommandCallId('message-after-claim'),
        command: { type: 'send_task_message', taskId, message: 'after claim' },
      },
    })
    await harness.dispatch('session/event', task.agent.session, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: createAssistantMessage({
          content: [
            { type: 'reasoning', text: 'hidden' },
            { type: 'text', text: 'visible fallback' },
          ],
          source: { provider: 'test', model: 'test' },
        }),
      },
      seq: 0,
      time: 0,
    })
    await harness.dispatch('session/event', task.agent.session, turnEnd(1, 'completed'))
    expect(harness.observations.at(-1)).toMatchObject({
      status: 'completed',
      announcement: '任务已完成。',
    })
    expect(harness.observations.at(-1)).not.toHaveProperty('voiceMessage')
    expect(harness.warnings).toHaveLength(1)
    expect(() => toolState.senders.at(-1)?.({
      delegationId: taskId,
      channel: 'STATUS',
      message: 'late',
    })).toThrow('is not active')

    toolState.nextDispose = { throws: true, error: 'string disposal' }
    const secondTaskId = await startDelegation(harness, voice, 'second task')
    const secondTask = binding.active
    if (secondTask === undefined) throw new Error('second cached task missing')
    const secondMessage = (secondTask.agent.followup as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as UserMessage
    await harness.dispatch('agent/inbox/claimed', {
      agent: secondTask.agent,
      message: secondMessage,
      turn: 2,
    })
    await harness.dispatch('session/event', secondTask.agent.session, turnEnd(2, 'completed'))
    expect(harness.observations.at(-1)).toMatchObject({ taskId: secondTaskId, status: 'completed' })
    expect(harness.warnings).toHaveLength(2)
  })

  it('does not duplicate the source turn marker after a persisted session is reopened', async () => {
    const harness = makeHarness()
    const sessionId = SessionId('marked-source')
    const source = harness.makeSession(sessionId)
    source.append('turn/start', { turn: 1 })
    source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const voice = await harness.open(sessionId, 'frontend-agent')

    await harness.voiceEvent(voice, {
      type: 'transcription.completed',
      utteranceId: VoiceUtteranceId('reopened-input'),
      text: '继续之前的语音对话',
    })
    expect(source.events.filter(event => event.type === 'turn/start')).toHaveLength(1)
  })

  it('reuses one continuous task Agent across distinct sequential delegations', async () => {
    const harness = makeHarness({ taskSessionPolicy: 'continuous' })
    const sessionId = SessionId('continuous-source')
    const source = harness.makeSession(sessionId, { cwd: 'D:/workspace' })
    harness.agents.set(sessionId, harness.makeAgent(source))
    const voice = await harness.open(sessionId, 'frontend-agent')

    const firstTaskId = await startDelegation(harness, voice, 'first task')
    const first = harness.bindings.get(sessionId)?.active
    if (first === undefined) throw new Error('first continuous task missing')
    const firstMessage = (first.agent.followup as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as UserMessage
    await harness.dispatch('agent/inbox/claimed', { agent: first.agent, message: firstMessage, turn: 1 })
    toolState.senders[0]?.({ delegationId: firstTaskId, channel: 'COMPLETE', message: 'first spoken result' })
    await harness.dispatch('session/event', first.agent.session, turnEnd(1, 'completed'))

    const secondTaskId = await startDelegation(harness, voice, 'second task')
    const second = harness.bindings.get(sessionId)?.active
    if (second === undefined) throw new Error('second continuous task missing')
    expect(secondTaskId).not.toBe(firstTaskId)
    expect(second.taskSessionId).toBe(first.taskSessionId)
    expect(second.agent).toBe(first.agent)
    expect(harness.created).toHaveLength(1)
    expect(second.agent.followup).toHaveBeenCalledTimes(2)
    expect(toolState.senders).toHaveLength(1)

    const delegatedSessions = source.events.flatMap(event => (
      event.type === 'voice/task-delegated' ? [event.data.taskSessionId] : []
    ))
    expect(delegatedSessions).toEqual([first.taskSessionId, first.taskSessionId])
    expect(source.events.filter(event => event.type === 'voice/task-session-bound').map(event => (
      event.type === 'voice/task-session-bound' ? event.data.taskSessionId : undefined
    ))).toEqual([first.taskSessionId])
    const bindingState = source.events.findLast(event => event.type === 'voice/agent-binding-state')
    expect(bindingState?.type === 'voice/agent-binding-state' ? bindingState.data : undefined).toMatchObject({
      voiceConversationId: sessionId,
      agentSessionId: first.taskSessionId,
      workspacePath: 'D:/workspace',
      lastTaskId: secondTaskId,
      lastUsedAt: expect.any(Number),
      status: 'queued',
    })
    expect(harness.taskBindings.get(first.taskSessionId)).toBe(harness.bindings.get(sessionId))
  })

  it('resumes the latest continuous task Session after the assistant plugin restarts', async () => {
    const harness = makeHarness({ taskSessionPolicy: 'continuous' })
    const sourceId = SessionId('continuous-restart-source')
    const taskSessionId = SessionId('continuous-restart-task')
    const source = harness.makeSession(sourceId)
    harness.makeSession(taskSessionId)
    harness.agents.set(sourceId, harness.makeAgent(source))
    source.append('voice/task-delegated', {
      taskId: VoiceTaskId('previous-delegation'),
      taskSessionId,
      input: 'previous task',
    })
    const voice = await harness.open(sourceId, 'frontend-agent')

    const nextTaskId = await startDelegation(harness, voice, 'continue after restart')
    const active = harness.bindings.get(sourceId)?.active
    if (active === undefined) throw new Error('resumed continuous task missing')
    expect(nextTaskId).not.toBe(VoiceTaskId('previous-delegation'))
    expect(active.taskSessionId).toBe(taskSessionId)
    expect(active.agent.id).toBe(taskSessionId)
    expect(active.agent.followup).toHaveBeenCalledOnce()
    expect(harness.created).toHaveLength(1)
    expect(harness.taskBindings.get(taskSessionId)).toBe(harness.bindings.get(sourceId))
  })

  it('prefers the complete durable binding state when resuming a continuous Agent', async () => {
    const harness = makeHarness({ taskSessionPolicy: 'continuous' })
    const sourceId = SessionId('binding-state-source')
    const staleId = SessionId('stale-task-session')
    const currentId = SessionId('current-task-session')
    const source = harness.makeSession(sourceId, { cwd: 'D:/bound-workspace' })
    harness.makeSession(staleId)
    harness.makeSession(currentId)
    harness.agents.set(sourceId, harness.makeAgent(source))
    source.append('voice/task-delegated', {
      taskId: VoiceTaskId('stale-task'), taskSessionId: staleId, input: 'old',
    })
    source.append('voice/agent-binding-state', {
      voiceConversationId: sourceId,
      agentSessionId: currentId,
      workspacePath: 'D:/bound-workspace',
      lastTaskId: VoiceTaskId('current-task'),
      lastUsedAt: 123,
      status: 'completed',
    })

    const voice = await harness.open(sourceId, 'frontend-agent')
    await startDelegation(harness, voice, 'continue current binding')
    expect(harness.bindings.get(sourceId)?.active?.taskSessionId).toBe(currentId)
  })

  it('keeps a question task active and resumes the same Agent after the user replies', async () => {
    const harness = makeHarness({ taskSessionPolicy: 'continuous' })
    const sourceId = SessionId('waiting-source')
    const source = harness.makeSession(sourceId)
    harness.agents.set(sourceId, harness.makeAgent(source))
    const voice = await harness.open(sourceId, 'frontend-agent')
    const taskId = await startDelegation(harness, voice, 'prepare a destructive migration')
    const task = harness.bindings.get(sourceId)?.active
    if (task === undefined) throw new Error('waiting task missing')
    const firstMessage = (task.agent.followup as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as UserMessage
    await harness.dispatch('agent/inbox/claimed', { agent: task.agent, message: firstMessage, turn: 1 })

    toolState.senders[0]?.({
      delegationId: taskId,
      channel: 'STATUS',
      message: '需要确认。',
      type: 'question',
      detail: 'Migration deletes the old index and requires explicit confirmation.',
      voiceHint: '这一步会删除旧索引，需要你确认后我再继续。',
    })
    expect(harness.observations.at(-1)).toMatchObject({
      taskId,
      status: 'waiting-user',
      type: 'question',
      voiceHint: '这一步会删除旧索引，需要你确认后我再继续。',
    })
    await harness.dispatch('session/event', task.agent.session, turnEnd(1, 'completed'))
    expect(harness.bindings.get(sourceId)?.active).toBe(task)
    expect(task.taskTurn).toBeUndefined()

    await harness.voiceEvent(voice, {
      type: 'task.command',
      call: {
        id: VoiceCommandCallId('waiting-reply'),
        command: { type: 'send_task_message', taskId, message: '确认继续' },
      },
    })
    expect(task.agent.followup).toHaveBeenCalledTimes(2)
    expect(task.agent.steer).not.toHaveBeenCalled()
    expect(harness.observations.at(-1)).toMatchObject({ taskId, status: 'queued' })

    const secondMessage = (task.agent.followup as ReturnType<typeof vi.fn>).mock.calls[1]?.[0] as UserMessage
    await harness.dispatch('agent/inbox/claimed', { agent: task.agent, message: secondMessage, turn: 2 })
    toolState.senders[0]?.({
      delegationId: taskId,
      channel: 'COMPLETE',
      message: '迁移已完成。',
      type: 'result',
      detail: 'Migration and verification completed.',
      voiceHint: '迁移已经完成，并且验证通过。',
    })
    await harness.dispatch('session/event', task.agent.session, turnEnd(2, 'completed'))
    expect(harness.bindings.get(sourceId)?.active).toBeUndefined()
    expect(harness.observations.at(-1)).toMatchObject({
      taskId,
      status: 'completed',
      type: 'result',
      voiceHint: '迁移已经完成，并且验证通过。',
    })
  })

  it('records an active task as interrupted during service shutdown', async () => {
    const harness = makeHarness({ taskSessionPolicy: 'continuous' })
    const sourceId = SessionId('shutdown-source')
    const source = harness.makeSession(sourceId)
    harness.agents.set(sourceId, harness.makeAgent(source))
    const voice = await harness.open(sourceId, 'frontend-agent')
    const taskId = await startDelegation(harness, voice, 'long running task')

    await expect(harness.cleanup?.()).resolves.toBeUndefined()
    expect(source.events.flatMap(event => (
      event.type === 'voice/task-observation' && event.data.taskId === taskId
        ? [event.data]
        : []
    )).at(-1)).toMatchObject({
      taskId,
      status: 'interrupted',
      announcement: '上次任务因服务关闭而中断，没有自动重放。你可以告诉我是否继续。',
    })
  })

  it('includes only the last spoken progress hint in the interruption recovery message', async () => {
    const harness = makeHarness({ taskSessionPolicy: 'continuous' })
    const sourceId = SessionId('progress-shutdown-source')
    const source = harness.makeSession(sourceId)
    harness.agents.set(sourceId, harness.makeAgent(source))
    const voice = await harness.open(sourceId, 'frontend-agent')
    const taskId = await startDelegation(harness, voice, 'inspect and modify')
    toolState.senders[0]?.({
      delegationId: taskId,
      channel: 'STATUS',
      message: '已经找到问题，正在修改。',
      type: 'progress',
      detail: 'Sensitive command output must remain in the task trace.',
      voiceHint: '已经找到问题，正在修改。',
    })

    await expect(harness.cleanup?.()).resolves.toBeUndefined()
    const interrupted = source.events.findLast(event => (
      event.type === 'voice/task-observation' && event.data.status === 'interrupted'
    ))
    expect(interrupted?.type === 'voice/task-observation' ? interrupted.data.announcement : undefined)
      .toBe('上次任务在“已经找到问题，正在修改。”之后因服务关闭而中断，没有自动重放。你可以告诉我是否继续。')
    expect(interrupted?.type === 'voice/task-observation' ? interrupted.data.announcement : undefined)
      .not.toContain('Sensitive command output')
  })

  it('announces the latest interrupted task without replaying it after restart', async () => {
    const harness = makeHarness({ taskSessionPolicy: 'continuous' })
    const sourceId = SessionId('interrupted-recovery-source')
    const source = harness.makeSession(sourceId)
    const taskId = VoiceTaskId('interrupted-task')
    source.append('voice/task-observation', {
      taskId,
      status: 'interrupted',
      announcement: '上次任务已中断，没有自动重放。',
      reason: 'service stopped',
    })

    await harness.open(sourceId, 'frontend-agent')
    expect(harness.observations.at(-1)).toMatchObject({ taskId, status: 'interrupted' })
    expect(harness.bindings.get(sourceId)?.active).toBeUndefined()
    expect(harness.created).toHaveLength(0)
    expect(harness.ctx.voice.requestResponse).toHaveBeenCalledTimes(1)
  })

  it('uses default model and announcement fallbacks when no header or preset exists', async () => {
    const resumed = makeHarness()
    const resumedId = SessionId('resume-defaults')
    const resumedRecord = resumed.makeSession(resumedId)
    resumed.services.persistence = {
      inspect: vi.fn(async () => ({ meta: resumedRecord.header, events: resumedRecord.events })),
    }
    const resumedVoice = await resumed.open(resumedId, 'frontend-agent')
    await startDelegation(resumed, resumedVoice)
    expect(resumed.created[0]?.options).toEqual({
      provider: 'default-provider',
      model: 'default-model',
    })

    const speech = makeHarness()
    const speechId = SessionId('default-announcements')
    const speechRecord = speech.makeSession(speechId)
    const speechAgent = speech.makeAgent(speechRecord)
    speech.agents.set(speechId, speechAgent)
    const speechVoice = await speech.open(speechId, 'speech-shell')
    for (const [text, reason, turn] of [
      ['complete without output', 'completed', 1],
      ['fail without output', 'failed', 2],
    ] as const) {
      await speech.voiceEvent(speechVoice, {
        type: 'transcription.completed',
        utteranceId: VoiceUtteranceId(`utterance-${turn}`),
        text,
      })
      const message = (speechAgent.followup as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as UserMessage
      await speech.dispatch('agent/inbox/claimed', { agent: speechAgent, message, turn })
      await speech.dispatch('session/event', speechRecord, turnEnd(turn, reason))
    }
    expect(speech.observations.filter(item => item.status === 'completed').at(-1)?.announcement).toBe('任务已完成。')
    expect(speech.observations.filter(item => item.status === 'failed').at(-1)?.announcement)
      .toBe('任务失败了，请查看屏幕上的错误信息。')
  })

  it('logs non-Error queue failures and still clears the failed active task', async () => {
    const missingSession = makeHarness()
    await missingSession.open(SessionId('missing-at-open'), 'speech-shell')
    expect(missingSession.warnings).toHaveLength(1)

    const harness = makeHarness()
    const sessionId = SessionId('queue-failure')
    const record = harness.makeSession(sessionId)
    const agent = harness.makeAgent(record)
    harness.agents.set(sessionId, agent)
    const voice = await harness.open(sessionId, 'speech-shell')
    ;(agent.followup as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const active = harness.bindings.get(sessionId)?.active
      if (active !== undefined) active.disposeVoiceMessage = () => { throw new Error('dispose failed') }
      Object.defineProperty(record, 'append', {
        configurable: true,
        value: () => { throw 'append failed' },
      })
      throw 'followup failed'
    })
    await harness.voiceEvent(voice, {
      type: 'transcription.completed',
      utteranceId: VoiceUtteranceId('queue-failure'),
      text: 'start',
    })
    expect(harness.warnings).toHaveLength(3)
    expect(harness.bindings.get(sessionId)?.active).toBeUndefined()
  })

  it('resumes a source Agent, composes presets, attaches a task, and exercises command failures', async () => {
    const harness = makeHarness({ failedAnnouncement: 'custom failure' })
    const sessionId = SessionId('frontend')
    const record = harness.makeSession(sessionId, { cwd: '/workspace', agentPreset: 'voice-preset' })
    record.append('request/header', {
      header: {
        config: { provider: 'header-provider', model: 'header-model' },
        tools: [],
        system: '',
      },
    })
    const mount = vi.fn(async () => {})
    const composeFrom = vi.fn()
    harness.services.presets = { mount, composeFrom }
    harness.services.persistence = {
      inspect: vi.fn(async () => ({ meta: record.header, events: record.events })),
    }
    const attachSession = vi.fn(async () => {})
    harness.services.workspaceRegistry = {
      list: vi.fn(() => [{ sessionIds: [sessionId], attachSession }]),
    }
    const voice = await harness.open(sessionId, 'frontend-agent')
    const taskId = await startDelegation(harness, voice, '<task&>')
    expect(mount).toHaveBeenCalledWith(expect.anything(), 'voice-preset')
    expect(composeFrom).toHaveBeenCalled()
    expect(attachSession).toHaveBeenCalled()
    expect(harness.created[0]?.options).toEqual({ provider: 'header-provider', model: 'header-model' })
    expect(harness.created[1]?.options).toEqual({ provider: 'header-provider', model: 'header-model' })
    const taskAgent = harness.created[1]
    if (taskAgent === undefined) throw new Error('task Agent missing')

    const statusBeforeClaim = toolState.senders[0]?.({
      delegationId: taskId,
      channel: 'STATUS',
      message: 'starting',
    })
    expect(statusBeforeClaim?.delivery).toBe('queued')
    const task = harness.bindings.get(sessionId)?.active
    if (task === undefined) throw new Error('task binding missing')
    task.interactionMode = 'speech-shell'
    expect(() => toolState.senders[0]?.({ delegationId: taskId, channel: 'STATUS', message: 'x' }))
      .toThrow('does not accept backend voice messages')
    task.interactionMode = 'frontend-agent'
    task.cancelling = true
    expect(() => toolState.senders[0]?.({ delegationId: taskId, channel: 'STATUS', message: 'x' }))
      .toThrow('is being cancelled')
    task.cancelling = false

    ;(taskAgent.steer as ReturnType<typeof vi.fn>).mockImplementationOnce(() => { throw 'steer unavailable' })
    await harness.voiceEvent(voice, {
      type: 'task.command',
      call: {
        id: VoiceCommandCallId('steer-failed'),
        command: { type: 'send_task_message', taskId, message: '<update&>' },
      },
    })
    expect(harness.completions.at(-1)?.result).toMatchObject({ code: 'backend_unavailable', message: 'steer unavailable' })

    ;(taskAgent.cancel as ReturnType<typeof vi.fn>).mockImplementationOnce(() => { throw new Error('cancel unavailable') })
    await harness.voiceEvent(voice, {
      type: 'task.command',
      call: { id: VoiceCommandCallId('cancel-failed'), command: { type: 'cancel_task', taskId } },
    })
    expect(harness.completions.at(-1)?.result).toMatchObject({ code: 'backend_unavailable', message: 'cancel unavailable' })
    await harness.voiceEvent(voice, {
      type: 'task.command',
      call: { id: VoiceCommandCallId('cancel-ok'), command: { type: 'cancel_task', taskId } },
    })
    await harness.voiceEvent(voice, {
      type: 'task.command',
      call: { id: VoiceCommandCallId('cancel-again'), command: { type: 'cancel_task', taskId } },
    })
    expect(harness.completions.at(-1)?.result).toMatchObject({ code: 'task_not_active' })

    await harness.voiceEvent(voice, {
      type: 'task.command',
      call: { id: VoiceCommandCallId('invalid'), command: { type: 'invalid' } } as unknown as TaskCommandCall,
    })
    expect(harness.warnings.length).toBeGreaterThan(0)
  })

  it('rejects unavailable task backends and cleans partial task creation', async () => {
    const noPersistence = makeHarness()
    const sessionId = SessionId('no-persistence')
    noPersistence.makeSession(sessionId)
    const voice = await noPersistence.open(sessionId, 'frontend-agent')
    await noPersistence.voiceEvent(voice, {
      type: 'task.command',
      call: {
        id: VoiceCommandCallId('no-persistence'),
        command: { type: 'realtime_delegation', input: 'task' },
      },
    })
    expect(noPersistence.completions.at(-1)?.result).toMatchObject({ code: 'backend_unavailable' })

    const missingSource = makeHarness()
    const missingId = SessionId('missing-source')
    const missingRecord = missingSource.makeSession(missingId)
    missingSource.agents.set(missingId, missingSource.makeAgent(missingRecord))
    const missingVoice = await missingSource.open(missingId, 'frontend-agent')
    missingSource.sessions.delete(missingId)
    await missingSource.voiceEvent(missingVoice, {
      type: 'task.command',
      call: {
        id: VoiceCommandCallId('missing-source'),
        command: { type: 'realtime_delegation', input: 'task' },
      },
    })
    expect(missingSource.completions.at(-1)?.result).toMatchObject({ code: 'backend_unavailable' })

    const missingTool = makeHarness()
    const toolId = SessionId('missing-tool')
    const toolRecord = missingTool.makeSession(toolId)
    missingTool.agents.set(toolId, missingTool.makeAgent(toolRecord))
    const toolVoice = await missingTool.open(toolId, 'frontend-agent')
    toolState.mode = 'missing'
    await missingTool.voiceEvent(toolVoice, {
      type: 'task.command',
      call: {
        id: VoiceCommandCallId('missing-tool'),
        command: { type: 'realtime_delegation', input: 'task' },
      },
    })
    expect(missingTool.handleDisposers[0]).toHaveBeenCalled()

    const attachFailure = makeHarness()
    const attachId = SessionId('attach-failure')
    const attachRecord = attachFailure.makeSession(attachId)
    attachFailure.agents.set(attachId, attachFailure.makeAgent(attachRecord))
    attachFailure.services.workspaceRegistry = {
      list: vi.fn(() => [{
        sessionIds: [attachId],
        attachSession: vi.fn(async () => { throw new Error('attach failed') }),
      }]),
    }
    const attachVoice = await attachFailure.open(attachId, 'frontend-agent')
    await attachFailure.voiceEvent(attachVoice, {
      type: 'task.command',
      call: {
        id: VoiceCommandCallId('attach-failure'),
        command: { type: 'realtime_delegation', input: 'task' },
      },
    })
    expect(attachFailure.handleDisposers[0]).toHaveBeenCalled()

    toolState.mode = 'normal'
    for (const [name, followupError, cleanupError] of [
      ['error-cleanup', new Error('followup error'), new Error('cleanup error')],
      ['string-cleanup', 'followup string', 'cleanup string'],
    ] as const) {
      const partial = makeHarness()
      const partialId = SessionId(name)
      const partialRecord = partial.makeSession(partialId)
      partial.agents.set(partialId, partial.makeAgent(partialRecord))
      const partialVoice = await partial.open(partialId, 'frontend-agent')
      partial.behavior.nextFollowup = { throws: true, error: followupError }
      toolState.nextDispose = { throws: true, error: cleanupError }
      await partial.voiceEvent(partialVoice, {
        type: 'task.command',
        call: {
          id: VoiceCommandCallId(name),
          command: { type: 'realtime_delegation', input: 'task' },
        },
      })
      expect(partial.completions.at(-1)?.result).toMatchObject({
        kind: 'rejected',
        code: 'backend_unavailable',
      })
      expect(partial.warnings).toHaveLength(1)
    }
  })

  it('bounds detached observations and reports enqueue cleanup failures', async () => {
    const harness = makeHarness({ maxPendingObservations: 1, failedAnnouncement: 'failed' })
    const sessionId = SessionId('pending')
    const record = harness.makeSession(sessionId)
    const agent = harness.makeAgent(record)
    harness.agents.set(sessionId, agent)
    const stale = sessionInfo(sessionId, 'frontend-agent', VoiceSessionId('stale'))
    await harness.dispatch('voice/session-event', stale, { type: 'closed' })
    const binding = harness.bindings.get(sessionId)
    if (binding === undefined) throw new Error('binding missing')

    for (const index of [1, 2]) {
      binding.active = {
        id: VoiceTaskId(`pending-${index}`),
        interactionMode: 'frontend-agent',
        taskSessionId: SessionId(`task-${index}`),
        messageIds: new Set(),
        agent,
        taskTurn: index,
        cancelling: false,
        waitingUser: false,
      }
      harness.taskBindings.set(binding.active.taskSessionId, binding)
      await harness.dispatch('session/event', {
        id: binding.active.taskSessionId,
      }, turnEnd(index, 'failed'))
    }
    expect(binding.pending).toHaveLength(1)
    const voice = await harness.open(sessionId, 'frontend-agent')
    expect(harness.observations).toHaveLength(1)

    toolState.nextDispose = { throws: true, error: 'dispose failed' }
    await startDelegation(harness, voice, 'will fail')
    const task = binding.active
    if (task === undefined) throw new Error('active task missing')
    harness.sessions.delete(sessionId)
    const message = (task.agent.followup as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as UserMessage
    await harness.dispatch('agent/inbox/claimed', { agent: task.agent, message, turn: 1 })
    await harness.dispatch('session/event', { id: task.taskSessionId }, turnEnd(1, 'completed'))
    expect(harness.warnings.length).toBeGreaterThanOrEqual(2)
    expect(binding.active).toBeUndefined()
  })

  it('defends against impossible command-state races through the registered handlers', async () => {
    const harness = makeHarness()
    const sessionId = SessionId('defensive')
    const record = harness.makeSession(sessionId)
    harness.agents.set(sessionId, harness.makeAgent(record))
    const voice = await harness.open(sessionId, 'frontend-agent')
    const taskId = await startDelegation(harness, voice)
    const binding = harness.bindings.get(sessionId)
    if (binding?.active === undefined) throw new Error('task missing')
    const task = binding.active

    let reads = 0
    Object.defineProperty(binding, 'active', {
      configurable: true,
      get: () => {
        reads += 1
        return reads === 1 ? task : undefined
      },
    })
    await harness.voiceEvent(voice, {
      type: 'task.command',
      call: {
        id: VoiceCommandCallId('defensive-message'),
        command: { type: 'send_task_message', taskId, message: 'message' },
      },
    })
    Object.defineProperty(binding, 'active', { configurable: true, writable: true, value: task })

    reads = 0
    Object.defineProperty(binding, 'active', {
      configurable: true,
      get: () => {
        reads += 1
        return reads === 1 ? task : undefined
      },
    })
    await harness.voiceEvent(voice, {
      type: 'task.command',
      call: {
        id: VoiceCommandCallId('defensive-cancel'),
        command: { type: 'cancel_task', taskId },
      },
    })
    expect(harness.warnings).toHaveLength(2)
  })

  it('aggregates active-tool and Agent-handle disposal failures', async () => {
    const harness = makeHarness()
    const sessionId = SessionId('cleanup-errors')
    const record = harness.makeSession(sessionId)
    harness.agents.set(sessionId, harness.makeAgent(record))
    const voice = await harness.open(sessionId, 'frontend-agent')
    toolState.nextDispose = { throws: true, error: new Error('tool dispose') }
    await startDelegation(harness, voice)
    const rejectedDispose = vi.fn(async () => { throw new Error('handle dispose') })
    harness.handles.set(SessionId('rejected-handle'), {
      agent: harness.makeAgent(harness.makeSession(SessionId('rejected-handle'))),
      dispose: rejectedDispose,
    })
    await expect(harness.cleanup?.()).rejects.toThrow('failed to dispose voice-assistant resources')
    expect(rejectedDispose).toHaveBeenCalled()
    expect(harness.bindings.size).toBe(0)
    expect(harness.taskBindings.size).toBe(0)
    expect(harness.handles.size).toBe(0)

    const clean = makeHarness()
    clean.makeSession(SessionId('clean'))
    await clean.open(SessionId('clean'), 'frontend-agent')
    await expect(clean.cleanup?.()).resolves.toBeUndefined()
  })
})
