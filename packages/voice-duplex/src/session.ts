/** One connected ByteDance Duplex speech-shell or frontend-Agent session. @module @wayneyu430227/dsh-voice-duplex/session */
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import {
  VoiceResponseId as responseId,
  VoiceUtteranceId as utteranceId,
  type TaskCommandCall,
  type TaskCommandResult,
  type TaskObservation,
  type VoiceCommandCallId,
  type VoiceConversationMemory,
  type VoiceInteractionMode,
  type VoiceProviderEvent,
  type VoiceProviderSession,
  type VoiceResponseId,
  type VoiceResponsePolicy,
  type VoiceSessionId,
  type VoiceTaskId,
  type VoiceUtteranceId,
} from '@wayneyu430227/dsh-voice'
import {
  audioAppend,
  conversationTextCreateItem,
  conversationTextUpdateItem,
  decodeEvent,
  decodeTaskCommandCalls,
  duplexTaskCommandTools,
  errorMessage,
  eventText,
  taskCommandResultItem,
  type RawEvent,
} from './protocol.ts'

/** Fully resolved provider options. */
export interface ResolvedConfig {
  readonly interactionMode: VoiceInteractionMode
  readonly endpoint: string
  readonly accessKey: string
  readonly authMode: 'app-key' | 'x-api-key' | 'bearer'
  readonly appId: string
  readonly appKey: string
  readonly resourceId: string
  readonly model: string
  readonly speaker: string
  readonly instructions: string
  readonly triggerAudio: Uint8Array | undefined
  readonly maxDeferredInputAudioBytes: number
  readonly frontendAgentActivationDelayMs: number
  readonly endSmoothWindowMs: number
  readonly enableCustomVad: boolean
  readonly transcriptionDeltaTimeoutMs: number
  readonly diagnosticTrace: boolean
}

/** One redacted semantic checkpoint from a diagnostic Duplex session. */
export interface DuplexDiagnosticEntry {
  readonly elapsedMs: number
  readonly direction: 'internal' | 'upstream' | 'downstream'
  readonly type: string
  readonly data?: unknown
}

const AUDIO = { inputSampleRate: 16_000, outputSampleRate: 24_000, format: 'pcm_s16le' as const }
const CUSTOM_TTS_TYPES = new Set(['chat_tts_text', 'external_rag'])
const TRIGGER_CHUNK_BYTES = 640
const TRIGGER_CHUNK_INTERVAL_MS = 20
const UPDATE_ACK_TIMEOUT_MS = 2500

interface CommandContext {
  readonly questionId: string
  readonly command: TaskCommandCall['command']
}

interface TaskProjection {
  readonly questionId: string
  readonly transcript: string
  observation?: TaskObservation
  revision: number
}

/** Provider session implementing raw audio plus the configured interaction mode. */
export class DuplexSession implements VoiceProviderSession {
  readonly audio = AUDIO
  readonly interactionMode: VoiceInteractionMode
  private readonly socket: WebSocket
  private readonly diagnosticStartedAt = performance.now()
  private sendChain = Promise.resolve()
  private eventId = 0
  private closed = false
  private transcriptionTimer: ReturnType<typeof setTimeout> | undefined
  private activeUtteranceId: VoiceUtteranceId | undefined
  private readonly pending: string[] = []
  private generation = 0
  private activeResponseId: VoiceResponseId | undefined
  private readonly retiredResponseIds = new Set<VoiceResponseId>()
  private readonly textStartedResponseIds = new Set<VoiceResponseId>()
  private readonly textDoneResponseIds = new Set<VoiceResponseId>()
  private readonly audioDoneResponseIds = new Set<VoiceResponseId>()
  private readonly responseTexts = new Map<VoiceResponseId, string>()
  private latestQuestionId: string | undefined
  private userTranscribing = false
  private outputStreaming = false
  private playbackPending = false
  private playbackResponseId: VoiceResponseId | undefined
  private responseExpected = false
  private automaticResponseRequested = false
  private activationInFlight = false
  private activationUpload = false
  private syntheticInputPending = false
  private resolveUpdateAck: (() => void) | undefined
  private resolveRetrieve: (() => void) | undefined
  private deferredInputBytes = 0
  private deferredOverflowReported = false
  private readonly deferredInput: Uint8Array[] = []
  private readonly questionTranscripts = new Map<string, string>()
  private readonly commandContexts = new Map<VoiceCommandCallId, CommandContext>()
  private readonly taskProjections = new Map<VoiceTaskId, TaskProjection>()
  private readonly dirtyTasks = new Set<VoiceTaskId>()

