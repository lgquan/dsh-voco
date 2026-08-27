import { Buffer } from 'node:buffer'
import { EventEmitter, once } from 'node:events'
import WebSocket, { WebSocketServer } from 'ws'
import {
  VoiceCommandCallId,
  VoiceResponseId,
  VoiceSessionId,
  VoiceTaskId,
  VoiceTaskMessageId,
  VoiceUtteranceId,
  type TaskCommandCall,
  type TaskObservation,
  type VoiceConversationMemory,
  type VoiceProviderEvent,
} from '@wayneyu430227/dsh-voice'
import { decodeEvent, DuplexSession, type DuplexDiagnosticEntry, type RawEvent } from '@wayneyu430227/dsh-voice-duplex'
import { describe, expect, it, vi } from 'vitest'

const TEST_VOICE_SESSION_ID = VoiceSessionId('voice-test')

function inputId(providerId: string, voiceSessionId = TEST_VOICE_SESSION_ID): string {
  return `${voiceSessionId}:input:${providerId}`
}

function responseId(providerId: string, voiceSessionId = TEST_VOICE_SESSION_ID): ReturnType<typeof VoiceResponseId> {
  return VoiceResponseId(`${voiceSessionId}:response:${providerId}`)
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise<void>((resolve) => { setImmediate(resolve) })
  }
  throw new Error('timed out waiting for Duplex test event')
}

async function settleSocket(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  await new Promise<void>((resolve) => { setImmediate(resolve) })
}

async function closeServer(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) client.terminate()
  await new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
  })
}

function providerConfig(endpoint: string, overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    interactionMode: 'frontend-agent',
    endpoint,
    accessKey: 'test-access-key',
    authMode: 'bearer',
    appId: 'test-app-id',
    appKey: 'test-app-key',
    resourceId: 'test-resource',
    model: 'test-model',
    speaker: 'test-speaker',
    instructions: 'provider test',
    triggerAudio: new Uint8Array([1, 0, 2, 0]),
    maxDeferredInputAudioBytes: 1024,
    frontendAgentActivationDelayMs: 0,
    endSmoothWindowMs: 0,
    enableCustomVad: true,
    transcriptionDeltaTimeoutMs: 1000,
    diagnosticTrace: false,
    ...overrides,
  }
}

interface TestConnection {
  readonly events: VoiceProviderEvent[]
  readonly frames: RawEvent[]
  readonly session: DuplexSession
  send(event: RawEvent): void
  close(): Promise<void>
}

type SessionConfig = Parameters<typeof DuplexSession.connect>[0]

interface SessionInternals {
  socket: WebSocket
  sendChain: Promise<void>
  config: SessionConfig
  closed: boolean
  activeUtteranceId: ReturnType<typeof VoiceUtteranceId> | undefined
  activeResponseId: ReturnType<typeof VoiceResponseId> | undefined
  playbackResponseId: ReturnType<typeof VoiceResponseId> | undefined
  userTranscribing: boolean
  outputStreaming: boolean
  playbackPending: boolean
  responseExpected: boolean
  automaticResponseRequested: boolean
  activationInFlight: boolean
  activationUpload: boolean
  syntheticInputPending: boolean
  deferredInputBytes: number
  deferredOverflowReported: boolean
  deferredInput: Uint8Array[]
  retiredResponseIds: Set<ReturnType<typeof VoiceResponseId>>
  textStartedResponseIds: Set<ReturnType<typeof VoiceResponseId>>
  textDoneResponseIds: Set<ReturnType<typeof VoiceResponseId>>
  audioDoneResponseIds: Set<ReturnType<typeof VoiceResponseId>>
  responseTexts: Map<ReturnType<typeof VoiceResponseId>, string>
  commandContexts: Map<ReturnType<typeof VoiceCommandCallId>, { questionId: string; command: TaskCommandCall['command'] }>
  taskProjections: Map<ReturnType<typeof VoiceTaskId>, {
    questionId: string
    transcript: string
    observation?: TaskObservation
    revision: number
  }>
  dirtyTasks: Set<ReturnType<typeof VoiceTaskId>>
  receive(event: RawEvent): void
  pumpAutomaticResponse(): void
  isAutomaticResponseBusy(): boolean
  deferInputAudio(audio: Uint8Array): void
  flushDeferredInput(): void
  readUtteranceId(event: RawEvent, fresh?: boolean): ReturnType<typeof VoiceUtteranceId>
  finishUtterance(value: ReturnType<typeof VoiceUtteranceId>): void
  readResponseId(event: RawEvent, fresh?: boolean): ReturnType<typeof VoiceResponseId>
  acceptResponseEvent(event: RawEvent, mayStart: boolean): ReturnType<typeof VoiceResponseId> | undefined
  startResponse(value: ReturnType<typeof VoiceResponseId>): boolean
  startOutputText(
    utterance: ReturnType<typeof VoiceUtteranceId>,
    response: ReturnType<typeof VoiceResponseId>,
  ): void
  retireResponseIfComplete(value: ReturnType<typeof VoiceResponseId>): void
  retireResponse(value: ReturnType<typeof VoiceResponseId>): void
  startTranscriptionTimer(): void
  clearTranscriptionTimer(): void
  newEventId(): string
  send(event: RawEvent): void
  queue(event: RawEvent): Promise<void>
  queueWork(operation: () => Promise<void>): Promise<void>
  transmit(event: RawEvent): Promise<void>
  onClosed(reason?: string): void
}

function internals(session: DuplexSession): SessionInternals {
  return session as unknown as SessionInternals
}

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN
  readonly frames: RawEvent[] = []
  sendError: Error | null | undefined

  send(data: string, callback: (error?: Error | null) => void): void {
    this.frames.push(JSON.parse(data) as RawEvent)
    const error = this.sendError
    this.sendError = undefined
    callback(error)
  }

  close(): void {
    this.readyState = WebSocket.CLOSED
    this.emit('close')
  }
}

interface DetachedSession {
  readonly diagnostics: DuplexDiagnosticEntry[]
  readonly events: VoiceProviderEvent[]
  readonly session: DuplexSession
  readonly socket: FakeSocket
  readonly state: SessionInternals
}

