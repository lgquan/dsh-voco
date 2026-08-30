import { randomUUID } from 'node:crypto'
import {
  VoiceCommandCallId,
  VoiceResponseId,
  VoiceTaskId,
  VoiceUtteranceId,
  type TaskCommand,
  type TaskObservation,
  type TaskCommandResult,
  type VoiceInteractionMode,
  type VoiceProviderEvent,
  type VoiceProviderSession,
  type VoiceResponsePolicy,
  type VoiceSessionId,
} from '@flowingspring/dsh-voice'
import type { SpeechBackend, SpeechBackendEvent } from './speech-backend.ts'

/** Provider session translating local speech events to the shared voice seam. */
export class LocalSession implements VoiceProviderSession {
  readonly interactionMode: VoiceInteractionMode
  readonly audio
  private closed = false
  private readonly pending: string[] = []
  private readonly pendingSpeech: string[] = []
  private readonly pendingCommands = new Map<VoiceCommandCallId, TaskCommand>()
  private readonly pendingOutputs: Array<{
    readonly responseId: VoiceResponseId
    readonly utteranceId: VoiceUtteranceId
    readonly text: string
  }> = []
  private activeSpeech: { readonly responseId: VoiceResponseId; readonly utteranceId: VoiceUtteranceId; text: string } | undefined
  private activeTaskId: VoiceTaskId | undefined

  constructor(
    private readonly backend: SpeechBackend,
    private readonly emit: (event: VoiceProviderEvent) => void,
    private readonly voiceSessionId: VoiceSessionId,
    interactionMode: VoiceInteractionMode = 'speech-shell',
  ) {
    this.interactionMode = interactionMode
    this.audio = backend.audio
  }

  async start(): Promise<void> { await this.backend.start(event => this.receive(event)) }
  beginManualUtterance(): void { this.backend.beginManualUtterance() }
  appendAudio(audio: Uint8Array): void { this.backend.appendAudio(audio) }
  commitAudio(): void { this.backend.commitAudio() }
  interruptResponse(): void {
    this.backend.interrupt()
    this.pendingSpeech.splice(0)
    this.pendingOutputs.splice(0)
    this.activeSpeech = undefined
    this.emit({ type: 'response.interrupted' })
  }
  playbackEnded(): void {
    for (const output of this.pendingOutputs.splice(0)) {
      this.emit({
        type: 'output_text.done',
        utteranceId: output.utteranceId,
        responseId: output.responseId,
        text: output.text,
      })
    }
  }

  appendTaskObservation(event: TaskObservation): void {
    const text = event.voiceMessage?.text.trim() || event.announcement?.trim()
    if (text !== undefined && text !== '') this.pending.push(text)
    if (event.taskId === this.activeTaskId && isTerminalTaskStatus(event.status)) {
      this.activeTaskId = undefined
    }
  }

  appendSpeechText(text: string): void {
    if (text.trim() === '') return
    if (this.activeSpeech === undefined) {
      const responseId = VoiceResponseId(String(this.voiceSessionId) + ':response:' + randomUUID())
      const utteranceId = VoiceUtteranceId(String(responseId) + ':text')
      this.activeSpeech = { responseId, utteranceId, text: '' }
      this.pendingOutputs.push(this.activeSpeech)
      this.emit({ type: 'output_text.started', utteranceId, responseId })
    }
    this.activeSpeech.text += text
    this.emit({ type: 'output_text.delta', utteranceId: this.activeSpeech.utteranceId, responseId: this.activeSpeech.responseId, text })
    this.backend.synthesize(String(this.activeSpeech.responseId), text)
  }

  requestResponse(_policy: VoiceResponsePolicy): void {
    const text = [...this.pending.splice(0), ...this.pendingSpeech.splice(0)].join('\n')
    if (text !== '') this.appendSpeechText(text)
    const responseId = this.activeSpeech?.responseId
    this.activeSpeech = undefined
    if (responseId !== undefined) this.backend.finishSynthesis?.(String(responseId))
  }

  completeTaskCommand(callId: VoiceCommandCallId, result: TaskCommandResult): void {
    if (this.interactionMode === 'speech-shell') {
      throw new Error('local speech-shell sessions do not accept task commands')
    }
    const command = this.pendingCommands.get(callId)
    if (command === undefined) return
    this.pendingCommands.delete(callId)
    if (result.kind === 'accepted'
      && (command.type === 'route_transcription' || command.type === 'realtime_delegation')) {
      this.activeTaskId = result.taskId
    } else if (result.kind === 'rejected' && command.type === 'send_task_message'
      && (result.code === 'task_not_active' || result.code === 'task_not_found')) {
      this.activeTaskId = undefined
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.backend.close()
  }

  private receive(event: SpeechBackendEvent): void {
    switch (event.type) {
      case 'ready': return
      case 'transcription.started': this.emit({ type: 'transcription.started', utteranceId: VoiceUtteranceId(String(this.voiceSessionId) + ':input:' + event.utteranceId) }); return
      case 'transcription.updated': this.emit({ type: 'transcription.updated', utteranceId: VoiceUtteranceId(String(this.voiceSessionId) + ':input:' + event.utteranceId), text: event.text }); return
      case 'transcription.completed': {
        const utteranceId = VoiceUtteranceId(String(this.voiceSessionId) + ':input:' + event.utteranceId)
        this.emit({ type: 'transcription.completed', utteranceId, text: event.text })
        const text = event.text.trim()
        if (text === '') return
        if (this.interactionMode === 'frontend-agent') {
          this.emitTaskCommand(this.activeTaskId === undefined
            ? { type: 'route_transcription', input: text }
            : { type: 'send_task_message', taskId: this.activeTaskId, message: text })
        }
        this.interruptResponse()
        return
      }
      case 'transcription.failed': this.emit({ type: 'transcription.failed', utteranceId: VoiceUtteranceId(String(this.voiceSessionId) + ':input:' + event.utteranceId), message: event.message }); return
      case 'tts.started': {
        const responseId = this.responseId(event.responseId)
        this.emit({ type: 'output_audio.started', responseId })
        return
      }
      case 'tts.delta': this.emit({ type: 'output_audio.delta', responseId: this.responseId(event.responseId), audio: event.audio }); return
      case 'tts.done': {
        const responseId = this.responseId(event.responseId)
        this.emit({ type: 'output_audio.done', responseId })
        return
      }
      case 'error': this.emit({ type: 'error', message: event.message }); return
      case 'closed': this.emit({ type: 'closed', ...(event.reason === undefined ? {} : { reason: event.reason }) }); return
    }
  }

  private responseId(value: string): VoiceResponseId {
    return VoiceResponseId(value.startsWith(String(this.voiceSessionId) + ':response:')
      ? value
      : String(this.voiceSessionId) + ':response:' + value)
  }

  private emitTaskCommand(command: TaskCommand): void {
    const id = VoiceCommandCallId(String(this.voiceSessionId) + ':task:' + randomUUID())
    this.pendingCommands.set(id, command)
    this.emit({ type: 'task.command', call: { id, command } })
  }
}

function isTerminalTaskStatus(status: TaskObservation['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted'
}