  private constructor(
    socket: WebSocket,
    private readonly emit: (event: VoiceProviderEvent) => void,
    private readonly config: ResolvedConfig,
    private readonly voiceSessionId: VoiceSessionId,
    private readonly diagnostic?: (entry: DuplexDiagnosticEntry) => void,
  ) {
    this.socket = socket
    this.interactionMode = config.interactionMode
  }

  /**
   * Connect and complete the session.create handshake.
   * @param config - resolved config.
   * @param voiceSessionId - transport identity used to namespace provider-local ids.
   * @param emit - normalized event receiver.
   * @param diagnostic - optional receiver for redacted semantic checkpoints.
   * @param memory - bounded durable history for a fresh frontend conversation.
   * @returns live session.
   */
  static async connect(
    config: ResolvedConfig,
    voiceSessionId: VoiceSessionId,
    emit: (event: VoiceProviderEvent) => void,
    diagnostic?: (entry: DuplexDiagnosticEntry) => void,
    memory?: VoiceConversationMemory,
  ): Promise<DuplexSession> {
    const socket = await connectSocket(config)
    const session = new DuplexSession(socket, emit, config, voiceSessionId, diagnostic)
    await session.handshake()
    socket.on('message', (data) => { session.receive(decodeEvent(data)) })
    socket.on('close', (_code, reason) => { session.onClosed(reason.toString()) })
    socket.on('error', (error) => { emit({ type: 'error', message: error.message }) })
    await session.restoreConversation(memory)
    return session
  }

  /** Restore durable text history before a fresh frontend session starts receiving audio. */
  async restoreConversation(memory: VoiceConversationMemory | undefined): Promise<void> {
    if (this.interactionMode !== 'frontend-agent' || memory === undefined || memory.items.length === 0) return
    this.trace('upstream', 'conversation.item.create.restore', { count: memory.items.length })
    await this.queue({
      type: 'conversation.item.create',
      event_id: this.newEventId(),
      items: memory.items.map(conversationTextCreateItem),
    })
  }

  appendAudio(audio: Uint8Array): void {
    if (this.interactionMode === 'frontend-agent' && this.activationUpload) {
      this.deferInputAudio(audio)
      return
    }
    this.send(audioAppend(audio))
  }
  commitAudio(): void { this.send({ type: 'input_audio_buffer.commit', event_id: this.newEventId() }) }
  interruptResponse(): void {
    const providerResponseId = this.activeResponseId
    const interruptedResponseId = this.playbackResponseId ?? providerResponseId
    this.generation += 1
    if (providerResponseId !== undefined) {
      const providerResponseActive = !this.audioDoneResponseIds.has(providerResponseId)
      this.retireResponse(providerResponseId)
      if (providerResponseActive) this.send({ type: 'response.cancel' })
    }
    if (interruptedResponseId !== undefined && interruptedResponseId !== providerResponseId) {
      this.retireResponse(interruptedResponseId)
    }
    this.outputStreaming = false
    this.playbackPending = false
    this.playbackResponseId = undefined
    this.responseExpected = false
    this.emit({
      type: 'response.interrupted',
      ...(interruptedResponseId === undefined ? {} : { responseId: interruptedResponseId }),
    })
    this.pumpAutomaticResponse()
  }
  playbackEnded(): void {
    this.playbackPending = false
    this.playbackResponseId = undefined
    this.pumpAutomaticResponse()
  }

  appendTaskObservation(event: TaskObservation): void {
    this.trace('internal', 'task.observation', event)
    if (this.interactionMode === 'frontend-agent') {
      const projection = this.taskProjections.get(event.taskId)
      if (projection === undefined) {
        this.emit({ type: 'error', message: `Duplex task observation has no provider question for task "${event.taskId}"` })
        return
      }
      projection.observation = mergeTaskObservation(projection.observation, event)
      projection.revision += 1
      this.dirtyTasks.add(event.taskId)
      return
    }
    const text = event.voiceMessage?.text ?? event.announcement
    if (text !== undefined && text.trim() !== '') this.pending.push(text.trim())
  }