function createDetachedSession(
  interactionMode: SessionConfig['interactionMode'] = 'frontend-agent',
  overrides: Partial<SessionConfig> = {},
): DetachedSession {
  const socket = new FakeSocket()
  const events: VoiceProviderEvent[] = []
  const diagnostics: DuplexDiagnosticEntry[] = []
  const SessionConstructor = DuplexSession as unknown as new (
    socket: WebSocket,
    emit: (event: VoiceProviderEvent) => void,
    config: SessionConfig,
    voiceSessionId: ReturnType<typeof VoiceSessionId>,
    diagnostic?: (entry: DuplexDiagnosticEntry) => void,
  ) => DuplexSession
  const session = new SessionConstructor(socket as unknown as WebSocket, (event) => { events.push(event) }, {
    interactionMode,
    endpoint: 'ws://detached.test',
    accessKey: 'test',
    authMode: 'bearer',
    appId: 'test',
    appKey: 'test',
    resourceId: 'test',
    model: 'test',
    speaker: 'test',
    instructions: 'detached test',
    triggerAudio: new Uint8Array([1, 0, 2, 0]),
    maxDeferredInputAudioBytes: 4,
    frontendAgentActivationDelayMs: 0,
    endSmoothWindowMs: 0,
    enableCustomVad: true,
    transcriptionDeltaTimeoutMs: 1,
    diagnosticTrace: false,
    ...overrides,
  }, TEST_VOICE_SESSION_ID, (entry) => { diagnostics.push(entry) })
  return { diagnostics, events, session, socket, state: internals(session) }
}

async function connectTestSession(
  voiceSessionId = TEST_VOICE_SESSION_ID,
  overrides: Partial<SessionConfig> = {},
  memory?: VoiceConversationMemory,
): Promise<TestConnection> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Duplex test server did not bind TCP')
  const frames: RawEvent[] = []
  let peer: WebSocket | undefined
  server.on('connection', (socket) => {
    peer = socket
    socket.on('message', (data) => {
      const event = decodeEvent(data)
      frames.push(event)
      if (event.type === 'session.create') socket.send(JSON.stringify({ type: 'session.created' }))
    })
  })
  const events: VoiceProviderEvent[] = []
  const session = await DuplexSession.connect({
    interactionMode: 'frontend-agent',
    endpoint: `ws://127.0.0.1:${String(address.port)}`,
    accessKey: 'test',
    authMode: 'bearer',
    appId: 'test',
    appKey: 'test',
    resourceId: 'test',
    model: 'test',
    speaker: 'test',
    instructions: 'frontend test',
    triggerAudio: new Uint8Array([1, 0, 2, 0]),
    maxDeferredInputAudioBytes: 1024,
    frontendAgentActivationDelayMs: 0,
    endSmoothWindowMs: 0,
    enableCustomVad: true,
    transcriptionDeltaTimeoutMs: 1000,
    diagnosticTrace: false,
    ...overrides,
  }, voiceSessionId, (event) => { events.push(event) }, undefined, memory)
  return {
    events,
    frames,
    session,
    send: (event) => {
      if (peer === undefined) throw new Error('Duplex test peer is not connected')
      peer.send(JSON.stringify(event))
    },
    close: async () => {
      await session.close()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    },
  }
}

