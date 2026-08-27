/** Voice-to-Agent driver using ordinary followup, steer and cancel operations. @module @lgquan/dsh-voice-assistant */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import { foldRequestHeader, KNOWN_SESSION_EVENT_TYPES, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import {
  VoiceTaskId,
  VoiceTaskMessageId,
  type TaskCommandCall,
  type TaskCommandResult,
  type TaskObservation,
  type VoiceEvent,
  type VoiceConversationMemory,
  type VoiceInteractionMode,
  type VoiceResponseId,
  type VoiceSessionId,
  type VoiceSessionInfo,
  type VoiceTaskMessage,
  type VoiceUtteranceId,
} from '@lgquan/dsh-voice'
import { installVoiceMessageTool, type VoiceMessageInput, type VoiceMessageReceipt } from './tool.ts'

export const name = 'voice-assistant'
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'systemPrompt', 'tools', 'voice']

/** Driver configuration. */
export interface Config {
  /** Maximum observations queued for a voice session whose transport is currently detached. */
  readonly maxPendingObservations?: number
  /** Restore completed conversational utterances after a provider or DSH restart. */
  readonly restoreConversation?: boolean
  /** Maximum completed utterances restored as provider context; does not limit spoken reply length. */
  readonly maxRestoredUtterances?: number
  /** Whether frontend delegations use independent Agents or one durable conversational Agent. */
  readonly taskSessionPolicy?: 'isolated' | 'continuous'
  /** Spoken announcement for a completed task that produced no final backend message. */
  readonly completedAnnouncement?: string
  /** Spoken announcement for a failed task. */
  readonly failedAnnouncement?: string
  /** Spoken announcement for a cancelled task. */
  readonly cancelledAnnouncement?: string
}

export const Config: z<Config> = z.object({
  maxPendingObservations: z.natural().min(1).default(64),
  restoreConversation: z.boolean().default(true),
  maxRestoredUtterances: z.natural().min(1).default(24),
  taskSessionPolicy: z.union(['isolated', 'continuous']).default('isolated'),
  completedAnnouncement: z.string().default('任务已完成。'),
  failedAnnouncement: z.string().default('任务失败了，请查看屏幕上的错误信息。'),
  cancelledAnnouncement: z.string().default('任务已取消。'),
})

/** Plugin-owned durable session event types, registered with core at load. */
const VOICE_SESSION_EVENT_TYPES = [
  'voice/task-observation',
  'voice/task-delegated',
  'voice/task-session-bound',
  'voice/utterance-start',
  'voice/utterance-end',
] as const

interface ActiveTask {
  readonly id: VoiceTaskId
  readonly interactionMode: VoiceInteractionMode
  readonly taskSessionId: SessionId
  readonly messageIds: Set<string>
  agent: Agent
  taskTurn?: number
  lastAssistantMessage?: VoiceTaskMessage
  completionMessage?: VoiceTaskMessage
  completionDetail?: string
  disposeVoiceMessage?: () => void
  cancelling: boolean
  waitingUser: boolean
}

interface OpenUtterance {
  readonly role: 'user' | 'assistant'
  readonly responseId?: VoiceResponseId
  text: string
}

interface ContinuousTaskAgent {
  readonly taskSessionId: SessionId
  readonly agent: Agent
  readonly disposeVoiceMessage: () => void
}

interface Binding {
  readonly sessionId: SessionId
  agent?: Agent
  voiceSessionId: VoiceSessionId | undefined
  interactionMode: VoiceInteractionMode | undefined
  voiceAttached: boolean
  voiceTurnMarked: boolean
  active: ActiveTask | undefined
  continuousTaskAgent: ContinuousTaskAgent | undefined
  lastTerminalTaskId: VoiceTaskId | undefined
  recoveryDelivered: boolean
  readonly pending: TaskObservation[]
  readonly utterances: Map<VoiceUtteranceId, OpenUtterance>
  chain: Promise<void>
  rewriteGeneration: number
  rewriteAbort: AbortController | undefined
}