  requestResponse(_policy: VoiceResponsePolicy): void {
    if (this.interactionMode === 'frontend-agent') {
      if (this.dirtyTasks.size === 0) return
      this.automaticResponseRequested = true
      this.pumpAutomaticResponse()
      return
    }
    const text = this.pending.splice(0).join('\n')
    if (text === '') return
    const speechId = randomUUID()
    this.generation += 1
    this.send({ type: 'speech_text_buffer.commit', event_id: this.newEventId(), speech_id: speechId, text })
  }

  completeTaskCommand(callId: VoiceCommandCallId, result: TaskCommandResult): void {
    if (this.interactionMode !== 'frontend-agent') {
      throw new Error('Duplex speech-shell sessions do not accept task commands')
    }
    const context = this.commandContexts.get(callId)
    if (context === undefined) throw new Error(`Duplex command call "${callId}" has no provider question`)
    if (result.kind === 'accepted' && context.command.type === 'realtime_delegation' && !this.taskProjections.has(result.taskId)) {
      this.taskProjections.set(result.taskId, {
        questionId: context.questionId,
        transcript: this.questionTranscripts.get(context.questionId) ?? '',
        revision: 0,
      })
    }
    this.responseExpected = true
    this.trace('upstream', 'conversation.item.create', { callId, result })
    this.send({
      type: 'conversation.item.create',
      event_id: this.newEventId(),
      items: [taskCommandResultItem(callId, result)],
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.clearTranscriptionTimer()
    await this.queue({ type: 'session.close', event_id: this.newEventId() }).catch(() => {})
    await new Promise<void>((resolve) => {
      if (this.socket.readyState === WebSocket.CLOSED) { resolve(); return }
      this.socket.once('close', () => { resolve() })
      this.socket.close()
    })
  }

  private async handshake(): Promise<void> {
    const sessionId = randomUUID()
    const created = new Promise<void>((resolve, reject) => {
      const message = (data: WebSocket.RawData): void => {
        try {
          const event = decodeEvent(data)
          if (event.type === 'session.created') { this.socket.off('message', message); resolve() }
          else if (event.type === 'error') { this.socket.off('message', message); reject(new Error(`Duplex session.create failed: ${errorMessage(event.error)}`)) }
        } catch (error) {
          this.socket.off('message', message)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      }
      this.socket.on('message', message)
    })
    this.trace('upstream', 'session.create', {
      sessionId,
      model: this.config.model,
      instructions: this.config.instructions,
      tools: this.interactionMode === 'frontend-agent'
        ? duplexTaskCommandTools().map(tool => tool.name)
        : [],
    })
    await this.queue({
      type: 'session.create',
      event_id: this.newEventId(),
      session: {
        id: sessionId,
        model: this.config.model,
        instructions: this.config.instructions,
        tools: this.interactionMode === 'frontend-agent' ? duplexTaskCommandTools() : [],
        audio: {
          input: { format: { type: 'pcm_s16le', rate: AUDIO.inputSampleRate } },
          output: { format: { type: 'pcm_s16le', rate: AUDIO.outputSampleRate }, voice: this.config.speaker },
        },
      },
      extension: {
        asr: { extra: { end_smooth_window_ms: this.config.endSmoothWindowMs, enable_custom_vad: this.config.enableCustomVad } },
        tts: { extra: {} },
        dialog: { extra: { audit_response: '抱歉，这个问题我无法回答，你可以换个其他话题，我会尽力为你提供帮助。', enable_loudness_norm: true, enable_music: true } },
      },
    })
    await created
  }

  private receive(event: RawEvent): void {
    const type = typeof event.type === 'string' ? event.type : ''
    switch (type) {
      case 'conversation.item.input_audio_transcription.started':
        if (this.syntheticInputPending) return
        this.userTranscribing = true
        this.interruptResponse()
        this.startTranscriptionTimer()
        this.activeUtteranceId = this.readUtteranceId(event, true)
        this.emit({ type: 'transcription.started', utteranceId: this.activeUtteranceId })
        return
      case 'conversation.item.input_audio_transcription.delta': {
        if (this.syntheticInputPending) return
        this.clearTranscriptionTimer()
        const text = typeof event.delta === 'string' ? event.delta : ''
        if (text !== '') this.emit({ type: 'transcription.updated', utteranceId: this.readUtteranceId(event), text })
        return
      }
      case 'conversation.item.input_audio_transcription.completed': {
        this.clearTranscriptionTimer()
        if (this.syntheticInputPending) {
          this.trace('downstream', type, {
            synthetic: true,
            itemId: stringId(event.item_id, event.question_id),
            transcript: eventText(event),
          })
          this.syntheticInputPending = false
          return
        }
        this.userTranscribing = false
        const text = eventText(event)
        const questionId = stringId(event.item_id, event.question_id)
        if (questionId !== undefined) {
          this.latestQuestionId = questionId
          this.questionTranscripts.set(questionId, text)
        }
        this.trace('downstream', type, { synthetic: false, questionId, transcript: text })
        const currentUtteranceId = this.readUtteranceId(event)
        this.emit({ type: 'transcription.completed', utteranceId: currentUtteranceId, text })
        this.finishUtterance(currentUtteranceId)
        this.pumpAutomaticResponse()
        return
      }
      case 'conversation.item.input_audio_transcription.failed':
        this.clearTranscriptionTimer()
        if (this.syntheticInputPending) {
          this.syntheticInputPending = false
          this.responseExpected = false
          this.emit({ type: 'error', message: `Duplex frontend response trigger transcription failed: ${errorMessage(event.error)}` })
          return
        }
        this.userTranscribing = false
        const currentUtteranceId = this.readUtteranceId(event)
        this.emit({
          type: 'transcription.failed',
          utteranceId: currentUtteranceId,
          message: errorMessage(event.error),
        })
        this.finishUtterance(currentUtteranceId)
        this.pumpAutomaticResponse()
        return
      case 'conversation.item.updated':
        this.trace('downstream', type, event)
        this.resolveUpdateAck?.()
        this.resolveUpdateAck = undefined
        return
      case 'conversation.item.retrieved':
        this.trace('downstream', type, event)
        this.resolveRetrieve?.()
        this.resolveRetrieve = undefined
        return
      case 'response.function_call_arguments.done':
        if (this.interactionMode === 'frontend-agent') this.receiveTaskCommands(event)
        return
      case 'response.output_text.delta': {
        const currentResponseId = this.acceptResponseEvent(event, this.interactionMode === 'frontend-agent')
        if (currentResponseId === undefined || this.textDoneResponseIds.has(currentResponseId)) return
        const responseUtteranceId = utteranceId(currentResponseId)
        this.startOutputText(responseUtteranceId, currentResponseId)
        const text = typeof event.delta === 'string' ? event.delta : eventText(event)
        if (text === '') return
        this.responseTexts.set(currentResponseId, `${this.responseTexts.get(currentResponseId) ?? ''}${text}`)
        this.emit({
          type: 'output_text.delta',
          utteranceId: responseUtteranceId,
          responseId: currentResponseId,
          text,
        })
        return
      }
      case 'response.output_text.done': {
        const currentResponseId = this.acceptResponseEvent(event, this.interactionMode === 'frontend-agent')
        if (currentResponseId === undefined || this.textDoneResponseIds.has(currentResponseId)) return
        const responseUtteranceId = utteranceId(currentResponseId)
        this.startOutputText(responseUtteranceId, currentResponseId)
        const text = eventText(event) || this.responseTexts.get(currentResponseId) || ''
        this.trace('downstream', type, { responseId: currentResponseId, text })
        this.responseTexts.delete(currentResponseId)
        this.emit({
          type: 'output_text.done',
          utteranceId: responseUtteranceId,
          responseId: currentResponseId,
          text,
        })
        this.textDoneResponseIds.add(currentResponseId)
        this.retireResponseIfComplete(currentResponseId)
        return
      }
      case 'response.output_audio.started': {
        const ttsType = typeof event.tts_type === 'string' ? event.tts_type : ''
        const currentResponseId = this.readResponseId(event, true)
        if (this.interactionMode === 'speech-shell' && !CUSTOM_TTS_TYPES.has(ttsType)) {
          this.retireResponse(currentResponseId)
          return
        }
        if (!this.startResponse(currentResponseId)) return
        this.responseExpected = false
        this.outputStreaming = true
        this.playbackPending = true
        this.playbackResponseId = currentResponseId
        this.emit({ type: 'output_audio.started', responseId: currentResponseId })
        return
      }
      case 'response.output_audio.delta': {
        const currentResponseId = this.acceptResponseEvent(event, false)
        if (currentResponseId === undefined || this.audioDoneResponseIds.has(currentResponseId)) return
        if (typeof event.delta !== 'string') return
        this.emit({ type: 'output_audio.delta', responseId: currentResponseId, audio: Buffer.from(event.delta, 'base64') })
        return
      }
      case 'response.output_audio.done': {
        const currentResponseId = this.acceptResponseEvent(event, false)
        if (currentResponseId === undefined || this.audioDoneResponseIds.has(currentResponseId)) return
        this.outputStreaming = false
        this.emit({ type: 'output_audio.done', responseId: currentResponseId })
        this.audioDoneResponseIds.add(currentResponseId)
        this.retireResponseIfComplete(currentResponseId)
        return
      }
      case 'session.closed': this.onClosed(); return
      case 'response.canceled':
        if (this.activeResponseId === undefined) this.responseExpected = false
        this.pumpAutomaticResponse()
        return
      case 'error':
        if (this.activeResponseId !== undefined) this.retireResponse(this.activeResponseId)
        this.responseExpected = false
        this.outputStreaming = false
        this.playbackPending = false
        this.playbackResponseId = undefined
        this.emit({ type: 'error', message: errorMessage(event.error) })
        this.pumpAutomaticResponse()
        return
      default: return
    }
  }

  private receiveTaskCommands(event: RawEvent): void {
    let commands
    try {
      commands = decodeTaskCommandCalls(event)
    } catch (error) {
      this.emit({ type: 'error', message: error instanceof Error ? error.message : String(error) })
      return
    }
    const questionId = stringId(event.item_id, event.question_id) ?? this.latestQuestionId
    for (const decoded of commands) {
      if (decoded.kind === 'rejected') {
        this.sendTaskCommandResult(decoded.callId, decoded.result)
        continue
      }
      if (questionId === undefined) {
        this.sendTaskCommandResult(decoded.call.id, {
          kind: 'rejected',
          code: 'backend_unavailable',
          message: 'Duplex task command has no originating question',
        })
        continue
      }
      if (!this.commandContexts.has(decoded.call.id)) {
        this.commandContexts.set(decoded.call.id, { questionId, command: decoded.call.command })
      }
      this.trace('downstream', 'task.command', { questionId, call: decoded.call })
      this.emit({ type: 'task.command', call: decoded.call })
    }
  }

  private sendTaskCommandResult(callId: VoiceCommandCallId, result: TaskCommandResult): void {
    this.responseExpected = true
    this.trace('upstream', 'conversation.item.create', { callId, result })
    this.send({
      type: 'conversation.item.create',
      event_id: this.newEventId(),
      items: [taskCommandResultItem(callId, result)],
    })
  }

  private pumpAutomaticResponse(): void {
    if (this.interactionMode !== 'frontend-agent'
      || !this.automaticResponseRequested
      || this.closed
      || this.isAutomaticResponseBusy()) return
    const revisions = new Map<VoiceTaskId, number>()
    const items: RawEvent[] = []
    const speechTexts: string[] = []
    for (const taskId of this.dirtyTasks) {
      const projection = this.taskProjections.get(taskId)
      if (projection?.observation === undefined) continue
      revisions.set(taskId, projection.revision)
      const speechText = taskObservationSpeechText(projection.observation)
      if (speechText !== undefined) speechTexts.push(speechText)
      items.push(conversationTextUpdateItem(
        projection.questionId,
        renderTaskProjection(projection.transcript, projection.observation),
      ))
    }
    if (items.length === 0) {
      this.automaticResponseRequested = false
      return
    }
    const speechText = speechTexts.join('\n')
    const triggerAudio = this.config.triggerAudio
    if (speechText === '' && triggerAudio === undefined) {
      this.automaticResponseRequested = false
      this.emit({ type: 'error', message: 'Duplex frontend response has neither backend speech text nor trigger audio' })
      return
    }
    this.automaticResponseRequested = false
    this.activationInFlight = true
    this.activationUpload = true
    this.syntheticInputPending = speechText === ''
    this.responseExpected = true
    const activation = this.queueWork(async () => {
      // The provider must apply the context update before the trigger audio starts
      // a new inference turn; otherwise the model answers the trigger without the
      // backfilled observation and hallucinates. Await the provider's ack (with a
      // fallback timeout so a missing ack cannot wedge the automatic-response lane).
      const updateEventId = this.newEventId()
      this.trace('upstream', 'conversation.item.update', { eventId: updateEventId, items })
      const updated = this.waitForUpdateAck(UPDATE_ACK_TIMEOUT_MS)
      await this.transmit({ type: 'conversation.item.update', event_id: updateEventId, items })
      await updated
      if (this.config.diagnosticTrace) {
        const questionIds = items.flatMap(item => typeof item.id === 'string' ? [item.id] : [])
        const retrieveEventId = this.newEventId()
        const retrieved = this.waitForRetrieve(UPDATE_ACK_TIMEOUT_MS)
        this.trace('upstream', 'conversation.item.retrieve', { eventId: retrieveEventId, questionIds })
        await this.transmit({
          type: 'conversation.item.retrieve',
          event_id: retrieveEventId,
          items: questionIds.map(id => ({ id })),
        })
        await retrieved
      }
      if (speechText !== '') {
        const eventId = this.newEventId()
        const speechId = randomUUID()
        const speechResponseId = responseId(`${this.voiceSessionId}:response:speech:${speechId}`)
        const speechUtteranceId = utteranceId(speechResponseId)
        this.generation += 1
        this.trace('upstream', 'speech_text_buffer.commit', { eventId, speechId, text: speechText })
        await this.transmit({ type: 'speech_text_buffer.commit', event_id: eventId, speech_id: speechId, text: speechText })
        this.emit({ type: 'output_text.started', utteranceId: speechUtteranceId, responseId: speechResponseId })
        this.emit({
          type: 'output_text.done',
          utteranceId: speechUtteranceId,
          responseId: speechResponseId,
          text: speechText,
        })
        return
      }
      if (this.config.frontendAgentActivationDelayMs > 0) {
        this.trace('internal', 'frontend.activation_delay', {
          milliseconds: this.config.frontendAgentActivationDelayMs,
        })
        await wait(this.config.frontendAgentActivationDelayMs)
      }
      if (triggerAudio === undefined) throw new Error('Duplex frontend response trigger audio is unavailable')
      this.trace('internal', 'frontend.trigger_audio', { bytes: triggerAudio.byteLength })
      for (let offset = 0; offset < triggerAudio.byteLength; offset += TRIGGER_CHUNK_BYTES) {
        if (this.closed) throw new Error('Duplex session closed during frontend response activation')
        await this.transmit(audioAppend(triggerAudio.subarray(offset, offset + TRIGGER_CHUNK_BYTES)))
        if (offset + TRIGGER_CHUNK_BYTES < triggerAudio.byteLength) await wait(TRIGGER_CHUNK_INTERVAL_MS)
      }
      const commitEventId = this.newEventId()
      this.trace('upstream', 'input_audio_buffer.commit', { eventId: commitEventId, synthetic: true })
      await this.transmit({ type: 'input_audio_buffer.commit', event_id: commitEventId })
    })
    void activation.then(() => {
      for (const [taskId, revision] of revisions) {
        if (this.taskProjections.get(taskId)?.revision === revision) this.dirtyTasks.delete(taskId)
      }
      this.activationInFlight = false
      this.activationUpload = false
      this.flushDeferredInput()
    }, (error: unknown) => {
      this.activationInFlight = false
      this.activationUpload = false
      this.syntheticInputPending = false
      this.responseExpected = false
      this.flushDeferredInput()
      this.emit({ type: 'error', message: `Duplex frontend response activation failed: ${String(error)}` })
    })
  }

  private isAutomaticResponseBusy(): boolean {
    return this.userTranscribing
      || this.outputStreaming
      || this.playbackPending
      || this.responseExpected
      || this.activationInFlight
      || this.syntheticInputPending
  }

  /** Resolve when the provider acks the in-flight context update, or after the fallback timeout. */
  private waitForUpdateAck(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        this.trace('internal', 'conversation.item.update.timeout', { timeoutMs })
        settle()
      }, timeoutMs)
      const settle = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.resolveUpdateAck = undefined
        resolve()
      }
      this.resolveUpdateAck = settle
    })
  }

  /** Resolve when diagnostic readback arrives, or after the fallback timeout. */
  private waitForRetrieve(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        this.trace('internal', 'conversation.item.retrieve.timeout', { timeoutMs })
        settle()
      }, timeoutMs)
      const settle = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.resolveRetrieve = undefined
        resolve()
      }
      this.resolveRetrieve = settle
    })
  }

  private deferInputAudio(audio: Uint8Array): void {
    const copied = audio.slice()
    this.deferredInput.push(copied)
    this.deferredInputBytes += copied.byteLength
    while (this.deferredInputBytes > this.config.maxDeferredInputAudioBytes && this.deferredInput.length !== 0) {
      const removed = this.deferredInput.shift()
      this.deferredInputBytes -= removed?.byteLength ?? 0
      if (!this.deferredOverflowReported) {
        this.deferredOverflowReported = true
        this.emit({ type: 'error', message: 'Duplex frontend response activation dropped the oldest deferred microphone audio' })
      }
    }
  }

  private flushDeferredInput(): void {
    const chunks = this.deferredInput.splice(0)
    this.deferredInputBytes = 0
    this.deferredOverflowReported = false
    if (this.closed) return
    for (const chunk of chunks) this.send(audioAppend(chunk))
  }

  private readUtteranceId(event: RawEvent, fresh = false): VoiceUtteranceId {
    if (!fresh && this.activeUtteranceId !== undefined) return this.activeUtteranceId
    const providerId = stringId(event.item_id, event.question_id)
    if (providerId !== undefined) {
      const value = utteranceId(`${this.voiceSessionId}:input:${providerId}`)
      this.activeUtteranceId = value
      return value
    }
    const value = utteranceId(`${this.voiceSessionId}:input:${randomUUID()}`)
    this.activeUtteranceId = value
    return value
  }

  private finishUtterance(value: VoiceUtteranceId): void {
    if (this.activeUtteranceId === value) this.activeUtteranceId = undefined
  }

  private readResponseId(event: RawEvent, fresh = false): VoiceResponseId {
    const providerId = stringId(event.response_id)
    if (providerId !== undefined) return responseId(`${this.voiceSessionId}:response:${providerId}`)
    if (!fresh && this.activeResponseId !== undefined) return this.activeResponseId
    return responseId(`${this.voiceSessionId}:response:${stringId(event.event_id) ?? randomUUID()}`)
  }

  private acceptResponseEvent(event: RawEvent, mayStart: boolean): VoiceResponseId | undefined {
    const currentResponseId = this.readResponseId(event)
    if (this.retiredResponseIds.has(currentResponseId)) return undefined
    if (this.activeResponseId === undefined) {
      if (!mayStart) return undefined
      this.activeResponseId = currentResponseId
      return currentResponseId
    }
    return currentResponseId === this.activeResponseId ? currentResponseId : undefined
  }

  private startResponse(value: VoiceResponseId): boolean {
    if (this.retiredResponseIds.has(value)) return false
    if (this.activeResponseId !== undefined && this.activeResponseId !== value) {
      this.retireResponse(this.activeResponseId)
    }
    this.activeResponseId = value
    return true
  }

  private startOutputText(currentUtteranceId: VoiceUtteranceId, currentResponseId: VoiceResponseId): void {
    if (this.textStartedResponseIds.has(currentResponseId)) return
    this.textStartedResponseIds.add(currentResponseId)
    this.emit({ type: 'output_text.started', utteranceId: currentUtteranceId, responseId: currentResponseId })
  }

  private retireResponseIfComplete(value: VoiceResponseId): void {
    if (this.textDoneResponseIds.has(value) && this.audioDoneResponseIds.has(value)) this.retireResponse(value)
  }

  private retireResponse(value: VoiceResponseId): void {
    this.retiredResponseIds.add(value)
    this.textStartedResponseIds.delete(value)
    this.textDoneResponseIds.delete(value)
    this.audioDoneResponseIds.delete(value)
    this.responseTexts.delete(value)
    if (this.activeResponseId === value) this.activeResponseId = undefined
  }

  private startTranscriptionTimer(): void {
    this.clearTranscriptionTimer()
    this.transcriptionTimer = setTimeout(() => { this.commitAudio() }, this.config.transcriptionDeltaTimeoutMs)
  }
  private clearTranscriptionTimer(): void {
    if (this.transcriptionTimer !== undefined) clearTimeout(this.transcriptionTimer)
    this.transcriptionTimer = undefined
  }
  private newEventId(): string { this.eventId += 1; return `event_${String(this.eventId)}` }
  private trace(direction: DuplexDiagnosticEntry['direction'], type: string, data?: unknown): void {
    if (!this.config.diagnosticTrace || this.diagnostic === undefined) return
    this.diagnostic({
      elapsedMs: Math.round(performance.now() - this.diagnosticStartedAt),
      direction,
      type,
      ...(data === undefined ? {} : { data: redactDiagnosticData(data) }),
    })
  }
  private send(event: RawEvent): void {
    void this.queue(event).catch((error: unknown) => { this.emit({ type: 'error', message: String(error) }) })
  }
  private queue(event: RawEvent): Promise<void> {
    return this.queueWork(async () => { await this.transmit(event) })
  }
  private queueWork(operation: () => Promise<void>): Promise<void> {
    const work = this.sendChain.then(operation)
    this.sendChain = work.catch(() => {})
    return work
  }
  private transmit(event: RawEvent): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // ws delegates to socket.write, which reports success as null despite the public optional-Error type.
      this.socket.send(JSON.stringify(event), (error: Error | null | undefined) => {
        if (error !== undefined && error !== null) reject(error)
        else resolve()
      })
    })
  }
  private onClosed(reason?: string): void {
    if (this.closed) return
    this.closed = true
    this.clearTranscriptionTimer()
    this.emit({ type: 'closed', ...(reason === undefined || reason === '' ? {} : { reason }) })
  }
}