describe('Duplex frontend-Agent session', () => {
  it('restores ordered conversation memory before returning the connected session', async () => {
    const memory = {
      items: [
        { role: 'user' as const, text: '第一个问题' },
        { role: 'assistant' as const, text: '第一次回答' },
        { role: 'user' as const, text: '继续说' },
      ],
    }
    const connection = await connectTestSession(TEST_VOICE_SESSION_ID, {}, memory)
    try {
      await waitFor(() => connection.frames.length >= 2)
      expect(connection.frames.map(frame => frame.type).slice(0, 2)).toEqual([
        'session.create',
        'conversation.item.create',
      ])
      expect(connection.frames[1]?.items).toEqual([
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '第一个问题' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '第一次回答' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续说' }] },
      ])
    } finally {
      await connection.close()
    }
  })

  it('normalizes stable ASR identities and correlated response text and audio', async () => {
    const connection = await connectTestSession()
    try {
      connection.send({
        type: 'conversation.item.input_audio_transcription.started',
        item_id: 'question-normal',
      })
      connection.send({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'question-normal',
        delta: '帮',
      })
      connection.send({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'question-normal',
        delta: '帮我',
      })
      connection.send({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'question-normal',
        transcript: '这个字段不能覆盖 delta 快照',
      })
      connection.send({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'question-normal',
        text: '你好，请介绍一下。',
      })
      connection.send({
        type: 'response.output_audio.started',
        question_id: 'question-normal',
        response_id: 'response-normal',
      })
      connection.send({
        type: 'response.output_text.delta',
        question_id: 'question-normal',
        response_id: 'response-normal',
        delta: '你好，',
      })
      connection.send({
        type: 'response.output_text.delta',
        question_id: 'question-normal',
        response_id: 'response-normal',
        delta: '我是语音助手。',
      })
      connection.send({ type: 'response.output_audio.delta', response_id: 'response-normal', delta: 'AQI=' })
      connection.send({ type: 'response.output_audio.done', response_id: 'response-normal' })
      connection.send({
        type: 'response.output_text.done',
        question_id: 'question-normal',
        response_id: 'response-normal',
        text: '',
      })
      await waitFor(() => connection.events.some(event => event.type === 'output_text.done'))
      connection.send({
        type: 'conversation.item.input_audio_transcription.started',
        item_id: 'question-failed',
      })
      connection.send({
        type: 'conversation.item.input_audio_transcription.failed',
        item_id: 'question-failed',
        error: { message: 'ASR unavailable' },
      })
      await waitFor(() => connection.events.some(event => event.type === 'transcription.failed'))

      expect(connection.events.filter(event => event.type.startsWith('transcription.'))).toEqual([
        { type: 'transcription.started', utteranceId: inputId('question-normal') },
        { type: 'transcription.updated', utteranceId: inputId('question-normal'), text: '帮' },
        { type: 'transcription.updated', utteranceId: inputId('question-normal'), text: '帮我' },
        { type: 'transcription.completed', utteranceId: inputId('question-normal'), text: '你好，请介绍一下。' },
        { type: 'transcription.started', utteranceId: inputId('question-failed') },
        { type: 'transcription.failed', utteranceId: inputId('question-failed'), message: 'ASR unavailable' },
      ])
      expect(connection.events.filter(event => event.type.startsWith('output_'))).toEqual([
        { type: 'output_audio.started', responseId: responseId('response-normal') },
        {
          type: 'output_text.started',
          utteranceId: responseId('response-normal'),
          responseId: responseId('response-normal'),
        },
        {
          type: 'output_text.delta',
          utteranceId: responseId('response-normal'),
          responseId: responseId('response-normal'),
          text: '你好，',
        },
        {
          type: 'output_text.delta',
          utteranceId: responseId('response-normal'),
          responseId: responseId('response-normal'),
          text: '我是语音助手。',
        },
        { type: 'output_audio.delta', responseId: responseId('response-normal'), audio: Buffer.from([1, 2]) },
        { type: 'output_audio.done', responseId: responseId('response-normal') },
        {
          type: 'output_text.done',
          utteranceId: responseId('response-normal'),
          responseId: responseId('response-normal'),
          text: '你好，我是语音助手。',
        },
      ])
      expect(connection.events.filter(event => event.type === 'response.interrupted')).toEqual([
        { type: 'response.interrupted' },
        { type: 'response.interrupted', responseId: responseId('response-normal') },
      ])
      expect(connection.frames.some(frame => frame.type === 'response.cancel')).toBe(false)
    } finally {
      await connection.close()
    }
  })

  it('namespaces reused provider ids by the live voice transport', async () => {
    const firstVoiceSessionId = VoiceSessionId('voice-first')
    const secondVoiceSessionId = VoiceSessionId('voice-second')
    const [first, second] = await Promise.all([
      connectTestSession(firstVoiceSessionId),
      connectTestSession(secondVoiceSessionId),
    ])
    try {
      for (const connection of [first, second]) {
        connection.send({ type: 'conversation.item.input_audio_transcription.started', item_id: 'shared-question' })
        connection.send({ type: 'response.output_audio.started', response_id: 'shared-response' })
      }
      await waitFor(() => [first, second].every(connection => (
        connection.events.some(event => event.type === 'output_audio.started')
      )))

      expect(first.events.find(event => event.type === 'transcription.started')).toEqual({
        type: 'transcription.started',
        utteranceId: inputId('shared-question', firstVoiceSessionId),
      })
      expect(second.events.find(event => event.type === 'transcription.started')).toEqual({
        type: 'transcription.started',
        utteranceId: inputId('shared-question', secondVoiceSessionId),
      })
      expect(first.events.find(event => event.type === 'output_audio.started')).toEqual({
        type: 'output_audio.started',
        responseId: responseId('shared-response', firstVoiceSessionId),
      })
      expect(second.events.find(event => event.type === 'output_audio.started')).toEqual({
        type: 'output_audio.started',
        responseId: responseId('shared-response', secondVoiceSessionId),
      })
    } finally {
      await Promise.all([first.close(), second.close()])
    }
  })

  it('drops text and audio that arrive after their response is interrupted', async () => {
    const connection = await connectTestSession()
    try {
      connection.send({
        type: 'response.output_audio.started',
        question_id: 'question-old',
        response_id: 'response-old',
      })
      connection.send({
        type: 'response.output_text.delta',
        question_id: 'question-old',
        response_id: 'response-old',
        delta: '旧回复',
      })
      await waitFor(() => connection.events.some(event => event.type === 'output_text.delta'))
      connection.send({
        type: 'conversation.item.input_audio_transcription.started',
        item_id: 'question-interrupt',
      })
      await waitFor(() => connection.frames.some(frame => frame.type === 'response.cancel'))
      const outputCount = connection.events.filter(event => event.type.startsWith('output_')).length

      connection.send({
        type: 'response.output_text.done',
        question_id: 'question-old',
        response_id: 'response-old',
        text: '不应出现的旧回复',
      })
      connection.send({ type: 'response.output_audio.delta', response_id: 'response-old', delta: 'AQI=' })
      connection.send({ type: 'response.output_audio.done', response_id: 'response-old' })
      connection.send({ type: 'response.canceled', event_id: 'late-cancel-ack' })
      await settleSocket()

      expect(connection.events.find(event => event.type === 'response.interrupted')).toEqual({
        type: 'response.interrupted',
        responseId: responseId('response-old'),
      })
      expect(connection.events.filter(event => event.type.startsWith('output_'))).toHaveLength(outputCount)
    } finally {
      await connection.close()
    }
  })

  it('keeps a new response active while rejecting stale events from the superseded response', async () => {
    const connection = await connectTestSession()
    try {
      connection.send({
        type: 'response.output_audio.started',
        question_id: 'question-one',
        response_id: 'response-one',
      })
      connection.send({
        type: 'response.output_audio.started',
        question_id: 'question-two',
        response_id: 'response-two',
      })
      await waitFor(() => connection.events.filter(event => event.type === 'output_audio.started').length === 2)

      connection.send({
        type: 'response.output_text.done',
        question_id: 'question-one',
        response_id: 'response-one',
        text: '迟到的第一条回复',
      })
      connection.send({ type: 'response.output_audio.delta', response_id: 'response-one', delta: 'AQI=' })
      connection.send({ type: 'response.canceled', event_id: 'late-cancel-ack' })
      connection.send({
        type: 'response.output_text.done',
        question_id: 'question-two',
        response_id: 'response-two',
        text: '第二条回复',
      })
      connection.send({ type: 'response.output_audio.delta', response_id: 'response-two', delta: 'AwQ=' })
      connection.send({ type: 'response.output_audio.done', response_id: 'response-two' })
      await waitFor(() => connection.events.some(event => event.type === 'output_audio.done'))

      expect(connection.events.filter(
        (event): event is Extract<VoiceProviderEvent, { responseId: unknown }> => 'responseId' in event,
      ).filter(event => event.responseId === responseId('response-one'))).toEqual([
        { type: 'output_audio.started', responseId: responseId('response-one') },
      ])
      expect(connection.events.filter(event => event.type === 'output_text.done')).toEqual([
        {
          type: 'output_text.done',
          utteranceId: responseId('response-two'),
          responseId: responseId('response-two'),
          text: '第二条回复',
        },
      ])
      expect(connection.events.find(
        event => event.type === 'output_audio.delta' && event.responseId === responseId('response-two'),
      )).toEqual({ type: 'output_audio.delta', responseId: responseId('response-two'), audio: Buffer.from([3, 4]) })
    } finally {
      await connection.close()
    }
  })

  it('carries native commands, results and asynchronous task observations', async () => {
    const connection = await connectTestSession()
    try {
      const create = connection.frames.find(frame => frame.type === 'session.create')
      const sessionConfig = create?.session as RawEvent | undefined
      expect((sessionConfig?.tools as RawEvent[]).map(tool => tool.name)).toEqual([
        'realtime_delegation', 'send_task_message', 'cancel_task',
      ])

      connection.send({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'question-1',
        transcript: '请检查仓库',
      })
      connection.send({
        type: 'response.function_call_arguments.done',
        item_id: 'question-1',
        call_id: 'call-1',
        name: 'realtime_delegation',
        arguments: '{"input":"检查仓库"}',
      })
      await waitFor(() => connection.events.some(event => event.type === 'task.command'))
      const command = connection.events.find(
        (event): event is { type: 'task.command'; call: TaskCommandCall } => event.type === 'task.command',
      )
      if (command === undefined) throw new Error('Duplex command was not emitted')
      const taskId = VoiceTaskId('task-1')
      connection.session.completeTaskCommand(command.call.id, { kind: 'accepted', taskId })
      await waitFor(() => connection.frames.some(frame => frame.type === 'conversation.item.create'))
      expect(connection.frames.find(frame => frame.type === 'conversation.item.create')).toMatchObject({
        items: [{ role: 'tool', call_id: 'call-1' }],
      })

      connection.send({ type: 'response.output_audio.started', response_id: 'receipt-1' })
      connection.send({ type: 'response.output_audio.delta', response_id: 'receipt-1', delta: 'AQI=' })
      connection.send({ type: 'response.output_audio.done', response_id: 'receipt-1' })
      await waitFor(() => connection.events.some(event => event.type === 'output_audio.done'))
      connection.session.playbackEnded()

      connection.session.appendTaskObservation({
        taskId,
        status: 'completed',
        taskTurn: 3,
        channel: 'COMPLETE',
        voiceMessage: { id: VoiceTaskMessageId('assistant-1'), text: '检查完成' },
      })
      connection.session.requestResponse({ kind: 'automatic' })
      await waitFor(() => connection.frames.some(frame => frame.type === 'conversation.item.update'))
      const update = connection.frames.find(frame => frame.type === 'conversation.item.update')
      expect(update).toMatchObject({ items: [{ id: 'question-1' }] })
      const serializedUpdate = JSON.stringify(update)
      expect(serializedUpdate).toContain('请检查仓库\\n\\n[后台任务回灌]\\n状态：已完成\\n结果：检查完成\\n[/后台任务回灌]')
      expect(serializedUpdate).not.toContain('dsh_task_observation')
      expect(serializedUpdate).not.toContain('task-1')
      expect(serializedUpdate).not.toContain('assistant-1')
      expect(serializedUpdate).not.toContain('task_turn')
      expect(serializedUpdate).not.toContain('channel')
      connection.send({ type: 'conversation.item.updated' })
      await waitFor(() => connection.frames.some(frame => frame.type === 'speech_text_buffer.commit'))
      expect(connection.frames.find(frame => frame.type === 'speech_text_buffer.commit')).toMatchObject({
        text: '检查完成',
      })
      expect(connection.frames).not.toContainEqual(expect.objectContaining({ type: 'input_audio_buffer.commit' }))
      expect(connection.events.find(event => event.type === 'output_text.done')).toMatchObject({
        text: '检查完成',
      })
    } finally {
      await connection.close()
    }
  })
})

