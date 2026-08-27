import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import { CallId, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import VoiceRuntime, {
  VoiceCommandCallId,
  VoiceResponseId,
  VoiceTaskId,
  VoiceUtteranceId,
  type TaskCommandResult,
  type TaskObservation,
  type VoiceProviderEvent,
  type VoiceProviderSession,
} from '@lgquan/dsh-voice'
import { apply, inject } from '@lgquan/dsh-voice-assistant'
import { describe, expect, it, vi } from 'vitest'

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  await new Promise<void>((resolve) => { setImmediate(resolve) })
}

interface CreatedAgent {
  readonly agent: Agent
  readonly session: ReturnType<Context['sessions']['create']>
  readonly followup: ReturnType<typeof vi.fn<(message: UserMessage) => void>>
  readonly steer: ReturnType<typeof vi.fn<(message: UserMessage) => void>>
  readonly cancel: ReturnType<typeof vi.fn>
}

function installAgentFactory(ctx: Context, configure?: (created: CreatedAgent) => void): CreatedAgent[] {
  const created: CreatedAgent[] = []
  ctx.agents.setFactory({
    async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
      const session = ctx.sessions.create(options.sessionId, {
        ...(options.meta === undefined ? {} : { meta: options.meta }),
      })
      const followup = vi.fn<(message: UserMessage) => void>()
      const steer = vi.fn<(message: UserMessage) => void>()
      const cancel = vi.fn()
      const agent = {} as Agent
      void ownerCtx
      const agentCtx = ctx.extend({ agent })
      Object.assign(agent, {
        id: session.id,
        options: options.agentOptions ?? {},
        session,
        inbox: {} as Agent['inbox'],
        status: 'idle',
        ctx: agentCtx,
        cancel,
        whenIdle: () => Promise.resolve(),
        runMaintenance: () => Promise.reject(new Error('not used')),
        send: () => {},
        steer,
        inject: () => {},
        followup,
      } satisfies Partial<Agent>)
      const commit = await options.setup?.(agentCtx)
      commit?.commit()
      const dispose = ctx.agents.register(agent)
      const item = { agent, session, followup, steer, cancel }
      created.push(item)
      configure?.(item)
      return { agent, dispose: async () => { dispose() } }
    },
    resume: () => Promise.reject(new Error('not used')),
  })
  return created
}