function mergeTaskObservation(current: TaskObservation | undefined, next: TaskObservation): TaskObservation {
  const terminal = next.status === 'completed' || next.status === 'failed' || next.status === 'cancelled'
  const message = next.voiceMessage ?? (terminal ? undefined : current?.voiceMessage)
  const channel = next.channel ?? (terminal ? undefined : current?.channel)
  return {
    taskId: next.taskId,
    status: next.status,
    ...(next.taskTurn === undefined
      ? current?.taskTurn === undefined ? {} : { taskTurn: current.taskTurn }
      : { taskTurn: next.taskTurn }),
    ...(channel === undefined ? {} : { channel }),
    ...(message === undefined ? {} : { voiceMessage: message }),
    ...(next.announcement === undefined ? {} : { announcement: next.announcement }),
    ...(next.reason === undefined ? {} : { reason: next.reason }),
  }
}

function renderTaskProjection(transcript: string, observation: TaskObservation): string {
  const message = observation.voiceMessage?.text.trim()
  const announcement = observation.announcement?.trim()
  const reason = observation.reason?.trim()
  const lines = ['[后台任务回灌]', `状态：${taskStatusText(observation.status)}`]
  if (message !== undefined && message !== '') {
    const label = observation.status === 'completed'
      ? '结果'
      : observation.status === 'running' || observation.status === 'accepted' ? '进度' : '说明'
    lines.push(`${label}：${message}`)
  } else if (announcement !== undefined && announcement !== '') {
    lines.push(`通知：${announcement}`)
  }
  if ((observation.status === 'failed' || observation.status === 'cancelled')
    && reason !== undefined && reason !== '') lines.push(`原因：${reason}`)
  lines.push('[/后台任务回灌]')
  const prefix = transcript.trim() === '' ? '' : `${transcript.trim()}\n\n`
  return `${prefix}${lines.join('\n')}`
}

