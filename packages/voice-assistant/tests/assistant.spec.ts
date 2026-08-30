import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import LlmRuntime, {
  CallId,
  LlmAdapter,
  createAssistantMessage,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
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
} from '@flowingspring/dsh-voice'
import { apply, inject } from '@flowingspring/dsh-voice-assistant'
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
  readonly inject: ReturnType<typeof vi.fn<(message: UserMessage) => void>>
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
      const inject = vi.fn<(message: UserMessage) => void>()
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
        inject,
        followup,
      } satisfies Partial<Agent>)
      const commit = await options.setup?.(agentCtx)
      commit?.commit()
      const dispose = ctx.agents.register(agent)
      const item = { agent, session, followup, steer, inject, cancel }
      created.push(item)
      configure?.(item)
      return { agent, dispose: async () => { dispose() } }
    },
    resume: () => Promise.reject(new Error('not used')),
  })
  return created
}

describe('voice assistant driver', () => {
  it('continues frontend routing when workspace memory exceeds the soft timeout', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LlmRuntime)
    const routePrompts: string[] = []
    class RouteAdapter extends LlmAdapter {
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        const prompt = options.messages[0]?.content
          .flatMap(block => block.type === 'text' ? [block.text] : [])
          .join('') ?? ''
        routePrompts.push(prompt)
        yield { type: 'text-delta', index: 0, text: '{"action":"chat","reply":"路由已经继续。"}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['test'], new RouteAdapter())
    await ctx.plugin(AgentDefaultModel, { provider: 'test', model: 'test' })
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(VoiceRuntime, { provider: 'test' })
    class SlowWorkspaceMemory extends Service {
      constructor(serviceCtx: Context) { super(serviceCtx, 'workspaceMemory') }
      recall = vi.fn(() => new Promise<never>(() => {}))
      checkpoint = vi.fn(async () => ({ status: 'buffered' as const }))
    }
    await ctx.plugin(SlowWorkspaceMemory)

    const displayed: string[] = []
    const completions: TaskCommandResult[] = []
    let emit: ((event: VoiceProviderEvent) => void) | undefined
    let pendingSpeech = ''
    const providerSession: VoiceProviderSession = {
      audio: { inputSampleRate: 16_000, outputSampleRate: 24_000, format: 'pcm_s16le' },
      interactionMode: 'frontend-agent',
      appendAudio: () => {}, commitAudio: () => {}, interruptResponse: () => {}, playbackEnded: () => {},
      appendTaskObservation: () => {},
      appendSpeechText: text => { pendingSpeech += text },
      requestResponse: () => {
        if (pendingSpeech !== '') displayed.push(pendingSpeech)
        pendingSpeech = ''
      },
      completeTaskCommand: (_callId, result) => { completions.push(result) },
      close: () => Promise.resolve(),
    }
    ctx.voice.registerProvider({
      id: 'test', available: () => true,
      connect: input => { emit = input.emit; return Promise.resolve(providerSession) },
    })
    const source = ctx.sessions.create(SessionId('voice-memory-timeout'))
    const sourceAgent = {
      id: source.id,
      options: { provider: 'test', model: 'test' },
      session: source,
      inbox: {} as Agent['inbox'],
      status: 'idle' as const,
      ctx,
      cancel: vi.fn(),
      whenIdle: () => Promise.resolve(),
      runMaintenance: () => Promise.reject(new Error('not used')),
      send: () => {}, steer: vi.fn(), inject: () => {}, followup: vi.fn(),
    } satisfies Agent
    ctx.agents.register(sourceAgent)
    await ctx.plugin({ apply, inject }, { memoryRecallTimeoutMs: 10 })
    await ctx.voice.open(source.id)

    const startedAt = Date.now()
    emit?.({
      type: 'task.command',
      call: {
        id: VoiceCommandCallId('route-memory-timeout'),
        command: { type: 'route_transcription', input: '继续回答这个问题' },
      },
    })
    await vi.waitFor(() => { expect(displayed).toEqual(['路由已经继续。']) })
    expect(Date.now() - startedAt).toBeLessThan(150)
    expect(completions).toContainEqual({ kind: 'handled' })
    expect(routePrompts.at(-1)).toContain('Workspace 长期记忆：\n（无）')
    expect(routePrompts.at(-1)).toContain('只有普通寒暄、日常对话，以及无需外部事实或工具就能可靠回答的稳定知识，才选择 chat')
    expect(routePrompts.at(-1)).toContain('凡是需要搜索、查询、核实、最新信息，或涉及陌生、不确定、可能过时的术语和事实，一律选择 delegate')
  })

  it('uses a grounded local-time tool and delegates a context-resolved task', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 7, 29, 2, 55, 0))
    try {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(LlmRuntime)
      const routePrompts: string[] = []
      class RouteAdapter extends LlmAdapter {
        async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
          const prompt = options.messages[0]?.content
            .flatMap(block => block.type === 'text' ? [block.text] : [])
            .join('') ?? ''
          routePrompts.push(prompt)
          if (prompt.includes('用户原话：现在几点？')) {
            yield { type: 'text-delta', index: 0, text: '{"action":"tool","tool":"local_datetime"}' }
          } else {
            yield {
              type: 'text-delta',
              index: 0,
              text: JSON.stringify({
                action: 'delegate',
                acknowledgement: '好的，我来核实系统时间。',
                task: '核实当前系统时间是否准确',
                background: '用户刚刚询问当前时间，并认为之前的回答不准确',
                user_request: '这段内容不应覆盖真实用户原话',
              }),
            }
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }
      ctx.llm.registerAdapter(['test'], new RouteAdapter())
      const createdAgents = installAgentFactory(ctx)
      await ctx.plugin(AgentDefaultModel, { provider: 'test', model: 'test' })
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(VoiceRuntime, { provider: 'test' })
      const recallMemory = vi.fn(async () => ({
        scope: 'ws-test',
        summary: '该项目使用持续复用的后台 Agent。',
        matches: [{ id: 'mem-voice', content: '用户希望语音聊天共享 Workspace 长期记忆。' }],
      }))
      class FakeWorkspaceMemory extends Service {
        constructor(serviceCtx: Context) { super(serviceCtx, 'workspaceMemory') }
        recall = recallMemory
        checkpoint = vi.fn(async () => ({ status: 'buffered' as const }))
      }
      await ctx.plugin(FakeWorkspaceMemory)

      const displayed: string[] = []
      const commandResults: TaskCommandResult[] = []
      let pendingSpeech = ''
      let emit: ((event: VoiceProviderEvent) => void) | undefined
      const providerSession: VoiceProviderSession = {
        audio: { inputSampleRate: 16_000, outputSampleRate: 24_000, format: 'pcm_s16le' },
        interactionMode: 'frontend-agent',
        appendAudio: () => {}, commitAudio: () => {}, interruptResponse: () => {}, playbackEnded: () => {},
        appendTaskObservation: () => {},
        appendSpeechText: (text) => { pendingSpeech += text },
        requestResponse: () => {
          if (pendingSpeech === '') return
          displayed.push(pendingSpeech)
          pendingSpeech = ''
        },
        completeTaskCommand: (_callId, result) => { commandResults.push(result) },
        close: () => Promise.resolve(),
      }
      ctx.voice.registerProvider({
        id: 'test', available: () => true,
        connect: (input) => { emit = input.emit; return Promise.resolve(providerSession) },
      })

      const source = ctx.sessions.create(SessionId('voice-grounded-routing'))
      const sourceAgent = {
        id: source.id,
        options: { provider: 'test', model: 'test' },
        session: source,
        inbox: {} as Agent['inbox'],
        status: 'idle' as const,
        ctx,
        cancel: vi.fn(),
        whenIdle: () => Promise.resolve(),
        runMaintenance: () => Promise.reject(new Error('not used')),
        send: () => {}, steer: vi.fn(), inject: () => {}, followup: vi.fn(),
      } satisfies Agent
      ctx.agents.register(sourceAgent)
      await ctx.plugin({ apply, inject }, { taskSessionPolicy: 'continuous' })
      await ctx.voice.open(source.id)

      emit?.({
        type: 'task.command',
        call: {
          id: VoiceCommandCallId('route-local-time'),
          command: { type: 'route_transcription', input: '现在几点？' },
        },
      })
      await settle()
      expect(displayed).toEqual(['根据本机系统时间，现在是 2026年8月29日，星期六，02:55。'])
      expect(commandResults).toContainEqual({ kind: 'handled' })
      expect(createdAgents).toHaveLength(0)

      source.append('voice/utterance-end', {
        utteranceId: VoiceUtteranceId('context-user-time'),
        role: 'user',
        text: '现在几点？',
        state: 'completed',
      })
      source.append('voice/utterance-end', {
        utteranceId: VoiceUtteranceId('context-assistant-time'),
        role: 'assistant',
        responseId: VoiceResponseId('context-time-response'),
        text: '现在是凌晨两点五十五分。',
        state: 'completed',
      })
      source.append('voice/utterance-end', {
        utteranceId: VoiceUtteranceId('context-user-correction'),
        role: 'user',
        text: '这个时间不准呀。',
        state: 'completed',
      })

      emit?.({
        type: 'task.command',
        call: {
          id: VoiceCommandCallId('route-contextual-delegation'),
          command: { type: 'route_transcription', input: '你帮我看呀。' },
        },
      })
      await settle()

      expect(displayed.at(-1)).toBe('好的，我来核实系统时间。')
      expect(createdAgents).toHaveLength(1)
      const delegated = createdAgents[0]?.followup.mock.calls[0]?.[0]
      const block = delegated?.content[0]
      if (block?.type !== 'text') throw new Error('contextual delegation text missing')
      expect(block.text).toBe([
        '当前任务：',
        '核实当前系统时间是否准确',
        '',
        '前置背景：',
        '用户刚刚询问当前时间，并认为之前的回答不准确',
        '',
        '用户原话：',
        '你帮我看呀。',
        '',
        '请以“当前任务”为最高优先级执行；前置背景只用于理解和消歧，不要把旧对话当成待执行任务。',
      ].join('\n'))
      expect(block.text).not.toContain('任务边界与写操作规则')
      expect(block.text).not.toContain('默认只读')
      expect(block.text).not.toContain('这段内容不应覆盖真实用户原话')
      expect(routePrompts.at(-1)).toContain('用户：这个时间不准呀。')
      expect(routePrompts.at(-1)).toContain('用户希望语音聊天共享 Workspace 长期记忆。')
      expect(recallMemory).toHaveBeenCalledWith({
        sessionId: source.id,
        query: '你帮我看呀。',
        maxBytes: 5000,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('grounds project facts before routing and hard-delegates when evidence is missing', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-voco-evidence-'))
    const outside = await mkdtemp(join(tmpdir(), 'dsh-voco-outside-'))
    try {
      await writeFile(join(workspace, 'facts.md'), '# 项目规则链\n规则链共有三层：采集、筛选、复核。\n', 'utf8')
      await writeFile(join(outside, 'secret.md'), 'OUTSIDE_SECRET：越界密钥不应被项目检索读取。\n', 'utf8')
      await symlink(outside, join(workspace, 'linked-outside'), process.platform === 'win32' ? 'junction' : 'dir')
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(LlmRuntime)
      const prompts: string[] = []
      class RouteAdapter extends LlmAdapter {
        async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
          prompts.push(options.messages[0]?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') ?? '')
          yield { type: 'text-delta', index: 0, text: '{"action":"chat","reply":"基于项目资料回答。"}' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }
      ctx.llm.registerAdapter(['test'], new RouteAdapter())
      const createdAgents = installAgentFactory(ctx)
      await ctx.plugin(AgentDefaultModel, { provider: 'test', model: 'test' })
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(VoiceRuntime, { provider: 'test' })
      const displayed: string[] = []
      const completions: TaskCommandResult[] = []
      let pendingSpeech = ''
      let emit: ((event: VoiceProviderEvent) => void) | undefined
      const providerSession: VoiceProviderSession = {
        audio: { inputSampleRate: 16_000, outputSampleRate: 24_000, format: 'pcm_s16le' },
        interactionMode: 'frontend-agent',
        appendAudio: () => {}, commitAudio: () => {}, interruptResponse: () => {}, playbackEnded: () => {},
        appendTaskObservation: () => {},
        appendSpeechText: text => { pendingSpeech += text; return true },
        requestResponse: () => { if (pendingSpeech !== '') { displayed.push(pendingSpeech); pendingSpeech = '' } },
        completeTaskCommand: (_id, result) => { completions.push(result) },
        close: () => Promise.resolve(),
      }
      ctx.voice.registerProvider({
        id: 'test', available: () => true,
        connect: input => { emit = input.emit; return Promise.resolve(providerSession) },
      })
      const source = ctx.sessions.create(SessionId('voice-evidence'), { meta: { cwd: workspace } })
      source.append('request/header', { header: { cwd: workspace, config: { provider: 'test', model: 'test' } } })
      const sourceAgent = {
        id: source.id,
        options: { provider: 'test', model: 'test' },
        session: source,
        inbox: {} as Agent['inbox'],
        status: 'idle' as const,
        ctx,
        cancel: vi.fn(),
        whenIdle: () => Promise.resolve(),
        runMaintenance: () => Promise.reject(new Error('not used')),
        send: () => {}, steer: vi.fn(), inject: () => {}, followup: vi.fn(),
      } satisfies Agent
      ctx.agents.register(sourceAgent)
      await ctx.plugin({ apply, inject }, { evidenceSearchTimeoutMs: 500 })
      await ctx.voice.open(source.id)

      emit?.({ type: 'task.command', call: {
        id: VoiceCommandCallId('evidence-hit'),
        command: { type: 'route_transcription', input: '这个项目的规则链有几层？' },
      } })
      await vi.waitFor(() => { expect(displayed).toContain('基于项目资料回答。') })
      expect(prompts.at(-1)).toContain('[当前文件] facts.md')
      expect(prompts.at(-1)).toContain('1-2:')
      expect(completions).toContainEqual({ kind: 'handled' })

      await new Promise(resolve => setTimeout(resolve, 5))
      await writeFile(join(workspace, 'facts.md'), '# 项目规则链\n规则链现在调整为四层：采集、筛选、复核、归档。\n', 'utf8')
      emit?.({ type: 'task.command', call: {
        id: VoiceCommandCallId('evidence-refresh'),
        command: { type: 'route_transcription', input: '这个项目的规则链有几层？' },
      } })
      await vi.waitFor(() => { expect(displayed.filter(text => text === '基于项目资料回答。')).toHaveLength(2) })
      expect(prompts.at(-1)).toContain('现在调整为四层')

      await mkdir(join(workspace, 'nested'))
      await writeFile(join(workspace, 'nested', 'rules.md'), '# 规则链补充\n规则链的第四层归档会保存最终证据。\n', 'utf8')
      emit?.({ type: 'task.command', call: {
        id: VoiceCommandCallId('evidence-new-file'),
        command: { type: 'route_transcription', input: '这个项目的规则链有几层？' },
      } })
      await vi.waitFor(() => { expect(displayed.filter(text => text === '基于项目资料回答。')).toHaveLength(3) })
      expect(prompts.at(-1)).toContain('[当前文件] nested/rules.md')

      emit?.({ type: 'task.command', call: {
        id: VoiceCommandCallId('evidence-miss'),
        command: { type: 'route_transcription', input: '这个项目的越界密钥是什么？' },
      } })
      await vi.waitFor(() => { expect(createdAgents).toHaveLength(1) })
      expect(prompts.at(-1)).not.toContain('OUTSIDE_SECRET')
      expect(displayed.at(-1)).toBe('我看看。')
      expect(completions.at(-1)).toMatchObject({ kind: 'accepted' })
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

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

  it('generates one concise title from the first meaningful voice request', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentDefaultModel, { provider: 'test', model: 'test' })
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const title = { value: undefined as string | undefined, rename: vi.fn((_: unknown, value: string) => { title.value = value }) }
    class FakeSessionTitle extends Service {
      constructor(serviceCtx: Context) { super(serviceCtx, 'sessionTitle') }
      get = vi.fn(() => title.value === undefined ? undefined : { title: title.value })
      rename = title.rename
    }
    await ctx.plugin(FakeSessionTitle)
    class TitleAdapter extends LlmAdapter {
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        if (options.system?.includes('语音会话标题生成器') === true) {
          yield { type: 'text-delta', index: 0, text: '检查项目依赖。' }
        } else {
          yield { type: 'text-delta', index: 0, text: '已经处理完成' }
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['test'], new TitleAdapter())
    await ctx.plugin(VoiceRuntime, { provider: 'test' })
    let emit: ((event: VoiceProviderEvent) => void) | undefined
    const providerSession: VoiceProviderSession = {
      audio: { inputSampleRate: 16_000, outputSampleRate: 24_000, format: 'pcm_s16le' },
      interactionMode: 'speech-shell',
      appendAudio: () => {}, commitAudio: () => {}, interruptResponse: () => {}, playbackEnded: () => {},
      appendTaskObservation: () => {}, requestResponse: () => {}, completeTaskCommand: () => {},
      close: () => Promise.resolve(),
    }
    ctx.voice.registerProvider({
      id: 'test', available: () => true,
      connect: (input) => { emit = input.emit; return Promise.resolve(providerSession) },
    })
    const source = ctx.sessions.create(SessionId('voice-title'))
    const sourceAgent = {
      id: source.id,
      options: { provider: 'test', model: 'test' },
      session: source,
      inbox: {} as Agent['inbox'],
      status: 'idle' as const,
      ctx,
      cancel: vi.fn(),
      whenIdle: () => Promise.resolve(),
      runMaintenance: () => Promise.reject(new Error('not used')),
      send: () => {}, steer: vi.fn(), inject: () => {}, followup: vi.fn(),
    } satisfies Agent
    ctx.agents.register(sourceAgent)
    await ctx.plugin({ apply, inject }, {})
    await ctx.voice.open(source.id)
    await settle()

    emit?.({ type: 'transcription.completed', utteranceId: VoiceUtteranceId('title-greeting'), text: '你好' })
    await settle()
    expect(title.rename).not.toHaveBeenCalled()
    emit?.({ type: 'transcription.completed', utteranceId: VoiceUtteranceId('title-request'), text: '帮我检查项目依赖' })
    await vi.waitFor(() => { expect(title.rename).toHaveBeenCalledTimes(1) })
    expect(title.value).toBe('检查项目依赖')
    emit?.({ type: 'transcription.completed', utteranceId: VoiceUtteranceId('title-later'), text: '再看看测试' })
    await settle()
    expect(title.rename).toHaveBeenCalledTimes(1)
  })

  it('rewrites a detail-only Agent result against the original request and streams identical UI and TTS text', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LlmRuntime)
    const requests: GenerateOptions[] = []
    class RewriteAdapter extends LlmAdapter {
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        requests.push(options)
        const prompt = options.messages[0]?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
        if (prompt?.includes('结合最近对话判断当前用户原话') === true) {
          yield {
            type: 'text-delta',
            index: 0,
          text: prompt.includes('请创建免费.md')
              ? JSON.stringify({
                  action: 'delegate',
                  acknowledgement: '好的，我先检查相关文件。',
                  task: '创建免费.md并检查文件内容',
                  background: '用户希望创建文件后得到验证结果',
                  user_request: '请创建免费.md，并告诉我结果',
                })
              : '{"action":"chat","reply":"你好，我在呢。"}',
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        if (prompt?.includes('处理事件类型：progress') === true) {
          yield { type: 'text-delta', index: 0, text: '正在检查文件内容。' }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        yield { type: 'text-delta', index: 0, text: '已经创建了名为免费的 Markdown 文档。' }
        yield { type: 'text-delta', index: 0, text: '文件内容也已经检查完成。' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['test'], new RewriteAdapter())
    const delegationOrder: string[] = []
    const createdAgents = installAgentFactory(ctx, () => { delegationOrder.push('agent-created') })
    await ctx.plugin(AgentDefaultModel, { provider: 'test', model: 'test' })
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(VoiceRuntime, { provider: 'test' })

    const observations: TaskObservation[] = []
    const displayed: string[] = []
    const ttsInputs: string[] = []
    const commandResults: TaskCommandResult[] = []
    let pendingSpeech = ''
    let emit: ((event: VoiceProviderEvent) => void) | undefined
    const providerSession: VoiceProviderSession = {
      audio: { inputSampleRate: 16_000, outputSampleRate: 24_000, format: 'pcm_s16le' },
      interactionMode: 'frontend-agent',
      appendAudio: () => {}, commitAudio: () => {}, interruptResponse: () => {}, playbackEnded: () => {},
      appendTaskObservation: event => observations.push(event),
      appendSpeechText: (text) => { pendingSpeech += text },
      requestResponse: () => {
        if (pendingSpeech === '') return
        if (pendingSpeech === '好的，我先检查相关文件。') delegationOrder.push('acknowledged')
        displayed.push(pendingSpeech)
        ttsInputs.push(pendingSpeech)
        pendingSpeech = ''
      },
      completeTaskCommand: (_callId, result) => { commandResults.push(result) },
      close: () => Promise.resolve(),
    }
    ctx.voice.registerProvider({
      id: 'test', available: () => true,
      connect: (input) => { emit = input.emit; return Promise.resolve(providerSession) },
    })

    const source = ctx.sessions.create(SessionId('voice-rewrite'))
    const sourceAgent = {
      id: source.id,
      options: { provider: 'test', model: 'test' },
      session: source,
      inbox: {} as Agent['inbox'],
      status: 'idle' as const,
      ctx,
      cancel: vi.fn(),
      whenIdle: () => Promise.resolve(),
      runMaintenance: () => Promise.reject(new Error('not used')),
      send: () => {}, steer: vi.fn(), inject: () => {}, followup: vi.fn(),
    } satisfies Agent
    ctx.agents.register(sourceAgent)
    await ctx.plugin({ apply, inject }, { taskSessionPolicy: 'continuous' })
    await ctx.voice.open(source.id)

    emit?.({
      type: 'task.command',
      call: {
        id: VoiceCommandCallId('route-chat'),
        command: { type: 'route_transcription', input: '你好' },
      },
    })
    await vi.waitFor(() => { expect(displayed).toEqual(['你好，我在呢。']) })
    expect(commandResults).toContainEqual({ kind: 'handled' })
    expect(createdAgents).toHaveLength(0)

    emit?.({
      type: 'task.command',
      call: {
        id: VoiceCommandCallId('rewrite-start'),
        command: { type: 'route_transcription', input: '请创建免费.md，并告诉我结果' },
      },
    })
    await settle()
    expect(displayed).toEqual(['你好，我在呢。', '好的，我先检查相关文件。'])
    expect(delegationOrder).toEqual(['acknowledged', 'agent-created'])
    const task = createdAgents[0]
    if (task === undefined) throw new Error('rewrite task was not created')
    const delegated = task.followup.mock.calls[0]?.[0]
    if (delegated === undefined) throw new Error('rewrite delegation message missing')
    const taskId = observations.find(item => item.status === 'queued')?.taskId
    if (taskId === undefined) throw new Error('rewrite task id missing')
    task.session.append('turn/start', { turn: 1 })
    ctx.emit('agent/inbox/claimed', { agent: task.agent, message: delegated, turn: 1 })
    await settle()
    emit?.({
      type: 'task.command',
      call: {
        id: VoiceCommandCallId('rewrite-update'),
        command: { type: 'send_task_message', taskId, message: '结果需要说明文件内容是否验证过' },
      },
    })
    await settle()

    const progress = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('rewrite-progress'),
      name: 'send_voice_message',
      arguments: {
        type: 'progress',
        detail: '正在读取 C:\\Users\\QUAN\\Desktop\\测试\\免费.md 并检查正文。',
      },
      agent: task.agent,
    })
    expect(progress).toMatchObject({ isError: false, value: { delivery: 'queued' } })
    // Progress stays in the folded task trace and does not create another
    // spoken response or chat bubble.
    await vi.waitFor(() => {
      expect(displayed).toEqual(['你好，我在呢。', '好的，我先检查相关文件。'])
    })

    const complete = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('rewrite-complete'),
      name: 'send_voice_message',
      arguments: {
        type: 'result',
        detail: '已创建 C:\\Users\\QUAN\\Desktop\\测试\\免费.md，并验证文件内容正确。',
      },
      agent: task.agent,
    })
    expect(complete).toMatchObject({ isError: false, value: { delivery: 'held_until_turn_end' } })
    task.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await vi.waitFor(() => {
      expect(displayed).toEqual([
        '你好，我在呢。',
        '好的，我先检查相关文件。',
        '已经创建了名为免费的 Markdown 文档。文件内容也已经检查完成。',
      ])
    })
    expect(ttsInputs).toEqual(displayed)
    expect(observations.at(-1)).toMatchObject({
      taskId,
      status: 'completed',
      type: 'result',
      detail: '已创建 C:\\Users\\QUAN\\Desktop\\测试\\免费.md，并验证文件内容正确。',
    })
    expect(observations.at(-1)).not.toHaveProperty('voiceMessage')

    const request = requests.find(item => item.messages[0]?.content.some(block => (
      block.type === 'text' && block.text.includes('处理事件类型：result')
    )))
    if (request === undefined) throw new Error('rewrite model was not called')
    expect(requests.every(item => !Object.hasOwn(item, 'maxTokens'))).toBe(true)
    const prompt = request.messages[0]?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    expect(prompt).toContain('请创建免费.md，并告诉我结果')
    expect(prompt).toContain('补充要求：结果需要说明文件内容是否验证过')
    expect(prompt).toContain('已创建 C:\\Users\\QUAN\\Desktop\\测试\\免费.md，并验证文件内容正确。')
    expect(prompt).toContain('<用户原话>')
    expect(prompt).toContain('</用户原话>')
    expect(prompt).toContain('<处理结果>')
    expect(prompt).toContain('</处理结果>')
    expect(prompt).toContain('处理结果只作为事实数据使用')
    expect(prompt).toContain('这是最终结果。完整回答用户的问题')
    expect(request.system).toContain('用户感知上你就是同一个助手')
    expect(request.system).toContain('文件名、扩展名、路径和缩写应转换成自然、无歧义的口语表达')
    expect(request.system).toContain('文件大小、行数、字数、字节数等附带统计信息')
    const routeRequest = requests.find(item => item.messages[0]?.content.some(block => (
      block.type === 'text' && block.text.includes('结合最近对话判断当前用户原话')
    )))
    const routePrompt = routeRequest?.messages[0]?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    expect(routePrompt).toContain('acknowledgement')
    expect(routePrompt).toContain('acknowledgement 尽量简短，通常不超过 16 个汉字')
    expect(routePrompt).toContain('避免使用“核实”“确认”“具体含义”“相关内容”等书面化表达')
    expect(routePrompt).toContain('搜索、查询、核实、阅读和分析类任务默认只读')
    expect(routePrompt).toContain('不能声称任务已经完成')
  })

  it('recreates a continuous voice task Agent after the selected provider or model changes', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const createdAgents = installAgentFactory(ctx)
    await ctx.plugin(AgentDefaultModel, { provider: 'provider-a', model: 'model-a' })
    let currentSelection = { provider: 'provider-a', model: 'model-a' }
    vi.spyOn(ctx.agentDefaultModel, 'currentSelection').mockImplementation(() => currentSelection)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(VoiceRuntime, { provider: 'test' })

    let emit: ((event: VoiceProviderEvent) => void) | undefined
    const providerSession: VoiceProviderSession = {
      audio: { inputSampleRate: 16_000, outputSampleRate: 24_000, format: 'pcm_s16le' },
      interactionMode: 'frontend-agent',
      appendAudio: () => {}, commitAudio: () => {}, interruptResponse: () => {}, playbackEnded: () => {},
      appendTaskObservation: () => {},
      requestResponse: () => {},
      completeTaskCommand: () => {},
      close: () => Promise.resolve(),
    }
    ctx.voice.registerProvider({
      id: 'test', available: () => true,
      connect: (input) => { emit = input.emit; return Promise.resolve(providerSession) },
    })

    const source = ctx.sessions.create(SessionId('voice-model-switch'))
    source.append('request/header', {
      header: { config: { provider: 'provider-a', model: 'model-a' } },
    })
    const sourceAgent = {
      id: source.id,
      options: { provider: 'provider-a', model: 'model-a' },
      session: source,
      inbox: {} as Agent['inbox'],
      status: 'idle' as const,
      ctx,
      cancel: vi.fn(),
      whenIdle: () => Promise.resolve(),
      runMaintenance: () => Promise.reject(new Error('not used')),
      send: () => {}, steer: vi.fn(), inject: () => {}, followup: vi.fn(),
    } satisfies Agent
    ctx.agents.register(sourceAgent)
    await ctx.plugin({ apply, inject }, { taskSessionPolicy: 'continuous' })
    await ctx.voice.open(source.id)

    emit?.({
      type: 'task.command',
      call: {
        id: VoiceCommandCallId('first-model'),
        command: { type: 'realtime_delegation', input: 'first task' },
      },
    })
    await settle()
    const first = createdAgents[0]
    if (first === undefined) throw new Error('first continuous Agent was not created')
    expect(first.agent.options).toMatchObject({ provider: 'provider-a', model: 'model-a' })
    const firstMessage = first.followup.mock.calls[0]?.[0]
    if (firstMessage === undefined) throw new Error('first continuous message missing')
    first.session.append('turn/start', { turn: 1 })
    ctx.emit('agent/inbox/claimed', { agent: first.agent, message: firstMessage, turn: 1 })
    first.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await settle()

    currentSelection = { provider: 'provider-b', model: 'model-b' }
    emit?.({
      type: 'task.command',
      call: {
        id: VoiceCommandCallId('second-model'),
        command: { type: 'realtime_delegation', input: 'second task' },
      },
    })
    await settle()

    expect(createdAgents).toHaveLength(2)
    const second = createdAgents[1]
    expect(second?.agent.options).toMatchObject({ provider: 'provider-b', model: 'model-b' })
    const secondMessage = second?.followup.mock.calls[0]?.[0]
    if (second === undefined || secondMessage === undefined) throw new Error('second continuous message missing')
    second.session.append('turn/start', { turn: 1 })
    ctx.emit('agent/inbox/claimed', { agent: second.agent, message: secondMessage, turn: 1 })
    second.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await settle()

    emit?.({
      type: 'task.command',
      call: {
        id: VoiceCommandCallId('third-model'),
        command: { type: 'realtime_delegation', input: 'third task' },
      },
    })
    await settle()

    expect(createdAgents).toHaveLength(2)
    expect(second.followup).toHaveBeenCalledTimes(2)
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
    const checkpointMemory = vi.fn(async () => ({ status: 'buffered' as const }))
    class FakeWorkspaceMemory extends Service {
      constructor(serviceCtx: Context) { super(serviceCtx, 'workspaceMemory') }
      recall = vi.fn(async () => ({ scope: 'ws-test', summary: '', matches: [] }))
      checkpoint = checkpointMemory
    }
    await ctx.plugin(FakeWorkspaceMemory)
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
    expect(checkpointMemory).toHaveBeenCalledWith({
      sessionId: session.id,
      reason: 'segment-end',
      force: false,
      messages: [
        { id: 'frontend-chat', role: 'user', text: '只是聊天，不要启动任务' },
        { id: 'assistant-response', role: 'assistant', text: '我会继续和你对话。' },
      ],
    })

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
    if (delegationBlock?.type !== 'text') throw new Error('missing delegated task text')
    expect(delegationBlock.text).toBe('检查仓库并报告结果')
    expect(delegationBlock.text).not.toContain('<realtime_delegation>')
    expect(delegationBlock.text).not.toContain('<delegation_id>')
    expect(firstTask.inject).toHaveBeenCalledTimes(1)
    expect(firstTask.inject.mock.calls[0]?.[0]).toMatchObject({
      source: { kind: 'plugin', plugin: 'voice-assistant' },
      content: [{ type: 'text', text: '语音转写补充上下文：用户刚才说的是语音模块' }],
    })
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
      text: '只检查语音模块',
    }])

    firstTask.session.append('turn/start', { turn: 1 })
    const firstMessage = firstTask.followup.mock.calls[0]?.[0]
    if (firstMessage === undefined) throw new Error('missing task message')
    ctx.emit('agent/inbox/claimed', { agent: firstTask.agent, message: firstMessage, turn: 1 })
    await settle()
    expect(ctx.tools.get('send_voice_message', firstTask.agent)).toBeDefined()

    const statusResult = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('voice-status'),
      name: 'send_voice_message',
      arguments: {
        type: 'progress',
        detail: '正在扫描 packages/voice-assistant 的实现与测试。',
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
    })
    expect(observations.at(-1)).not.toHaveProperty('voiceMessage')
    expect(requestResponse).toHaveBeenCalledTimes(0)

    const silentWarning = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('voice-warning-silent'),
      name: 'send_voice_message',
      arguments: {
        type: 'warning',
        detail: '后台记录一条无需打断用户的兼容性提醒。',
      },
      agent: firstTask.agent,
    })
    expect(silentWarning).toMatchObject({ isError: false, value: { delivery: 'queued' } })
    expect(observations.at(-2)).toMatchObject({
      taskId,
      status: 'running',
      type: 'warning',
      detail: '后台记录一条无需打断用户的兼容性提醒。',
    })
    expect(observations.at(-1)).toMatchObject({
      taskId,
      voiceMessage: { text: '任务遇到了需要注意的情况。' },
    })
    expect(requestResponse).toHaveBeenCalledTimes(1)

    const completeResult = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('voice-complete'),
      name: 'send_voice_message',
      arguments: {
        type: 'result',
        detail: '语音模块检查完成，相关测试全部通过。',
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
      arguments: { channel: 'COMPLETE', detail: '重复结果' },
      agent: firstTask.agent,
    })
    const lateStatus = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('voice-status-late'),
      name: 'send_voice_message',
      arguments: { channel: 'STATUS', detail: '过晚状态' },
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
      voiceMessage: { text: '语音模块检查完成，相关测试全部通过。' },
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
      arguments: { channel: 'STATUS', detail: '断线期间仍在执行。' },
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
      detail: '断线期间仍在执行。',
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