/** Install the driver. @param ctx - composed Agent and voice context. @param config - driver copy and queue bounds. */
export function apply(ctx: Context, config: Config = {}): void {
  const bindings = new Map<SessionId, Binding>()
  const taskBindings = new Map<SessionId, Binding>()
  const handles = new Map<SessionId, AgentHandle>()
  const maxPending = config.maxPendingObservations ?? 64
  const maxRestoredUtterances = config.maxRestoredUtterances ?? 24
  // DSH core recognizes only its own event vocabulary at read time and has no
  // generic "skippable plugin event" registration surface yet. A session that
  // carries these voice events would otherwise be refused on load, so register
  // them once at boot (the set is module-scoped and read by the persistence
  // coordinator). This is the load-side counterpart of the `declare module`
  // type merge; see the package README's responsibility-boundary note.
  const knownEventTypes = KNOWN_SESSION_EVENT_TYPES as unknown as Set<string>
  for (const type of VOICE_SESSION_EVENT_TYPES) knownEventTypes.add(type)

  const loadConversationMemory = async (sessionId: SessionId): Promise<VoiceConversationMemory | undefined> => {
    const live = ctx.sessions.get(sessionId)
    const events = live?.events ?? (await ctx.get('sessionPersistence')?.inspect(sessionId))?.events
    if (events === undefined) return undefined
    const items = events.flatMap(event => {
      if (event.type !== 'voice/utterance-end' || event.data.state !== 'completed') return []
      const text = event.data.text.trim()
      return text === '' ? [] : [{ role: event.data.role, text }]
    }).slice(-maxRestoredUtterances)
    return items.length === 0 ? undefined : { items }
  }
  const disposeMemorySource = config.restoreConversation === false
    ? undefined
    : ctx.voice.registerMemorySource(loadConversationMemory)

  const bindingFor = (sessionId: SessionId): Binding => {
    let binding = bindings.get(sessionId)
    if (binding === undefined) {
      const created: Binding = {
        sessionId,
        voiceSessionId: undefined,
        interactionMode: undefined,
        voiceAttached: false,
        voiceTurnMarked: false,
        active: undefined,
        continuousTaskAgent: undefined,
        lastTerminalTaskId: undefined,
        recoveryDelivered: false,
        pending: [],
        utterances: new Map(),
        chain: Promise.resolve(),
        rewriteGeneration: 0,
        rewriteAbort: undefined,
      }
      bindings.set(sessionId, created)
      return created
    }
    return binding
  }

  const append = (binding: Binding, observation: TaskObservation, speak: boolean, deliver = true): void => {
    const session = ctx.sessions.get(binding.sessionId)
    if (session === undefined) {
      throw new Error(`voice-assistant: Agent session "${binding.sessionId}" is not live`)
    }
    session.append('voice/task-observation', observation)
    const voiceId = binding.voiceSessionId
    if (voiceId === undefined || !binding.voiceAttached) {
      if (deliver) binding.pending.push(observation)
      if (binding.pending.length > maxPending) binding.pending.splice(0, binding.pending.length - maxPending)
      return
    }
    if (!deliver) return
    ctx.voice.appendTaskObservation(voiceId, observation)
    if (speak) ctx.voice.requestResponse(voiceId, { kind: 'automatic' })
  }

  const cancelRewrite = (binding: Binding): void => {
    binding.rewriteGeneration += 1
    binding.rewriteAbort?.abort()
    binding.rewriteAbort = undefined
  }

  const speakFragment = (binding: Binding, taskId: VoiceTaskId, text: string): void => {
    const voiceId = binding.voiceSessionId
    if (voiceId === undefined || !binding.voiceAttached || text.trim() === '') return
    if (ctx.voice.appendSpeechText(voiceId, text)) {
      ctx.voice.requestResponse(voiceId, { kind: 'automatic' })
      return
    }
    // Providers without the optional streaming face still receive a usable
    // response through the original observation protocol.
    ctx.voice.appendTaskObservation(voiceId, {
      taskId,
      status: 'running',
      voiceMessage: { id: VoiceTaskMessageId(randomUUID()), text },
    })
    ctx.voice.requestResponse(voiceId, { kind: 'automatic' })
  }

  const rewriteAndSpeak = async (binding: Binding, taskId: VoiceTaskId, original: string): Promise<void> => {
    const llm = ctx.get('llm') as LlmRuntime | undefined
    const voiceId = binding.voiceSessionId
    if (llm === undefined || voiceId === undefined || !binding.voiceAttached) return
    cancelRewrite(binding)
    const generation = binding.rewriteGeneration
    const abort = new AbortController()
    binding.rewriteAbort = abort
    const selection = ctx.agentDefaultModel.currentSelection()
    const prompt = [
      '请把下面的 Agent 工作结果改写成自然、简洁、口语化的中文语音回复。',
      '只输出要朗读的内容，不要 Markdown、表格、代码、链接或项目符号。',
      '保留关键结论、完成情况和必要的下一步；不要虚构信息。',
      '如果内容很长，优先概括，详细结果已经显示在屏幕上。',
      '',
      original,
    ].join('\n')
    const message = createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'plugin', plugin: 'voice-assistant' } })
    let buffer = ''
    let emitted = false
    try {
      for await (const chunk of llm.stream({
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
        messages: [message],
        system: '你是语音回复改写器。输出短句，像自然对话一样。',
        maxTokens: 512,
        signal: abort.signal,
      })) {
        if (generation !== binding.rewriteGeneration || abort.signal.aborted) return
        if (chunk.type !== 'text-delta') continue
        buffer += chunk.text
        const split = speechFragments(buffer, false)
        buffer = split.rest
        for (const fragment of split.fragments) {
          emitted = true
          speakFragment(binding, taskId, fragment)
        }
      }
      const final = speechFragments(buffer, true)
      if (final.rest.trim() !== '') final.fragments.push(final.rest.trim())
      for (const fragment of final.fragments) {
        emitted = true
        speakFragment(binding, taskId, fragment)
      }
      if (!emitted) speakFragment(binding, taskId, fallbackSpeechText(original))
    } catch (error: unknown) {
      if (!abort.signal.aborted && generation === binding.rewriteGeneration) {
        ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
        speakFragment(binding, taskId, fallbackSpeechText(original))
      }
    } finally {
      if (binding.rewriteAbort === abort) binding.rewriteAbort = undefined
    }
  }

  const enqueue = (binding: Binding, operation: () => Promise<void> | void): void => {
    binding.chain = binding.chain.then(operation).catch((error: unknown) => {
      ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      const task = binding.active
      if (task === undefined) return
      try {
        append(binding, {
          taskId: task.id,
          status: 'failed',
          ...(task.taskTurn === undefined ? {} : { taskTurn: task.taskTurn }),
          announcement: config.failedAnnouncement ?? '任务失败了，请查看屏幕上的错误信息。',
          reason: String(error),
        }, true)
      } catch (observationError: unknown) {
        ctx.logger.warn(observationError instanceof Error ? observationError : new Error(String(observationError)))
      } finally {
        taskBindings.delete(task.taskSessionId)
        try { task.disposeVoiceMessage?.() } catch (disposeError: unknown) {
          ctx.logger.warn(disposeError instanceof Error ? disposeError : new Error(String(disposeError)))
        }
        binding.lastTerminalTaskId = task.id
        binding.active = undefined
      }
    })
  }

  const sendVoiceMessage = (binding: Binding, input: VoiceMessageInput): VoiceMessageReceipt => {
    const task = binding.active
    if (task === undefined) throw new Error(`voice delegation "${input.delegationId}" is not active`)
    if (task.id !== input.delegationId) {
      throw new Error(`voice delegation "${input.delegationId}" does not match active delegation "${task.id}"`)
    }
    if (task.interactionMode !== 'frontend-agent') {
      throw new Error(`voice delegation "${task.id}" does not accept backend voice messages`)
    }
    if (task.cancelling) throw new Error(`voice delegation "${task.id}" is being cancelled`)
    const type = input.type ?? (input.channel === 'COMPLETE' ? 'result' : 'progress')
    const detail = input.detail ?? input.message
    const voiceHint = input.voiceHint ?? input.message
    const message = { id: VoiceTaskMessageId(randomUUID()), text: voiceHint }
    if (type === 'result') {
      if (task.completionMessage !== undefined) {
        throw new Error(`voice delegation "${task.id}" already has a COMPLETE message`)
      }
      task.completionMessage = message
      task.completionDetail = detail
      task.waitingUser = false
      return { messageId: message.id, delivery: 'held_until_turn_end' }
    }
    if (task.completionMessage !== undefined) {
      throw new Error(`voice delegation "${task.id}" already has a COMPLETE message`)
    }
    append(binding, {
      taskId: task.id,
      status: type === 'question' ? 'waiting-user' : 'running',
      ...(task.taskTurn === undefined ? {} : { taskTurn: task.taskTurn }),
      channel: 'STATUS',
      type,
      detail,
      voiceHint,
      voiceMessage: message,
    }, true)
    if (type === 'question') task.waitingUser = true
    return { messageId: message.id, delivery: 'queued' }
  }

  const ensureAgent = async (binding: Binding): Promise<Agent> => {
    const live = ctx.agents.get(binding.sessionId)
    if (live !== undefined) {
      binding.agent = live
      return live
    }
    if (binding.agent !== undefined) return binding.agent
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) throw new Error(`voice-assistant: Agent session "${binding.sessionId}" is not live and persistence is unavailable`)
    const inspected = await persistence.inspect(binding.sessionId)
    const header = foldRequestHeader(inspected.events)
    const defaults = ctx.agentDefaultModel.currentSelection()
    const presetId = resolveSessionPreset({ header: inspected.meta, events: inspected.events })
    const presets = ctx.get('agentPresets')
    const handle = await ctx.agents.resume({
      resumeSessionId: binding.sessionId,
      agentOptions: {
        provider: header?.config.provider ?? defaults.provider,
        model: header?.config.model ?? defaults.model,
      },
      ...(presets === undefined ? {} : { setup: async (agentCtx: Context) => { await presets.mount(agentCtx, presetId) } }),
    })
    handles.set(binding.sessionId, handle)
    binding.agent = handle.agent
    return handle.agent
  }

  const createTaskAgent = async (binding: Binding, taskSessionId: SessionId): Promise<{
    readonly agent: Agent
    readonly disposeVoiceMessage: () => void
  }> => {
    const sourceAgent = await ensureAgent(binding)
    const sourceSession = ctx.sessions.get(binding.sessionId)
    if (sourceSession === undefined) {
      throw new Error(`voice-assistant: source session "${binding.sessionId}" is not live`)
    }
    const defaults = ctx.agentDefaultModel.currentSelection()
    const header = foldRequestHeader(sourceSession.events)
    const presetId = resolveSessionPreset(sourceSession)
    const presets = ctx.get('agentPresets')
    let disposeVoiceMessage: (() => void) | undefined
    const handle = await ctx.agents.create({
      sessionId: taskSessionId,
      meta: {
        ...(sourceSession.header.cwd === undefined ? {} : { cwd: sourceSession.header.cwd }),
        ...(presetId === undefined ? {} : { agentPreset: presetId }),
      },
      agentOptions: {
        provider: sourceAgent.options.provider ?? header?.config.provider ?? defaults.provider,
        model: sourceAgent.options.model ?? header?.config.model ?? defaults.model,
      },
      setup: (agentCtx: Context) => {
        presets?.composeFrom(agentCtx, sourceAgent.ctx)
        disposeVoiceMessage = installVoiceMessageTool(agentCtx, input => sendVoiceMessage(binding, input))
      },
    })
    handles.set(taskSessionId, handle)
    try {
      const workspace = ctx.get('workspaceRegistry')?.list()
        .find(candidate => candidate.sessionIds.includes(binding.sessionId))
      await workspace?.attachSession(taskSessionId)
    } catch (error: unknown) {
      handles.delete(taskSessionId)
      await handle.dispose()
      throw error
    }
    if (disposeVoiceMessage === undefined) {
      handles.delete(taskSessionId)
      await handle.dispose()
      throw new Error('voice-assistant: delegated Agent setup did not install send_voice_message')
    }
    return { agent: handle.agent, disposeVoiceMessage }
  }

  const resumeTaskAgent = async (binding: Binding, taskSessionId: SessionId): Promise<{
    readonly agent: Agent
    readonly disposeVoiceMessage: () => void
  }> => {
    const live = ctx.agents.get(taskSessionId)
    if (live !== undefined) {
      return {
        agent: live,
        disposeVoiceMessage: installVoiceMessageTool(live.ctx, input => sendVoiceMessage(binding, input)),
      }
    }
    const sourceAgent = await ensureAgent(binding)
    const defaults = ctx.agentDefaultModel.currentSelection()
    const presets = ctx.get('agentPresets')
    let disposeVoiceMessage: (() => void) | undefined
    const handle = await ctx.agents.resume({
      resumeSessionId: taskSessionId,
      agentOptions: {
        provider: sourceAgent.options.provider ?? defaults.provider,
        model: sourceAgent.options.model ?? defaults.model,
      },
      setup: (agentCtx: Context) => {
        presets?.composeFrom(agentCtx, sourceAgent.ctx)
        disposeVoiceMessage = installVoiceMessageTool(agentCtx, input => sendVoiceMessage(binding, input))
      },
    })
    handles.set(taskSessionId, handle)
    if (disposeVoiceMessage === undefined) {
      handles.delete(taskSessionId)
      await handle.dispose()
      throw new Error('voice-assistant: resumed delegated Agent did not install send_voice_message')
    }
    return { agent: handle.agent, disposeVoiceMessage }
  }

  const ensureContinuousTaskAgent = async (binding: Binding): Promise<ContinuousTaskAgent> => {
    if (binding.continuousTaskAgent !== undefined) return binding.continuousTaskAgent
    const sourceSession = requireSourceSession(binding)
    const previousBound = sourceSession.events.findLast(event => event.type === 'voice/task-session-bound')
    const previousDelegation = sourceSession.events.findLast(event => event.type === 'voice/task-delegated')
    const previousTaskSessionId = previousBound?.type === 'voice/task-session-bound'
      ? previousBound.data.taskSessionId
      : previousDelegation?.type === 'voice/task-delegated'
        ? previousDelegation.data.taskSessionId
        : undefined
    if (previousTaskSessionId !== undefined) {
      try {
        const resumed = await resumeTaskAgent(binding, previousTaskSessionId)
        const resource = { taskSessionId: previousTaskSessionId, ...resumed }
        binding.continuousTaskAgent = resource
        taskBindings.set(resource.taskSessionId, binding)
        return resource
      } catch (error: unknown) {
        ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      }
    }
    const taskSessionId = SessionId(`session-${randomUUID()}`)
    const created = await createTaskAgent(binding, taskSessionId)
    sourceSession.append('voice/task-session-bound', { taskSessionId })
    const resource = { taskSessionId, ...created }
    binding.continuousTaskAgent = resource
    taskBindings.set(taskSessionId, binding)
    return resource
  }

  const requireSourceSession = (binding: Binding) => {
    const session = ctx.sessions.get(binding.sessionId)
    if (session === undefined) {
      throw new Error(`voice-assistant: source session "${binding.sessionId}" is not live`)
    }
    return session
  }

  // A frontend-agent voice conversation runs its text work in independent task
  // sessions, so its source session would otherwise carry no `turn/start` and be
  // treated as a reusable blank session by the workspace new-session flow. Mark
  // it with one complete empty turn the first time it gains conversation content.
  const markVoiceTurn = (binding: Binding): void => {
    if (binding.interactionMode !== 'frontend-agent' || binding.voiceTurnMarked) return
    const session = requireSourceSession(binding)
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    binding.voiceTurnMarked = true
  }

  const beginUtterance = (
    binding: Binding,
    utteranceId: VoiceUtteranceId,
    role: 'user' | 'assistant',
    responseId?: VoiceResponseId,
  ): OpenUtterance => {
    const existing = binding.utterances.get(utteranceId)
    if (existing !== undefined) {
      if (existing.role !== role || existing.responseId !== responseId) {
        throw new Error(`voice utterance "${utteranceId}" was reused with different metadata`)
      }
      return existing
    }
    const utterance: OpenUtterance = {
      role,
      text: '',
      ...(responseId === undefined ? {} : { responseId }),
    }
    binding.utterances.set(utteranceId, utterance)
    markVoiceTurn(binding)
    requireSourceSession(binding).append('voice/utterance-start', {
      utteranceId,
      role,
      ...(responseId === undefined ? {} : { responseId }),
    })
    return utterance
  }

  const appendUtteranceDelta = (
    binding: Binding,
    utteranceId: VoiceUtteranceId,
    role: 'user' | 'assistant',
    text: string,
    responseId?: VoiceResponseId,
  ): void => {
    beginUtterance(binding, utteranceId, role, responseId).text += text
  }

  const endUtterance = (
    binding: Binding,
    utteranceId: VoiceUtteranceId,
    role: 'user' | 'assistant',
    state: 'completed' | 'interrupted',
    finalText?: string,
    responseId?: VoiceResponseId,
  ): void => {
    const utterance = beginUtterance(binding, utteranceId, role, responseId)
    requireSourceSession(binding).append('voice/utterance-end', {
      utteranceId,
      role,
      text: finalText ?? utterance.text,
      state,
      ...(responseId === undefined ? {} : { responseId }),
    })
    binding.utterances.delete(utteranceId)
  }

  const interruptAssistantUtterances = (binding: Binding, responseId?: VoiceResponseId): void => {
    for (const [utteranceId, utterance] of binding.utterances) {
      if (utterance.role !== 'assistant') continue
      if (responseId !== undefined && utterance.responseId !== responseId) continue
      endUtterance(binding, utteranceId, 'assistant', 'interrupted', undefined, utterance.responseId)
    }
  }

  const interruptAllUtterances = (binding: Binding): void => {
    for (const [utteranceId, utterance] of binding.utterances) {
      endUtterance(binding, utteranceId, utterance.role, 'interrupted', undefined, utterance.responseId)
    }
  }

  const onTranscription = async (binding: Binding, text: string): Promise<void> => {
    const trimmed = text.trim()
    if (trimmed === '') return
    const agent = await ensureAgent(binding)
    const message = createUserMessage({ content: [{ type: 'text', text: trimmed }], source: { kind: 'user' as const } })
    if (binding.active === undefined) {
      const task: ActiveTask = {
        id: VoiceTaskId(randomUUID()),
        interactionMode: 'speech-shell',
        taskSessionId: binding.sessionId,
        messageIds: new Set([message.id]),
        agent,
        cancelling: false,
        waitingUser: false,
      }
      binding.active = task
      taskBindings.set(task.taskSessionId, binding)
      append(binding, { taskId: task.id, status: 'accepted' }, false)
      agent.followup(message)
      return
    }
    binding.active.messageIds.add(message.id)
    append(binding, {
      taskId: binding.active.id,
      status: 'accepted',
      ...(binding.active.taskTurn === undefined ? {} : { taskTurn: binding.active.taskTurn }),
    }, false)
    agent.steer(message)
  }

  const onTaskCommand = async (
    binding: Binding,
    voiceSessionId: VoiceSessionId,
    call: TaskCommandCall,
  ): Promise<void> => {
    const complete = (result: TaskCommandResult): void => {
      ctx.voice.completeTaskCommand(voiceSessionId, call.id, result)
    }
    const backendUnavailable = (error: unknown): void => {
      complete({ kind: 'rejected', code: 'backend_unavailable', message: error instanceof Error ? error.message : String(error) })
    }
    switch (call.command.type) {
      case 'realtime_delegation': {
        if (binding.active !== undefined) {
          complete({ kind: 'rejected', code: 'task_active', message: `task "${binding.active.id}" is still active` })
          return
        }
        const taskId = VoiceTaskId(randomUUID())
        const continuous = (config.taskSessionPolicy ?? 'isolated') === 'continuous'
        let created: Awaited<ReturnType<typeof createTaskAgent>> & { readonly taskSessionId: SessionId }
        try {
          if (continuous) {
            created = await ensureContinuousTaskAgent(binding)
          } else {
            const taskSessionId = SessionId(`session-${randomUUID()}`)
            created = { taskSessionId, ...await createTaskAgent(binding, taskSessionId) }
          }
        } catch (error) { backendUnavailable(error); return }
        const message = createUserMessage({
          content: [{ type: 'text', text: renderRealtimeDelegation(taskId, call.command.input, call.command.transcriptDelta) }],
          source: { kind: 'user' },
        })
        const task: ActiveTask = {
          id: taskId,
          interactionMode: 'frontend-agent',
          taskSessionId: created.taskSessionId,
          messageIds: new Set([message.id]),
          agent: created.agent,
          ...(continuous ? {} : { disposeVoiceMessage: created.disposeVoiceMessage }),
          cancelling: false,
          waitingUser: false,
        }
        binding.active = task
        taskBindings.set(created.taskSessionId, binding)
        try {
          requireSourceSession(binding).append('voice/task-delegated', {
            taskId,
            taskSessionId: created.taskSessionId,
            input: call.command.input,
          })
          created.agent.followup(message)
        } catch (error) {
          if (!continuous) taskBindings.delete(created.taskSessionId)
          binding.active = undefined
          try { task.disposeVoiceMessage?.() } catch (cleanupError: unknown) {
            ctx.logger.warn(cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)))
          }
          try {
            append(binding, {
              taskId,
              status: 'failed',
              announcement: config.failedAnnouncement ?? '任务失败了，请查看屏幕上的错误信息。',
              reason: error instanceof Error ? error.message : String(error),
            }, true)
          } finally {
            backendUnavailable(error)
          }
          return
        }
        complete({ kind: 'accepted', taskId: task.id })
        append(binding, { taskId: task.id, status: 'queued' }, false)
        return
      }
      case 'send_task_message': {
        const rejection = taskRejection(binding, call.command.taskId)
        if (rejection !== undefined) { complete(rejection); return }
        const task = binding.active
        if (task === undefined) throw new Error('voice-assistant task state changed during command dispatch')
        const message = createUserMessage({
          content: [{ type: 'text', text: renderRealtimeDelegationUpdate(task.id, call.command.message) }],
          source: { kind: 'plugin', plugin: 'voice-assistant' },
        })
        task.messageIds.add(message.id)
        const waitingForReply = task.waitingUser && task.taskTurn === undefined
        task.waitingUser = false
        try {
          if (waitingForReply) task.agent.followup(message)
          else task.agent.steer(message)
        } catch (error) {
          task.messageIds.delete(message.id)
          task.waitingUser = waitingForReply
          backendUnavailable(error)
          return
        }
        complete({ kind: 'accepted', taskId: task.id })
        append(binding, {
          taskId: task.id,
          status: 'queued',
          ...(task.taskTurn === undefined ? {} : { taskTurn: task.taskTurn }),
        }, false)
        return
      }
      case 'cancel_task': {
        const rejection = taskRejection(binding, call.command.taskId)
        if (rejection !== undefined) { complete(rejection); return }
        const task = binding.active
        if (task === undefined) throw new Error('voice-assistant task state changed during command dispatch')
        task.cancelling = true
        if (task.waitingUser && task.taskTurn === undefined) {
          complete({ kind: 'accepted', taskId: task.id })
          append(binding, {
            taskId: task.id,
            status: 'cancelled',
            announcement: config.cancelledAnnouncement ?? '任务已取消。',
          }, true)
          const disposeVoiceMessage = task.disposeVoiceMessage
          delete task.disposeVoiceMessage
          binding.lastTerminalTaskId = task.id
          binding.active = undefined
          if ((config.taskSessionPolicy ?? 'isolated') === 'isolated') taskBindings.delete(task.taskSessionId)
          try { disposeVoiceMessage?.() } catch (error: unknown) {
            ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
          }
          return
        }
        try { task.agent.cancel({ kind: 'user' }) } catch (error) { task.cancelling = false; backendUnavailable(error); return }
        complete({ kind: 'accepted', taskId: task.id })
        return
      }
      default: assertNever(call.command)
    }
  }

  ctx.on('voice/session-opened', (session) => {
    const binding = bindingFor(session.agentSessionId)
    binding.voiceSessionId = session.id
    binding.interactionMode = session.interactionMode
    binding.voiceAttached = true
    enqueue(binding, async () => {
      if (session.interactionMode === 'speech-shell') await ensureAgent(binding)
      if (binding.voiceSessionId !== session.id) return
      if (!binding.recoveryDelivered) {
        const lastObservation = requireSourceSession(binding).events.findLast(event => event.type === 'voice/task-observation')
        if (lastObservation?.type === 'voice/task-observation' && lastObservation.data.status === 'interrupted') {
          binding.recoveryDelivered = true
          ctx.voice.appendTaskObservation(session.id, lastObservation.data)
          ctx.voice.requestResponse(session.id, { kind: 'automatic' })
        }
      }
      if (binding.pending.length !== 0) {
        const observations = binding.pending.splice(0)
        for (const observation of observations) ctx.voice.appendTaskObservation(session.id, observation)
        if (observations.some(isTerminalObservation)) {
          ctx.voice.requestResponse(session.id, { kind: 'automatic' })
        }
      }
    })
  })

  ctx.on('voice/session-detached', (session) => {
    const binding = bindings.get(session.agentSessionId)
    if (binding?.voiceSessionId !== session.id) return
    binding.voiceAttached = false
    cancelRewrite(binding)
    enqueue(binding, () => { interruptAllUtterances(binding) })
  })

  ctx.on('voice/session-closed', (session) => {
    const binding = bindings.get(session.agentSessionId)
    if (binding?.voiceSessionId !== session.id) return
    binding.voiceSessionId = undefined
    binding.interactionMode = undefined
    binding.voiceAttached = false
    cancelRewrite(binding)
    enqueue(binding, () => { interruptAllUtterances(binding) })
  })

  ctx.on('voice/session-event', (session: VoiceSessionInfo, event: VoiceEvent) => {
    const binding = bindingFor(session.agentSessionId)
    if (binding.voiceSessionId !== session.id) return
    switch (event.type) {
      case 'transcription.started':
        enqueue(binding, () => { beginUtterance(binding, event.utteranceId, 'user') })
        return
      case 'transcription.updated':
        enqueue(binding, () => { beginUtterance(binding, event.utteranceId, 'user').text = event.text })
        return
      case 'transcription.completed':
        enqueue(binding, async () => {
          endUtterance(binding, event.utteranceId, 'user', 'completed', event.text)
          if (session.interactionMode === 'speech-shell' && binding.voiceSessionId === session.id) {
            await onTranscription(binding, event.text)
          }
        })
        return
      case 'transcription.failed':
        enqueue(binding, () => { endUtterance(binding, event.utteranceId, 'user', 'interrupted') })
        return
      case 'output_text.started':
        enqueue(binding, () => { beginUtterance(binding, event.utteranceId, 'assistant', event.responseId) })
        return
      case 'output_text.delta':
        enqueue(binding, () => {
          appendUtteranceDelta(binding, event.utteranceId, 'assistant', event.text, event.responseId)
        })
        return
      case 'output_text.done':
        enqueue(binding, () => {
          endUtterance(binding, event.utteranceId, 'assistant', 'completed', event.text, event.responseId)
        })
        return
      case 'response.interrupted':
        enqueue(binding, () => { interruptAssistantUtterances(binding, event.responseId) })
        return
      case 'task.command':
        if (session.interactionMode === 'frontend-agent') {
          enqueue(binding, () => binding.voiceSessionId === session.id
            ? onTaskCommand(binding, session.id, event.call)
            : undefined)
        }
        return
      case 'output_audio.started':
      case 'output_audio.delta':
      case 'output_audio.done':
      case 'task.observation':
      case 'error':
      case 'closed':
        return
      default:
        assertNever(event)
    }
  })

  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    const binding = taskBindings.get(agent.id)
    if (binding === undefined) return
    enqueue(binding, () => {
      const task = binding.active
      if (task === undefined || task.agent !== agent || !task.messageIds.has(message.id)) return
      task.taskTurn = turn
      append(binding, { taskId: task.id, status: 'running', taskTurn: turn }, false)
    })
  })

  ctx.on('session/event', (session, event) => {
    const binding = taskBindings.get(session.id)
    if (binding === undefined) return
    let hasLlm = false
    try { hasLlm = ctx.get('llm') !== undefined } catch { hasLlm = false }
    const deliverAssistantSpeech = !hasLlm || !ctx.voice.supportsSpeechText(binding.voiceSessionId!)
    enqueue(binding, () => {
      if (observeSessionEvent(binding, event, append, config, (error) => {
        ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      }, (task, text) => {
        if (deliverAssistantSpeech) {
          ctx.voice.requestResponse(binding.voiceSessionId!, { kind: 'automatic' })
        } else {
          void rewriteAndSpeak(binding, task.id, text)
        }
      }, deliverAssistantSpeech)) {
        if ((config.taskSessionPolicy ?? 'isolated') === 'isolated') taskBindings.delete(session.id)
      }
    })
  })

  ctx.effect(() => async () => {
    await Promise.all([...bindings.values()].map(binding => binding.chain))
    const failures: unknown[] = []
    try {
      disposeMemorySource?.()
    } catch (error: unknown) {
      failures.push(error)
    }
    for (const binding of bindings.values()) {
      const task = binding.active
      const disposers = [task?.disposeVoiceMessage, binding.continuousTaskAgent?.disposeVoiceMessage]
      if (task !== undefined) {
        try {
          append(binding, {
            taskId: task.id,
            status: 'interrupted',
            ...(task.taskTurn === undefined ? {} : { taskTurn: task.taskTurn }),
            reason: 'voice-assistant service stopped before the task finished',
          }, false, false)
          binding.lastTerminalTaskId = task.id
          binding.active = undefined
        } catch (error: unknown) {
          failures.push(error)
        }
      }
      if (binding.active !== undefined) delete binding.active.disposeVoiceMessage
      binding.continuousTaskAgent = undefined
      for (const dispose of disposers) {
        try {
          dispose?.()
        } catch (error: unknown) {
          failures.push(error)
        }
      }
    }
    const settled = await Promise.allSettled([...handles.values()].map(handle => handle.dispose()))
    for (const result of settled) {
      if (result.status === 'rejected') failures.push(result.reason)
    }
    bindings.clear()
    taskBindings.clear()
    handles.clear()
    if (failures.length > 0) throw new AggregateError(failures, 'failed to dispose voice-assistant resources')
  }, 'voice-assistant lifecycle')
}