describe('Duplex speech-shell session', () => {
  it('forwards microphone audio, joins pending speech and filters native replies', async () => {
    const connection = await connectTestSession(TEST_VOICE_SESSION_ID, {
      interactionMode: 'speech-shell',
      triggerAudio: undefined,
      maxDeferredInputAudioBytes: 2,
    })
    try {
      const create = connection.frames.find(frame => frame.type === 'session.create')
      const sessionConfig = create?.session as RawEvent | undefined
      expect(sessionConfig?.tools).toEqual([])

      connection.session.appendAudio(new Uint8Array([1, 2]))
      connection.session.commitAudio()
      await waitFor(() => connection.frames.some(frame => frame.type === 'input_audio_buffer.commit'))
      expect(connection.frames.find(frame => frame.type === 'input_audio_buffer.append')).toMatchObject({ audio: 'AQI=' })

      const taskId = VoiceTaskId('speech-task')
      connection.session.appendTaskObservation({
        taskId,
        status: 'running',
        voiceMessage: { id: VoiceTaskMessageId('speech-message'), text: ' first ' },
      })
      connection.session.appendTaskObservation({ taskId, status: 'running', announcement: ' second ' })
      connection.session.appendTaskObservation({
        taskId,
        status: 'running',
        voiceMessage: { id: VoiceTaskMessageId('blank-message'), text: ' ' },
      })
      connection.session.appendTaskObservation({ taskId, status: 'running' })
      connection.session.requestResponse({ kind: 'automatic' })
      await waitFor(() => connection.frames.some(frame => frame.type === 'speech_text_buffer.commit'))
      expect(connection.frames.find(frame => frame.type === 'speech_text_buffer.commit')).toMatchObject({
        text: 'first\nsecond',
      })
      const speechCount = connection.frames.filter(frame => frame.type === 'speech_text_buffer.commit').length
      connection.session.requestResponse({ kind: 'automatic' })
      await settleSocket()
      expect(connection.frames.filter(frame => frame.type === 'speech_text_buffer.commit')).toHaveLength(speechCount)

      expect(() => {
        connection.session.completeTaskCommand(
          VoiceCommandCallId('speech-call'),
          { kind: 'accepted', taskId },
        )
      }).toThrow('do not accept task commands')
      connection.send({
        type: 'response.function_call_arguments.done',
        item_id: 'ignored-question',
        call_id: 'ignored-call',
        name: 'realtime_delegation',
        arguments: '{"input":"ignored"}',
      })
      connection.send({
        type: 'response.output_audio.started',
        response_id: 'native-response',
        tts_type: 'default',
      })
      connection.send({ type: 'response.output_text.done', response_id: 'native-response', text: 'ignored' })
      connection.send({
        type: 'response.output_audio.started',
        response_id: 'custom-response',
        tts_type: 'chat_tts_text',
      })
      connection.send({ type: 'response.output_text.delta', response_id: 'custom-response', text: 'spoken' })
      connection.send({ type: 'response.output_text.delta', response_id: 'custom-response', delta: '' })
      connection.send({ type: 'response.output_audio.delta', response_id: 'custom-response', delta: 42 })
      connection.send({ type: 'response.output_audio.delta', response_id: 'custom-response', delta: 'AwQ=' })
      connection.send({ type: 'response.output_text.done', response_id: 'custom-response', text: 'spoken' })
      connection.send({ type: 'response.output_audio.done', response_id: 'custom-response' })
      await waitFor(() => connection.events.some(event => event.type === 'output_audio.done'))

      expect(connection.events.some(event => event.type === 'task.command')).toBe(false)
      expect(connection.events.filter(event => event.type === 'output_audio.started')).toEqual([
        { type: 'output_audio.started', responseId: responseId('custom-response') },
      ])
      expect(connection.events.find(event => event.type === 'output_text.delta')).toMatchObject({ text: 'spoken' })
    } finally {
      await connection.session.close()
      await connection.close()
    }
  })
})