describe('voice assistant driver', () => {
  it('binds the claimed message to its exact turn and speaks logged assistant output', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentDefaultModel, { provider: 'test', model: 'test' })
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(VoiceRuntime, { provider: 'test' })
    const observations: TaskObservation[] = []
    const requestResponse = vi.fn()
    let emit: ((event: VoiceProviderEvent) => void) | undefined
    const providerSession: VoiceProviderSession = {
      audio: { inputSampleRate: 16_000, outputSampleRate: 24_000, format: 'pcm_s16le' },
      interactionMode: 'speech-shell',
      appendAudio: () => {}, commitAudio: () => {}, interruptResponse: () => {}, playbackEnded: () => {},
      appendTaskObservation: (event) => { observations.push(event) },
      requestResponse,
      completeTaskCommand: () => {},
      close: () => Promise.resolve(),
    }
    ctx.voice.registerProvider({
      id: 'test', available: () => true,
      connect: (input) => { emit = input.emit; return Promise.resolve(providerSession) },
    })

    const session = ctx.sessions.create(SessionId('voice-agent'))
    const agent = {
      id: session.id,
      options: { provider: 'test', model: 'test' },
      session,
      inbox: {} as Agent['inbox'],
      status: 'idle' as const,
      ctx,
      cancel: vi.fn(),
      whenIdle: () => Promise.resolve(),
      runMaintenance: () => Promise.reject(new Error('not used')),
      send: () => {},
      steer: () => {},
      inject: () => {},
      followup: (message: UserMessage) => {
        const turn = 1
        session.append('turn/start', { turn })
        ctx.emit('agent/inbox/claimed', { agent, message, turn })
        session.append('step/start', { turn, step: 1 })
        session.append('user/message', message, { surfaceOp: 'append' })
        session.append('assistant/message', {
          turn, step: 1,
          message: createAssistantMessage({ content: [{ type: 'text', text: '已经处理完成' }], source: { provider: 'test', model: 'test' } }),
        }, { surfaceOp: 'append' })
        session.append('step/end', { turn, step: 1 })
        session.append('turn/end', { turn, reason: { kind: 'completed' } })
      },
    } satisfies Agent
    ctx.agents.register(agent)
    await ctx.plugin({ apply, inject }, {})

    const voice = await ctx.voice.open(session.id)
    await settle()
    emit?.({ type: 'transcription.completed', utteranceId: VoiceUtteranceId('speech-task'), text: '执行任务' })
    await settle()

    expect(observations.map(item => item.status)).toEqual(['accepted', 'running', 'running', 'completed'])
    expect(observations.find(item => item.voiceMessage !== undefined)?.voiceMessage?.text).toBe('已经处理完成')
    expect(requestResponse).toHaveBeenCalledTimes(1)
    await ctx.voice.close(voice.id)
    expect(ctx.agents.get(session.id)).toBe(agent)
  })

  it('lets a frontend voice Agent drive one exact text-Agent task', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    let failNextFollowup = false
    const createdAgents = installAgentFactory(ctx, (created) => {
      if (failNextFollowup) created.followup.mockImplementationOnce(() => { throw new Error('followup unavailable') })
    })
    await ctx.plugin(AgentDefaultModel, { provider: 'test', model: 'test' })
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(VoiceRuntime, { provider: 'test' })
    const observations: TaskObservation[] = []
    const requestResponse = vi.fn()
    const completions: Array<{ callId: string; result: TaskCommandResult }> = []
    let emit: ((event: VoiceProviderEvent) => void) | undefined
    const providerSession: VoiceProviderSession = {
      audio: { inputSampleRate: 16_000, outputSampleRate: 24_000, format: 'pcm_s16le' },
      interactionMode: 'frontend-agent',
      appendAudio: () => {}, commitAudio: () => {}, interruptResponse: () => {}, playbackEnded: () => {},
      appendTaskObservation: event => observations.push(event),
      requestResponse,
      completeTaskCommand: (callId, result) => { completions.push({ callId, result }) },
      close: () => Promise.resolve(),
    }
    ctx.voice.registerProvider({
      id: 'test', available: () => true,
      connect: (input) => { emit = input.emit; return Promise.resolve(providerSession) },
    })

    const session = ctx.sessions.create(SessionId('voice-frontend-agent'))
    const sourceFollowup = vi.fn<(message: UserMessage) => void>()
    const agent = {
      id: session.id,
      options: { provider: 'test', model: 'test' },
      session,
      inbox: {} as Agent['inbox'],
      status: 'idle' as const,
      ctx,
      cancel: vi.fn(),
      whenIdle: () => Promise.resolve(),
      runMaintenance: () => Promise.reject(new Error('not used')),
      send: () => {},
      steer: vi.fn(),
      inject: () => {},
      followup: sourceFollowup,
    } satisfies Agent
    ctx.agents.register(agent)
    await ctx.plugin({ apply, inject }, {})

    const voice = await ctx.voice.open(session.id)
    await settle()
    emit?.({
      type: 'transcription.completed',
      utteranceId: VoiceUtteranceId('frontend-chat'),
      text: '只是聊天，不要启动任务',
    })
    await settle()
    expect(sourceFollowup).not.toHaveBeenCalled()
    const responseId = VoiceResponseId('frontend-response')
    const assistantUtterance = VoiceUtteranceId('assistant-response')
    emit?.({ type: 'output_text.started', utteranceId: assistantUtterance, responseId })
    emit?.({ type: 'output_text.delta', utteranceId: assistantUtterance, responseId, text: '我会' })
    emit?.({ type: 'output_text.done', utteranceId: assistantUtterance, responseId, text: '我会继续和你对话。' })
    await settle()
    const voiceEvents = session.events.filter(event => event.type.startsWith('voice/'))
    expect(voiceEvents.length).toBeGreaterThan(0)
    expect(voiceEvents.every(event => event.ignorable !== true)).toBe(true)
    expect(session.events.flatMap(event => event.type === 'voice/utterance-end' ? [event.data] : [])).toEqual([
      {
        utteranceId: VoiceUtteranceId('frontend-chat'),
        role: 'user',
        text: '只是聊天，不要启动任务',
        state: 'completed',
      },
      {
        utteranceId: assistantUtterance,
        role: 'assistant',
        responseId,
        text: '我会继续和你对话。',
        state: 'completed',
      },
    ])

    const startCall = {
      type: 'task.command' as const,
      call: {
        id: VoiceCommandCallId('call-start'),
        command: {
          type: 'realtime_delegation' as const,
          input: '检查仓库并报告结果',
          transcriptDelta: '用户刚才说的是语音模块',
        },
      },
    }
    emit?.(startCall)
    await settle()
    const firstTask = createdAgents[0]
    if (firstTask === undefined) throw new Error('delegated Agent was not created')
    expect(sourceFollowup).not.toHaveBeenCalled()
    expect(firstTask.followup).toHaveBeenCalledTimes(1)
    expect(firstTask.followup.mock.calls[0]?.[0].source).toEqual({ kind: 'user' })
    const delegationBlock = firstTask.followup.mock.calls[0]?.[0].content[0]
    if (delegationBlock?.type !== 'text') throw new Error('missing delegation envelope')
    expect(delegationBlock.text).toContain('<realtime_delegation>')
    expect(delegationBlock.text).toContain('<input>检查仓库并报告结果</input>')
    expect(delegationBlock.text).toContain('<transcript_delta>用户刚才说的是语音模块</transcript_delta>')
    expect(delegationBlock.text).toContain('</realtime_delegation>')
    const accepted = completions.find(item => item.callId === 'call-start')?.result
    if (accepted?.kind !== 'accepted') throw new Error('realtime_delegation was not accepted')
    const taskId = accepted.taskId

    emit?.(startCall)
    await settle()
    expect(firstTask.followup).toHaveBeenCalledTimes(1)
    expect(completions.filter(item => item.callId === 'call-start')).toHaveLength(2)

    emit?.({
      type: 'task.command',
      call: {
        id: VoiceCommandCallId('call-second'),
        command: { type: 'realtime_delegation', input: '另一个任务' },
      },
    })
    emit?.({
      type: 'task.command',
      call: {
        id: VoiceCommandCallId('call-wrong-message'),
        command: { type: 'send_task_message', taskId: VoiceTaskId('wrong-task'), message: '修改要求' },
      },
    })
    emit?.({
      type: 'task.command',
      call: {
        id: VoiceCommandCallId('call-message'),
        command: { type: 'send_task_message', taskId, message: '只检查语音模块' },
      },
    })
    await settle()
    expect(completions.find(item => item.callId === 'call-second')?.result).toMatchObject({ kind: 'rejected', code: 'task_active' })
    expect(completions.find(item => item.callId === 'call-wrong-message')?.result).toMatchObject({ kind: 'rejected', code: 'task_not_found' })
    expect(firstTask.steer).toHaveBeenCalledTimes(1)
    expect(firstTask.steer.mock.calls[0]?.[0].source).toEqual({ kind: 'plugin', plugin: 'voice-assistant' })
    expect(firstTask.steer.mock.calls[0]?.[0].content).toEqual([{
      type: 'text',
      text: `<realtime_delegation_update>\n  <delegation_id>${taskId}</delegation_id>\n  <message>只检查语音模块</message>\n</realtime_delegation_update>`,
    }])

    firstTask.session.append('turn/start', { turn: 1 })
    const firstMessage = firstTask.followup.mock.calls[0]?.[0]
    if (firstMessage === undefined) throw new Error('missing task message')
    ctx.emit('agent/inbox/claimed', { agent: firstTask.agent, message: firstMessage, turn: 1 })
    await settle()
    expect(ctx.tools.get('send_voice_message', firstTask.agent)).toBeDefined()

    const wrongDelegation = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('voice-wrong-delegation'),
      name: 'send_voice_message',
      arguments: { delegation_id: 'wrong-task', channel: 'STATUS', message: '不应送达' },
      agent: firstTask.agent,
    })
    expect(wrongDelegation).toMatchObject({ isError: true })

    const statusResult = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('voice-status'),
      name: 'send_voice_message',
      arguments: {
        delegation_id: taskId,
        type: 'progress',
        detail: '正在扫描 packages/voice-assistant 的实现与测试。',
        voice_hint: '正在检查语音模块。',
      },
      agent: firstTask.agent,
    })
    expect(statusResult).toMatchObject({ isError: false, value: { delivery: 'queued' } })
    expect(observations.at(-1)).toMatchObject({
      taskId,
      status: 'running',
      taskTurn: 1,
      channel: 'STATUS',
      type: 'progress',
      detail: '正在扫描 packages/voice-assistant 的实现与测试。',
      voiceHint: '正在检查语音模块。',
      voiceMessage: { text: '正在检查语音模块。' },
    })
    expect(requestResponse).toHaveBeenCalledTimes(1)

    const completeResult = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('voice-complete'),
      name: 'send_voice_message',
      arguments: {
        delegation_id: taskId,
        type: 'result',
        detail: '语音模块检查完成，相关测试全部通过。',
        voice_hint: '检查完成，没有发现问题。',
      },
      agent: firstTask.agent,
    })
    expect(completeResult).toMatchObject({
      isError: false,
      value: { delivery: 'held_until_turn_end' },
    })
    expect(requestResponse).toHaveBeenCalledTimes(1)
    const duplicateComplete = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('voice-complete-duplicate'),
      name: 'send_voice_message',
      arguments: { delegation_id: taskId, channel: 'COMPLETE', message: '重复结果' },
      agent: firstTask.agent,
    })
    const lateStatus = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('voice-status-late'),
      name: 'send_voice_message',
      arguments: { delegation_id: taskId, channel: 'STATUS', message: '过晚状态' },
      agent: firstTask.agent,
    })
    expect(duplicateComplete).toMatchObject({ isError: true })
    expect(lateStatus).toMatchObject({ isError: true })

    firstTask.session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: '后台内部的简短收尾' }],
        source: { provider: 'test', model: 'test' },
      }),
    }, { surfaceOp: 'append' })
    firstTask.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await settle()
    expect(observations.at(-1)).toMatchObject({
      taskId,
      status: 'completed',
      taskTurn: 1,
      channel: 'COMPLETE',
      type: 'result',
      detail: '语音模块检查完成，相关测试全部通过。',
      voiceHint: '检查完成，没有发现问题。',
      voiceMessage: { text: '检查完成，没有发现问题。' },
    })
    expect(requestResponse).toHaveBeenCalledTimes(2)

    const loggedObservations = session.events.flatMap(event =>
      event.type === 'voice/task-observation' ? [event.data] : [])
    expect(loggedObservations).toEqual(observations)
    const delegated = session.events.find(event => event.type === 'voice/task-delegated')
    expect(delegated?.data).toEqual({
      taskId,
      taskSessionId: firstTask.session.id,
      input: '检查仓库并报告结果',
    })

    emit?.({
      type: 'task.command',
      call: {
        id: VoiceCommandCallId('call-stale-message'),
        command: { type: 'send_task_message', taskId, message: '继续' },
      },
    })
    emit?.({
      type: 'task.command',
      call: { id: VoiceCommandCallId('call-unknown-cancel'), command: { type: 'cancel_task', taskId: VoiceTaskId('unknown') } },
    })
    await settle()
    expect(completions.find(item => item.callId === 'call-stale-message')?.result).toMatchObject({ kind: 'rejected', code: 'task_not_active' })
    expect(completions.find(item => item.callId === 'call-unknown-cancel')?.result).toMatchObject({ kind: 'rejected', code: 'task_not_found' })

    emit?.({
      type: 'task.command',
      call: {
        id: VoiceCommandCallId('call-cancel-start'),
        command: { type: 'realtime_delegation', input: '执行一个要取消的任务' },
      },
    })
    await settle()
    const cancelAccepted = completions.find(item => item.callId === 'call-cancel-start')?.result
    if (cancelAccepted?.kind !== 'accepted') throw new Error('cancel target delegation was not accepted')
    const cancelTaskId = cancelAccepted.taskId
    const secondTask = createdAgents[1]
    if (secondTask === undefined) throw new Error('second delegated Agent was not created')
    const cancelMessage = secondTask.followup.mock.calls[0]?.[0]
    if (cancelMessage === undefined) throw new Error('missing cancel target message')
    secondTask.session.append('turn/start', { turn: 1 })
    ctx.emit('agent/inbox/claimed', { agent: secondTask.agent, message: cancelMessage, turn: 1 })
    await settle()
    ctx.voice.detach(voice.id)
    await settle()
    expect(ctx.tools.get('send_voice_message', secondTask.agent)).toBeDefined()
    const deliveredBeforeDisconnect = observations.length
    emit?.({
      type: 'task.command',
      call: {
        id: VoiceCommandCallId('call-message-detached'),
        command: { type: 'send_task_message', taskId: cancelTaskId, message: '断线期间继续检查' },
      },
    })
    await settle()
    expect(secondTask.steer).toHaveBeenCalledOnce()
    expect(completions.find(item => item.callId === 'call-message-detached')?.result).toEqual({
      kind: 'accepted', taskId: cancelTaskId,
    })
    const detachedStatus = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('voice-status-detached'),
      name: 'send_voice_message',
      arguments: { delegation_id: cancelTaskId, channel: 'STATUS', message: '断线期间仍在执行。' },
      agent: secondTask.agent,
    })
    expect(detachedStatus).toMatchObject({ isError: false, value: { delivery: 'queued' } })
    expect(observations).toHaveLength(deliveredBeforeDisconnect)

    const reconnectedVoice = await ctx.voice.open(session.id)
    await settle()
    expect(reconnectedVoice.id).toBe(voice.id)
    expect(observations.at(-1)).toMatchObject({
      taskId: cancelTaskId,
      status: 'running',
      channel: 'STATUS',
      voiceMessage: { text: '断线期间仍在执行。' },
    })
    expect(requestResponse).toHaveBeenCalledTimes(2)
    emit?.({
      type: 'task.command',
      call: { id: VoiceCommandCallId('call-cancel'), command: { type: 'cancel_task', taskId: cancelTaskId } },
    })
    await settle()
    expect(secondTask.cancel).toHaveBeenCalledWith({ kind: 'user' })
    expect(completions.find(item => item.callId === 'call-cancel')?.result).toEqual({
      kind: 'accepted', taskId: cancelTaskId,
    })

    secondTask.session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    await settle()
    expect(observations.at(-1)).toMatchObject({ taskId: cancelTaskId, status: 'cancelled' })
    expect(requestResponse).toHaveBeenCalledTimes(3)
    expect(session.events.flatMap(event =>
      event.type === 'voice/task-observation' ? [event.data] : [])).toEqual(observations)

    failNextFollowup = true
    emit?.({
      type: 'task.command',
      call: {
        id: VoiceCommandCallId('call-followup-failed'),
        command: { type: 'realtime_delegation', input: '执行一个无法启动的任务' },
      },
    })
    await settle()
    expect(completions.find(item => item.callId === 'call-followup-failed')?.result).toEqual({
      kind: 'rejected', code: 'backend_unavailable', message: 'followup unavailable',
    })
    expect(observations.at(-1)).toMatchObject({ status: 'failed', reason: 'followup unavailable' })
    expect(requestResponse).toHaveBeenCalledTimes(4)
    await ctx.voice.close(reconnectedVoice.id)
    await settle()
    expect(ctx.tools.get('send_voice_message', secondTask.agent)).toBeUndefined()
  })
})