function taskObservationSpeechText(observation: TaskObservation): string | undefined {
  const text = observation.voiceMessage?.text.trim() || observation.announcement?.trim()
  return text === undefined || text === '' ? undefined : text
}

function taskStatusText(status: TaskObservation['status']): string {
  switch (status) {
    case 'accepted': return '已接收'
    case 'running': return '执行中'
    case 'completed': return '已完成'
    case 'failed': return '失败'
    case 'cancelled': return '已取消'
  }
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, milliseconds) })
}

function stringId(...values: unknown[]): string | undefined {
  const value = values.find(item => typeof item === 'string' && item !== '')
  return typeof value === 'string' ? value : undefined
}

function redactDiagnosticData(value: unknown): unknown {
  if (value instanceof Uint8Array) return `[${String(value.byteLength)} PCM bytes redacted]`
  if (Array.isArray(value)) return value.map(redactDiagnosticData)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    key.toLowerCase().includes('audio') ? '[audio redacted]' : redactDiagnosticData(item),
  ]))
}

async function connectSocket(config: ResolvedConfig): Promise<WebSocket> {
  const headers: Record<string, string> = config.authMode === 'app-key' ? {
    'X-Api-App-ID': config.appId,
    'X-Api-Access-Key': config.accessKey,
    'X-Api-Resource-Id': config.resourceId,
    'X-Api-App-Key': config.appKey,
    'X-Api-Connect-Id': randomUUID(),
  } : config.authMode === 'x-api-key' ? { 'X-Api-Key': config.accessKey } : { Authorization: `Bearer ${config.accessKey}` }
  return await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(config.endpoint, { headers })
    socket.once('open', () => { resolve(socket) })
    socket.once('error', reject)
  })
}