describe('Duplex session state guards', () => {
  it('connects with every auth mode and reports live socket errors', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Duplex test server did not bind TCP')
    const observedHeaders: Array<Record<string, string | undefined>> = []
    server.on('connection', (socket, request) => {
      observedHeaders.push({
        authorization: request.headers.authorization,
        appId: request.headers['x-api-app-id'] as string | undefined,
        appKey: request.headers['x-api-app-key'] as string | undefined,
        apiKey: request.headers['x-api-key'] as string | undefined,
      })
      socket.once('message', () => {
        socket.send(JSON.stringify({ type: 'session.updated' }))
        socket.send(JSON.stringify({ type: 'session.created' }))
      })
    })

    const endpoint = `ws://127.0.0.1:${String(address.port)}`
    const events: VoiceProviderEvent[] = []
    try {
      const appKeySession = await DuplexSession.connect(
        providerConfig(endpoint, { authMode: 'app-key' }),
        TEST_VOICE_SESSION_ID,
        (event) => { events.push(event) },
      )
      internals(appKeySession).socket.emit('error', new Error('live socket failed'))
      await appKeySession.close()
      const apiKeySession = await DuplexSession.connect(
        providerConfig(endpoint, { authMode: 'x-api-key' }),
        TEST_VOICE_SESSION_ID,
        (event) => { events.push(event) },
      )
      await apiKeySession.close()

      expect(observedHeaders).toMatchObject([
        { appId: 'test-app-id', appKey: 'test-app-key' },
        { apiKey: 'test-access-key' },
      ])
      expect(events).toContainEqual({ type: 'error', message: 'live socket failed' })
    } finally {
      await closeServer(server)
    }
  })

  it('rejects provider handshake errors and malformed frames', async () => {
    for (const reply of [
      JSON.stringify({ type: 'error', error: { message: 'access denied' } }),
      '{',
    ]) {
      const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
      await once(server, 'listening')
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('Duplex test server did not bind TCP')
      server.on('connection', (socket) => {
        socket.once('message', () => { socket.send(reply) })
      })
      try {
        await expect(DuplexSession.connect(
          providerConfig(`ws://127.0.0.1:${String(address.port)}`),
          TEST_VOICE_SESSION_ID,
          () => {},
        )).rejects.toBeInstanceOf(Error)
      } finally {
        await closeServer(server)
      }
    }

    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Duplex test server did not bind TCP')
    server.on('connection', (socket) => {
      socket.once('message', () => { socket.send(JSON.stringify({ type: 'session.created' })) })
    })
    const parse = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => { throw 'non-error parse failure' })
    try {
      await expect(DuplexSession.connect(
        providerConfig(`ws://127.0.0.1:${String(address.port)}`),
        TEST_VOICE_SESSION_ID,
        () => {},
      )).rejects.toThrow('non-error parse failure')
    } finally {
      parse.mockRestore()
      await closeServer(server)
    }
  })

  it('rejects a socket connection failure', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Duplex test server did not bind TCP')
    await closeServer(server)
    await expect(DuplexSession.connect(
      providerConfig(`ws://127.0.0.1:${String(address.port)}`),
      TEST_VOICE_SESSION_ID,
      () => {},
    )).rejects.toBeInstanceOf(Error)
  })

  it('covers direct transport, timer, queue and close outcomes', async () => {
    const detached = createDetachedSession()
    detached.session.appendAudio(new Uint8Array([1, 2]))
    detached.session.commitAudio()
    await detached.state.sendChain
    expect(detached.socket.frames.map(frame => frame.type)).toEqual([
      'input_audio_buffer.append',
      'input_audio_buffer.commit',
    ])

    detached.state.activationUpload = true
    detached.session.appendAudio(new Uint8Array([1, 2, 3]))
    detached.session.appendAudio(new Uint8Array([4, 5, 6]))
    expect(detached.events.filter(event => event.type === 'error')).toHaveLength(1)
    detached.state.activationUpload = false
    detached.state.flushDeferredInput()
    await detached.state.sendChain

    const retainedOverflow = createDetachedSession('frontend-agent', { maxDeferredInputAudioBytes: 0 })
    retainedOverflow.state.activationUpload = true
    retainedOverflow.state.deferredOverflowReported = true
    const deferred = retainedOverflow.state.deferredInput
    deferred.shift = () => { deferred.length = 0; return undefined }
    retainedOverflow.session.appendAudio(new Uint8Array([1]))
    expect(retainedOverflow.events).toEqual([])

    detached.state.startTranscriptionTimer()
    detached.state.startTranscriptionTimer()
    await new Promise<void>((resolve) => { setTimeout(resolve, 5) })
    await detached.state.sendChain
    detached.state.clearTranscriptionTimer()

    detached.socket.sendError = new Error('send failed')
    detached.state.send({ type: 'probe.send' })
    await detached.state.sendChain
    expect(detached.events.at(-1)).toEqual({ type: 'error', message: 'Error: send failed' })
    detached.socket.sendError = null
    await detached.state.transmit({ type: 'probe.null-success' })
    detached.socket.sendError = new Error('transmit failed')
    await expect(detached.state.transmit({ type: 'probe.failure' })).rejects.toThrow('transmit failed')
    await expect(detached.state.queueWork(async () => { throw new Error('work failed') })).rejects.toThrow('work failed')
    await detached.state.queueWork(async () => {})

    const alreadyClosed = createDetachedSession()
    alreadyClosed.socket.readyState = WebSocket.CLOSED
    await alreadyClosed.session.close()
    const closeFailure = createDetachedSession()
    closeFailure.socket.sendError = new Error('close send failed')
    await closeFailure.session.close()
    await closeFailure.session.close()
  })

  it('validates task-command context and result paths', async () => {
    const detached = createDetachedSession()
    const missingTask = VoiceTaskId('missing-task')
    detached.session.appendTaskObservation({ taskId: missingTask, status: 'running' })
    detached.session.requestResponse({ kind: 'automatic' })

    detached.state.receive({
      type: 'response.function_call_arguments.done',
      items: [42],
    })
    detached.state.receive({
      type: 'response.function_call_arguments.done',
      call_id: 'unsupported-call',
      name: 'unsupported',
      arguments: '{}',
    })
    detached.state.receive({
      type: 'response.function_call_arguments.done',
      call_id: 'orphan-call',
      name: 'realtime_delegation',
      arguments: '{"input":"orphan"}',
    })
    detached.state.receive({ type: 'conversation.item.input_audio_transcription.completed', text: 'fallback question' })
    detached.state.receive({
      type: 'response.function_call_arguments.done',
      question_id: 'question-command',
      call_id: 'delegation-call',
      name: 'realtime_delegation',
      arguments: '{"input":"inspect"}',
    })
    detached.state.receive({
      type: 'response.function_call_arguments.done',
      question_id: 'ignored-duplicate-question',
      call_id: 'delegation-call',
      name: 'realtime_delegation',
      arguments: '{"input":"inspect"}',
    })
    detached.state.receive({
      type: 'response.function_call_arguments.done',
      question_id: 'question-update',
      call_id: 'update-call',
      name: 'send_task_message',
      arguments: '{"delegation_id":"task-command","message":"continue"}',
    })
    detached.state.receive({
      type: 'response.function_call_arguments.done',
      question_id: 'question-cancel',
      call_id: 'cancel-call',
      name: 'cancel_task',
      arguments: '{"delegation_id":"task-command"}',
    })

    expect(() => {
      detached.session.completeTaskCommand(
        VoiceCommandCallId('unknown-call'),
        { kind: 'rejected', code: 'backend_unavailable', message: 'missing' },
      )
    }).toThrow('has no provider question')
    const taskId = VoiceTaskId('task-command')
    detached.session.completeTaskCommand(VoiceCommandCallId('delegation-call'), { kind: 'accepted', taskId })
    detached.session.completeTaskCommand(VoiceCommandCallId('delegation-call'), { kind: 'accepted', taskId })
    detached.session.completeTaskCommand(VoiceCommandCallId('update-call'), { kind: 'accepted', taskId })
    detached.session.completeTaskCommand(VoiceCommandCallId('cancel-call'), {
      kind: 'rejected',
      code: 'task_not_active',
      message: 'finished',
    })
    await detached.state.sendChain

    expect(detached.events.some(event => (
      event.type === 'error' && event.message.includes('must be an object')
    ))).toBe(true)
    expect(detached.events.filter(event => event.type === 'task.command')).toHaveLength(4)
    expect(detached.state.taskProjections.has(taskId)).toBe(true)
    expect(detached.socket.frames.filter(frame => frame.type === 'conversation.item.create').length).toBeGreaterThan(3)
  })

  it('activates task projections, defers input and preserves concurrent revisions', async () => {
    const detached = createDetachedSession('frontend-agent', {
      triggerAudio: new Uint8Array(641),
      maxDeferredInputAudioBytes: 3,
    })
    const taskId = VoiceTaskId('activation-task')
    detached.state.taskProjections.set(taskId, {
      questionId: 'activation-question',
      transcript: '',
      revision: 0,
    })
    detached.session.appendTaskObservation({
      taskId,
      status: 'running',
      taskTurn: 1,
      channel: 'STATUS',
    })
    detached.session.requestResponse({ kind: 'automatic' })
    detached.session.appendAudio(new Uint8Array([1, 2, 3, 4]))
    detached.session.appendTaskObservation({ taskId, status: 'running' })
    await waitFor(() => detached.socket.frames.some(frame => frame.type === 'conversation.item.update'))
    const firstUpdate = JSON.stringify(detached.socket.frames.find(frame => frame.type === 'conversation.item.update'))
    expect(firstUpdate).toContain('[后台任务回灌]\\n状态：执行中\\n[/后台任务回灌]')
    expect(firstUpdate).not.toContain('activation-task')
    expect(firstUpdate).not.toContain('task_turn')
    expect(firstUpdate).not.toContain('channel')
    detached.state.receive({ type: 'conversation.item.updated' })
    await detached.state.sendChain
    await Promise.resolve()

    expect(detached.socket.frames.filter(frame => frame.type === 'input_audio_buffer.append')).toHaveLength(2)
    expect(detached.state.dirtyTasks.has(taskId)).toBe(true)
    detached.state.syntheticInputPending = false
    detached.state.responseExpected = false
    detached.session.requestResponse({ kind: 'automatic' })
    await waitFor(() => detached.socket.frames.filter(frame => frame.type === 'conversation.item.update').length === 2)
    detached.state.receive({ type: 'conversation.item.updated' })
    await detached.state.sendChain
    await Promise.resolve()
    expect(detached.state.dirtyTasks.has(taskId)).toBe(false)

    detached.state.dirtyTasks.add(VoiceTaskId('unknown-projection'))
    detached.state.automaticResponseRequested = true
    detached.state.syntheticInputPending = false
    detached.state.responseExpected = false
    detached.state.pumpAutomaticResponse()
    expect(detached.state.automaticResponseRequested).toBe(false)
  })

  it('updates and reads back context before speaking the exact backend result', async () => {
    const detached = createDetachedSession('frontend-agent', {
      diagnosticTrace: true,
      frontendAgentActivationDelayMs: 1,
    })
    const taskId = VoiceTaskId('diagnostic-task')
    detached.state.taskProjections.set(taskId, {
      questionId: 'diagnostic-question',
      transcript: '检查最后一次提交',
      revision: 0,
    })
    detached.session.appendTaskObservation({
      taskId,
      status: 'completed',
      channel: 'COMPLETE',
      voiceMessage: { id: VoiceTaskMessageId('diagnostic-message'), text: '提交是 abc123' },
    })
    detached.session.requestResponse({ kind: 'automatic' })
    await waitFor(() => detached.socket.frames.some(frame => frame.type === 'conversation.item.update'))
    detached.state.receive({ type: 'conversation.item.updated', event_id: 'provider-update-ack' })
    await waitFor(() => detached.socket.frames.some(frame => frame.type === 'conversation.item.retrieve'))
    detached.state.receive({
      type: 'conversation.item.retrieved',
      item: { id: 'diagnostic-question', content: '检查最后一次提交\n提交是 abc123', audio: 'PCM-SECRET' },
    })
    await detached.state.sendChain
    await Promise.resolve()
    expect(detached.socket.frames.map(frame => frame.type)).toEqual(expect.arrayContaining([
      'conversation.item.update',
      'conversation.item.retrieve',
      'speech_text_buffer.commit',
    ]))
    expect(detached.socket.frames).not.toContainEqual(expect.objectContaining({ type: 'input_audio_buffer.commit' }))
    expect(detached.socket.frames.find(frame => frame.type === 'speech_text_buffer.commit')).toMatchObject({
      text: '提交是 abc123',
    })
    expect(detached.events.find(event => event.type === 'output_text.done')).toMatchObject({
      text: '提交是 abc123',
    })
    const diagnosticTypes = detached.diagnostics.map(entry => entry.type)
    expect(diagnosticTypes).toEqual(expect.arrayContaining([
      'task.observation',
      'conversation.item.update',
      'conversation.item.updated',
      'conversation.item.retrieve',
      'conversation.item.retrieved',
      'speech_text_buffer.commit',
    ]))
    expect(diagnosticTypes.indexOf('conversation.item.retrieved'))
      .toBeLessThan(diagnosticTypes.indexOf('speech_text_buffer.commit'))
    expect(diagnosticTypes).not.toContain('frontend.trigger_audio')
    expect(JSON.stringify(detached.diagnostics)).toContain('提交是 abc123')
    expect(JSON.stringify(detached.diagnostics)).not.toContain('test-access-key')
    expect(JSON.stringify(detached.diagnostics)).not.toContain('PCM-SECRET')
  })

  it('reports unavailable and failed automatic activation paths', async () => {
    const unavailable = createDetachedSession('frontend-agent', { triggerAudio: undefined })
    const unavailableTask = VoiceTaskId('unavailable')
    unavailable.state.taskProjections.set(unavailableTask, {
      questionId: 'unavailable-question',
      transcript: 'question',
      observation: { taskId: unavailableTask, status: 'completed' },
      revision: 1,
    })
    unavailable.state.automaticResponseRequested = true
    unavailable.state.dirtyTasks.add(unavailableTask)
    unavailable.state.pumpAutomaticResponse()
    expect(unavailable.events.at(-1)).toEqual({
      type: 'error',
      message: 'Duplex frontend response has neither backend speech text nor trigger audio',
    })

    const failed = createDetachedSession()
    const failedTask = VoiceTaskId('failed-activation')
    failed.state.taskProjections.set(failedTask, {
      questionId: 'failed-question',
      transcript: 'original',
      observation: { taskId: failedTask, status: 'completed' },
      revision: 1,
    })
    failed.state.dirtyTasks.add(failedTask)
    failed.socket.sendError = new Error('activation transport failed')
    failed.state.automaticResponseRequested = true
    failed.state.pumpAutomaticResponse()
    failed.session.appendAudio(new Uint8Array([1, 2]))
    await failed.state.sendChain
    await Promise.resolve()
    expect(failed.events.at(-1)).toEqual({
      type: 'error',
      message: 'Duplex frontend response activation failed: Error: activation transport failed',
    })

    const closed = createDetachedSession()
    const closedTask = VoiceTaskId('closed-activation')
    closed.state.taskProjections.set(closedTask, {
      questionId: 'closed-question',
      transcript: 'question',
      observation: { taskId: closedTask, status: 'failed', reason: 'failure' },
      revision: 1,
    })
    closed.state.dirtyTasks.add(closedTask)
    closed.state.automaticResponseRequested = true
    closed.state.pumpAutomaticResponse()
    closed.state.closed = true
    await closed.state.sendChain
    await Promise.resolve()
    expect(closed.events.at(-1)).toMatchObject({
      type: 'error',
      message: 'Duplex frontend response activation failed: Error: Duplex session closed during frontend response activation',
    })

    const speech = createDetachedSession('speech-shell')
    speech.state.automaticResponseRequested = true
    speech.state.pumpAutomaticResponse()
    const idle = createDetachedSession()
    idle.state.pumpAutomaticResponse()
    idle.state.automaticResponseRequested = true
    idle.state.closed = true
    idle.state.pumpAutomaticResponse()
    idle.state.closed = false
    idle.state.userTranscribing = true
    idle.state.pumpAutomaticResponse()
  })

  it('covers identity and response-state fallback branches', () => {
    const detached = createDetachedSession()
    const generatedUtterance = detached.state.readUtteranceId({}, true)
    expect(detached.state.readUtteranceId({ item_id: 'ignored-while-active' })).toBe(generatedUtterance)
    detached.state.finishUtterance(VoiceUtteranceId('different'))
    expect(detached.state.activeUtteranceId).toBe(generatedUtterance)
    detached.state.finishUtterance(generatedUtterance)
    const providerUtterance = detached.state.readUtteranceId({ question_id: 'provider-question' }, true)
    expect(providerUtterance).toBe(inputId('provider-question'))

    const eventFallback = detached.state.readResponseId({ event_id: 'provider-event' }, true)
    expect(eventFallback).toBe(responseId('provider-event'))
    detached.state.activeResponseId = eventFallback
    expect(detached.state.readResponseId({})).toBe(eventFallback)
    detached.state.activeResponseId = undefined
    expect(detached.state.readResponseId({}, true)).toMatch(/^voice-test:response:/u)

    expect(detached.state.acceptResponseEvent({ response_id: 'not-started' }, false)).toBeUndefined()
    const accepted = detached.state.acceptResponseEvent({ response_id: 'accepted' }, true)
    expect(accepted).toBe(responseId('accepted'))
    expect(detached.state.acceptResponseEvent({ response_id: 'different' }, true)).toBeUndefined()
    detached.state.retiredResponseIds.add(responseId('retired'))
    expect(detached.state.acceptResponseEvent({ response_id: 'retired' }, true)).toBeUndefined()
    expect(detached.state.startResponse(responseId('retired'))).toBe(false)
    expect(detached.state.startResponse(responseId('replacement'))).toBe(true)

    const completedAudio = createDetachedSession()
    const completedAudioResponse = responseId('completed-audio')
    completedAudio.state.activeResponseId = completedAudioResponse
    completedAudio.state.audioDoneResponseIds.add(completedAudioResponse)
    completedAudio.session.interruptResponse()
    expect(completedAudio.socket.frames).toEqual([])

    const replacement = responseId('replacement')
    detached.state.startOutputText(VoiceUtteranceId(replacement), replacement)
    detached.state.startOutputText(VoiceUtteranceId(replacement), replacement)
    detached.state.retireResponseIfComplete(replacement)
    detached.state.textDoneResponseIds.add(replacement)
    detached.state.audioDoneResponseIds.add(replacement)
    detached.state.retireResponseIfComplete(replacement)
    expect(detached.state.retiredResponseIds.has(replacement)).toBe(true)
  })

  it('covers busy-state discrimination and close notifications', () => {
    const detached = createDetachedSession()
    for (const key of [
      'userTranscribing',
      'outputStreaming',
      'playbackPending',
      'responseExpected',
      'activationInFlight',
      'syntheticInputPending',
    ] as const) {
      detached.state[key] = true
      expect(detached.state.isAutomaticResponseBusy()).toBe(true)
      detached.state[key] = false
    }
    expect(detached.state.isAutomaticResponseBusy()).toBe(false)

    detached.state.onClosed()
    detached.state.onClosed('ignored')
    expect(detached.events.at(-1)).toEqual({ type: 'closed' })
    const emptyReason = createDetachedSession()
    emptyReason.state.onClosed('')
    expect(emptyReason.events).toEqual([{ type: 'closed' }])
    const reason = createDetachedSession()
    reason.state.onClosed('provider shutdown')
    expect(reason.events).toEqual([{ type: 'closed', reason: 'provider shutdown' }])
  })

  it('covers synthetic ASR, response terminals and provider error events', () => {
    const detached = createDetachedSession()
    detached.state.syntheticInputPending = true
    detached.state.receive({ type: 'conversation.item.input_audio_transcription.started' })
    detached.state.receive({ type: 'conversation.item.input_audio_transcription.delta', delta: 'ignored' })
    detached.state.receive({ type: 'conversation.item.input_audio_transcription.completed', text: 'ignored' })
    expect(detached.state.syntheticInputPending).toBe(false)
    detached.state.syntheticInputPending = true
    detached.state.responseExpected = true
    detached.state.receive({
      type: 'conversation.item.input_audio_transcription.failed',
      error: { message: 'synthetic failed' },
    })
    expect(detached.events.at(-1)).toEqual({
      type: 'error',
      message: 'Duplex frontend response trigger transcription failed: synthetic failed',
    })

    detached.state.receive({ type: 'conversation.item.input_audio_transcription.started' })
    detached.state.receive({ type: 'conversation.item.input_audio_transcription.delta', delta: '' })
    detached.state.receive({ type: 'conversation.item.input_audio_transcription.completed', text: 'fallback id' })
    detached.state.receive({ type: 'conversation.item.input_audio_transcription.failed' })

    detached.state.receive({ type: 'response.output_text.delta', response_id: 'text-first', text: 'fallback-text' })
    detached.state.receive({ type: 'response.output_text.delta', response_id: 'text-first' })
    detached.state.receive({ type: 'response.output_text.done', response_id: 'text-first', text: 'final-text' })
    detached.state.receive({ type: 'response.output_text.delta', response_id: 'text-first', delta: 'late' })
    detached.state.receive({ type: 'response.output_text.done', response_id: 'text-first', text: 'duplicate' })
    detached.state.receive({ type: 'response.output_audio.started', response_id: 'text-first', tts_type: 42 })
    detached.state.receive({ type: 'response.output_audio.delta', response_id: 'text-first', delta: 'AQI=' })
    detached.state.receive({ type: 'response.output_audio.done', response_id: 'text-first' })

    detached.state.receive({ type: 'response.output_audio.started', response_id: 'audio-first' })
    detached.state.receive({ type: 'response.output_audio.delta', response_id: 'audio-first' })
    detached.state.receive({ type: 'response.output_audio.done', response_id: 'audio-first' })
    detached.state.receive({ type: 'response.output_audio.done', response_id: 'audio-first' })
    detached.state.receive({ type: 'response.output_text.done', response_id: 'audio-first' })
    detached.state.retiredResponseIds.add(responseId('retired-start'))
    detached.state.receive({ type: 'response.output_audio.started', response_id: 'retired-start' })

    detached.state.responseExpected = true
    detached.state.receive({ type: 'response.canceled' })
    detached.state.activeResponseId = responseId('active-cancel-ack')
    detached.state.responseExpected = true
    detached.state.receive({ type: 'response.canceled' })
    expect(detached.state.responseExpected).toBe(true)
    detached.state.receive({ type: 'error', error: 'provider error' })
    detached.state.receive({ type: 'error' })
    const arrayCheck = vi.spyOn(Array, 'isArray').mockImplementationOnce(() => { throw 'array check failed' })
    detached.state.receive({ type: 'response.function_call_arguments.done', items: [] })
    arrayCheck.mockRestore()
    detached.state.receive({ type: 'unknown.event' })
    detached.state.receive({ type: 42 })
    detached.state.receive({ type: 'session.closed' })
  })

  it('merges task observations across running and terminal updates', () => {
    const detached = createDetachedSession()
    const taskId = VoiceTaskId('merge-task')
    detached.state.taskProjections.set(taskId, {
      questionId: 'merge-question',
      transcript: ' original ',
      revision: 0,
    })
    detached.session.appendTaskObservation({
      taskId,
      status: 'running',
      taskTurn: 2,
      channel: 'STATUS',
      voiceMessage: { id: VoiceTaskMessageId('merge-message'), text: 'working' },
      announcement: 'announced',
      reason: 'reason',
    })
    detached.session.appendTaskObservation({ taskId, status: 'running' })
    expect(detached.state.taskProjections.get(taskId)?.observation).toMatchObject({
      taskTurn: 2,
      channel: 'STATUS',
      voiceMessage: { text: 'working' },
    })
    detached.session.appendTaskObservation({ taskId, status: 'completed' })
    expect(detached.state.taskProjections.get(taskId)?.observation).toEqual({
      taskId,
      status: 'completed',
      taskTurn: 2,
    })
    detached.session.appendTaskObservation({
      taskId,
      status: 'failed',
      channel: 'COMPLETE',
      voiceMessage: { id: VoiceTaskMessageId('failed-message'), text: 'failed' },
      announcement: 'failure announcement',
      reason: 'failure reason',
    })
    detached.session.appendTaskObservation({ taskId, status: 'cancelled', taskTurn: 3 })
    expect(detached.state.taskProjections.get(taskId)?.observation).toEqual({
      taskId,
      status: 'cancelled',
      taskTurn: 3,
    })

    const freshTaskId = VoiceTaskId('fresh-merge-task')
    detached.state.taskProjections.set(freshTaskId, {
      questionId: 'fresh-question',
      transcript: '',
      revision: 0,
    })
    detached.session.appendTaskObservation({ taskId: freshTaskId, status: 'running' })
    expect(detached.state.taskProjections.get(freshTaskId)?.observation).toEqual({
      taskId: freshTaskId,
      status: 'running',
    })
  })
})
