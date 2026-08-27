import { randomUUID } from 'node:crypto'
import {
  VoiceResponseId,
  VoiceUtteranceId,
  type TaskObservation,
  type TaskCommandResult,
  type VoiceCommandCallId,
  type VoiceInteractionMode,
  type VoiceProviderEvent,
  type VoiceProviderSession,
  type VoiceResponsePolicy,
  type VoiceSessionId,
} from '@lgquan/dsh-voice'
import type { SpeechBackend, SpeechBackendEvent } from './speech-backend.ts'

const INTERACTION_MODE: VoiceInteractionMode = 'speech-shell'

/** Provider session translating local speech events to the shared voice seam. */
export class LocalSession implements VoiceProviderSession {
  readonly interactionMode = INTERACTION_MODE
  readonly audio
  private closed = false
  private readonly pending: string[] = []
  private readonly pendingSpeech: string[] = []
  private activeResponseId: VoiceResponseId | undefined

  constructor(
    private readonly backend: SpeechBackend,
    private readonly emit: (event: VoiceProviderEvent) => void,
    private readonly voiceSessionId: VoiceSessionId,
  ) {
    this.audio = backend.audio
  }

  async start(): Promise<void> { await this.backend.start(event => this.receive(event)) }
  appendAudio(audio: Uint8Array): void { this.backend.appendAudio(audio) }
  commitAudio(): void { this.backend.commitAudio() }
  interruptResponse(): void {
    const responseId = this.activeResponseId
    this.backend.interrupt()
    this.pendingSpeech.splice(0)
    this.activeResponseId = undefined
    this.emit({ type: 'response.interrupted', ...(responseId === undefined ? {} : { responseId }) })
  }
  playbackEnded(): void {}

  appendTaskObservation(event: TaskObservation): void {
    const text = event.voiceMessage?.text.trim() || event.announcement?.trim()
    if (text !== undefined && text !== '') this.pending.push(text)
  }

  appendSpeechText(text: string): void {
    const trimmed = text.trim()
    if (trimmed !== '') this.pendingSpeech.push(trimmed)
  }

  requestResponse(_policy: VoiceResponsePolicy): void {
    const text = [...this.pending.splice(0), ...this.pendingSpeech.splice(0)].join('\n')
    if (text === '') return
    const responseId = VoiceResponseId(String(this.voiceSessionId) + ':response:' + randomUUID())
    this.activeResponseId = responseId
    this.backend.synthesize(String(responseId), text)
  }

  completeTaskCommand(_callId: VoiceCommandCallId, _result: TaskCommandResult): void {
    throw new Error('local speech-shell sessions do not accept task commands')
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
      case 'transcription.completed': this.emit({ type: 'transcription.completed', utteranceId: VoiceUtteranceId(String(this.voiceSessionId) + ':input:' + event.utteranceId), text: event.text }); return
      case 'transcription.failed': this.emit({ type: 'transcription.failed', utteranceId: VoiceUtteranceId(String(this.voiceSessionId) + ':input:' + event.utteranceId), message: event.message }); return
      case 'tts.started': {
        const responseId = this.responseId(event.responseId)
        this.activeResponseId = responseId
        this.emit({ type: 'output_audio.started', responseId })
        return
      }
      case 'tts.delta': this.emit({ type: 'output_audio.delta', responseId: this.responseId(event.responseId), audio: event.audio }); return
      case 'tts.done': {
        const responseId = this.responseId(event.responseId)
        this.emit({ type: 'output_audio.done', responseId })
        if (this.activeResponseId === responseId) this.activeResponseId = undefined
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
}