function isTerminalObservation(observation: TaskObservation): boolean {
  return observation.status === 'completed'
    || observation.status === 'failed'
    || observation.status === 'cancelled'
    || observation.status === 'interrupted'
}

function speechFragments(text: string, flush: boolean): { fragments: string[]; rest: string } {
  const fragments: string[] = []
  let rest = text
  while (true) {
    const match = /[。！？!?；;]/u.exec(rest)
    if (match === null || match.index === undefined) break
    const end = match.index + match[0].length
    fragments.push(rest.slice(0, end).trim())
    rest = rest.slice(end)
  }
  if (!flush && rest.length >= 36) {
    const comma = Math.max(rest.lastIndexOf('，', 36), rest.lastIndexOf(',', 36))
    if (comma >= 12) {
      fragments.push(rest.slice(0, comma + 1).trim())
      rest = rest.slice(comma + 1)
    }
  }
  return { fragments: fragments.filter(Boolean), rest }
}

function fallbackSpeechText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/gu, '详细代码已经显示在屏幕上。')
    .replace(/\|[^\n]+\|/gu, ' ')
    .replace(/!?(?:\[[^\]]*\])?\([^)]*\)/gu, ' ')
    .replace(/[#>*_`~-]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

function observeSessionEvent(
  binding: Binding,
  event: SessionEvent,
  append: (binding: Binding, observation: TaskObservation, speak: boolean, deliver?: boolean) => void,
  config: Config,
  onDisposeError: (error: unknown) => void,
  rewrite: (task: ActiveTask, text: string) => void,
  deliverAssistantSpeech: boolean,
): boolean {
  const task = binding.active
  if (task === undefined || task.taskTurn === undefined) return false
  if (event.type === 'assistant/message' && event.data.turn === task.taskTurn) {
    const text = event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('').trim()
    if (text !== '') {
      const message = { id: VoiceTaskMessageId(event.data.message.id), text }
      task.lastAssistantMessage = message
      if (task.interactionMode === 'speech-shell') {
        append(binding, { taskId: task.id, status: 'running', taskTurn: task.taskTurn, voiceMessage: message }, false, deliverAssistantSpeech)
        rewrite(task, text)
      }
    }
    return false
  }
  if (event.type !== 'turn/end' || event.data.turn !== task.taskTurn) return false
  const status = terminalStatus(event.data.reason.kind)
  if (status === 'completed' && task.waitingUser && task.completionMessage === undefined) {
    delete task.taskTurn
    delete task.lastAssistantMessage
    return false
  }
  const message = status === 'completed' && task.interactionMode === 'frontend-agent'
    ? task.completionMessage
    : undefined
  const hasCompletedOutput = task.interactionMode === 'frontend-agent'
    ? message !== undefined
    : task.lastAssistantMessage !== undefined
  const announcement = status === 'completed'
    ? hasCompletedOutput ? undefined : config.completedAnnouncement ?? '任务已完成。'
    : status === 'cancelled'
      ? config.cancelledAnnouncement ?? '任务已取消。'
      : config.failedAnnouncement ?? '任务失败了，请查看屏幕上的错误信息。'
  append(binding, {
    taskId: task.id,
    status,
    taskTurn: task.taskTurn,
    ...(message === undefined ? {} : {
      channel: 'COMPLETE' as const,
      type: 'result' as const,
      detail: task.completionDetail ?? message.text,
      voiceHint: message.text,
      voiceMessage: message,
    }),
    ...(announcement === undefined ? {} : { announcement }),
    ...(status === 'failed' ? { reason: event.data.reason.kind } : {}),
  }, task.interactionMode === 'frontend-agent' || announcement !== undefined)
  const disposeVoiceMessage = task.disposeVoiceMessage
  delete task.disposeVoiceMessage
  binding.lastTerminalTaskId = task.id
  binding.active = undefined
  try {
    disposeVoiceMessage?.()
  } catch (error: unknown) {
    onDisposeError(error)
  }
  return true
}

function taskRejection(binding: Binding, taskId: VoiceTaskId): TaskCommandResult | undefined {
  const active = binding.active
  if (active === undefined) {
    return binding.lastTerminalTaskId === taskId
      ? { kind: 'rejected', code: 'task_not_active', message: `task "${taskId}" is terminal` }
      : { kind: 'rejected', code: 'task_not_found', message: `task "${taskId}" is not known` }
  }
  if (active.id !== taskId) return { kind: 'rejected', code: 'task_not_found', message: `task "${taskId}" is not active` }
  if (active.cancelling) return { kind: 'rejected', code: 'task_not_active', message: `task "${taskId}" is being cancelled` }
  return undefined
}

function renderRealtimeDelegation(taskId: VoiceTaskId, input: string, transcriptDelta?: string): string {
  return [
    '<realtime_delegation>',
    `  <delegation_id>${escapeXmlText(taskId)}</delegation_id>`,
    `  <input>${escapeXmlText(input)}</input>`,
    ...(transcriptDelta === undefined
      ? []
      : [`  <transcript_delta>${escapeXmlText(transcriptDelta)}</transcript_delta>`]),
    '</realtime_delegation>',
  ].join('\n')
}

function renderRealtimeDelegationUpdate(taskId: VoiceTaskId, message: string): string {
  return [
    '<realtime_delegation_update>',
    `  <delegation_id>${escapeXmlText(taskId)}</delegation_id>`,
    `  <message>${escapeXmlText(message)}</message>`,
    '</realtime_delegation_update>',
  ].join('\n')
}

function escapeXmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function terminalStatus(reason: string): 'completed' | 'failed' | 'cancelled' {
  if (reason === 'completed') return 'completed'
  if (reason === 'aborted') return 'cancelled'
  return 'failed'
}

function assertNever(value: never): never {
  throw new Error(`unexpected task command: ${JSON.stringify(value)}`)
}
