import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Process-local identity of one attached voice transport. */
export type VoiceSessionId = Branded<'VoiceSessionId'>

/**
 * Brand a raw id as a voice-session identity.
 * @param value - raw identity.
 * @returns branded identity.
 */
export function VoiceSessionId(value: string): VoiceSessionId {
  return value as VoiceSessionId
}

/** Identity of the single task delegation currently associated with a voice session. */
export type VoiceTaskId = Branded<'VoiceTaskId'>

/**
 * Brand a raw id as a voice-task identity.
 * @param value - raw identity.
 * @returns branded identity.
 */
export function VoiceTaskId(value: string): VoiceTaskId {
  return value as VoiceTaskId
}

/** Stable identity of one user or assistant utterance within a voice conversation. */
export type VoiceUtteranceId = Branded<'VoiceUtteranceId'>

/**
 * Brand a raw id as a voice-utterance identity.
 * @param value - provider or locally minted utterance identity.
 * @returns branded identity.
 */
export function VoiceUtteranceId(value: string): VoiceUtteranceId {
  return value as VoiceUtteranceId
}

/** Provider-scoped identity of one generated response. */
export type VoiceResponseId = Branded<'VoiceResponseId'>

/**
 * Brand a raw id as a voice-response identity.
 * @param value - provider response identity.
 * @returns branded identity.
 */
export function VoiceResponseId(value: string): VoiceResponseId {
  return value as VoiceResponseId
}

/** Provider-session-scoped identity of one frontend tool call. */
export type VoiceCommandCallId = Branded<'VoiceCommandCallId'>

/**
 * Brand a raw id as a frontend command-call identity.
 * @param value - provider call identity.
 * @returns branded identity.
 */
export function VoiceCommandCallId(value: string): VoiceCommandCallId {
  return value as VoiceCommandCallId
}

/** Stable identity of one backend message delivered to a realtime voice Agent. */
export type VoiceTaskMessageId = Branded<'VoiceTaskMessageId'>

/**
 * Brand a raw id as a backend voice-message identity.
 * @param value - raw identity.
 * @returns branded identity.
 */
export function VoiceTaskMessageId(value: string): VoiceTaskMessageId {
  return value as VoiceTaskMessageId
}

/** Whether the provider is a speech transport or a conversational frontend Agent. */
export type VoiceInteractionMode = 'speech-shell' | 'frontend-agent'

/** One completed conversational turn restored into a fresh provider session. */
export interface VoiceConversationItem {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

/** Bounded conversational context restored after a provider session restart. */
export interface VoiceConversationMemory {
  readonly items: readonly VoiceConversationItem[]
}

/** Audio parameters negotiated for a voice session. */
export interface VoiceAudioProfile {
  readonly inputSampleRate: number
  readonly outputSampleRate: number
  readonly format: 'pcm_s16le' | 'audio_mpeg'
}

/** Policy deciding when pending observations become a spoken response. */
export type VoiceResponsePolicy = { readonly kind: 'automatic' }

/** User intent extracted by the voice provider. */
export type TaskCommand =
  | { readonly type: 'realtime_delegation'; readonly input: string; readonly transcriptDelta?: string }
  | { readonly type: 'send_task_message'; readonly taskId: VoiceTaskId; readonly message: string }
  | { readonly type: 'cancel_task'; readonly taskId: VoiceTaskId }

/** One validated orchestration call emitted by a frontend voice Agent. */
export interface TaskCommandCall {
  readonly id: VoiceCommandCallId
  readonly command: TaskCommand
}

/** Typed completion returned to the frontend Agent for one orchestration call. */
export type TaskCommandResult =
  | { readonly kind: 'accepted'; readonly taskId: VoiceTaskId }
  | {
    readonly kind: 'rejected'
    readonly code: 'invalid_command' | 'task_active' | 'task_not_found' | 'task_not_active' | 'backend_unavailable' | 'capacity_exceeded'
    readonly message: string
  }

/** One backend-authored message delivered through a task observation. */
export interface VoiceTaskMessage {
  readonly id: VoiceTaskMessageId
  readonly text: string
}

/** Durable beginning of one streamed voice utterance. */
export interface VoiceUtteranceStart {
  readonly utteranceId: VoiceUtteranceId
  readonly role: 'user' | 'assistant'
  readonly responseId?: VoiceResponseId
}

/** Durable terminal text for one streamed voice utterance. */
export interface VoiceUtteranceEnd {
  readonly utteranceId: VoiceUtteranceId
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly state: 'completed' | 'interrupted'
  readonly responseId?: VoiceResponseId
}

/** Durable link from a voice delegation to its independent task session. */
export interface VoiceTaskDelegated {
  readonly taskId: VoiceTaskId
  readonly taskSessionId: SessionId
  readonly input: string
}

/** Durable binding from one Voice conversation to its long-lived task Agent. */
export interface VoiceTaskSessionBound {
  readonly taskSessionId: SessionId
}

/** Provider-independent task state appended by an Agent consumer. */
export type VoiceTaskEventType = 'progress' | 'result' | 'warning' | 'error' | 'question'

/** Provider-independent task state appended by an Agent consumer. */
export interface TaskObservation {
  readonly taskId: VoiceTaskId
  readonly status: 'accepted' | 'queued' | 'running' | 'waiting-user' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  readonly taskTurn?: number
  readonly type?: VoiceTaskEventType
  readonly detail?: string
  readonly voiceHint?: string
  readonly channel?: 'STATUS' | 'COMPLETE'
  readonly voiceMessage?: VoiceTaskMessage
  readonly announcement?: string
  readonly reason?: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Opens one durable user or assistant utterance before live text deltas arrive.
     * @param event - utterance identity, role, and optional provider response identity.
     */
    'voice/utterance-start': VoiceUtteranceStart
    /**
     * Closes one durable utterance with its final visible text.
     * @param event - completed or interrupted utterance text.
     */
    'voice/utterance-end': VoiceUtteranceEnd
    /**
     * Links one voice delegation to the independent DSH session executing it.
     * @param event - delegation identity, target session, and submitted task text.
     */
    'voice/task-delegated': VoiceTaskDelegated
    /**
     * Binds the Voice conversation to its long-lived task Agent Session.
     * @param event - durable task-session identity.
     */
    'voice/task-session-bound': VoiceTaskSessionBound
    /**
     * Provider-independent task state made visible to a realtime voice Agent.
     * @param event - latest status or backend-authored message for one delegation.
     */
    'voice/task-observation': TaskObservation
  }
}

/** Provider events delivered to the assistant driver and browser carrier. */
export type VoiceProviderEvent =
  | { readonly type: 'transcription.started'; readonly utteranceId: VoiceUtteranceId }
  | { readonly type: 'transcription.updated'; readonly utteranceId: VoiceUtteranceId; readonly text: string }
  | { readonly type: 'transcription.completed'; readonly utteranceId: VoiceUtteranceId; readonly text: string }
  | { readonly type: 'transcription.failed'; readonly utteranceId: VoiceUtteranceId; readonly message: string }
  | { readonly type: 'output_text.started'; readonly utteranceId: VoiceUtteranceId; readonly responseId: VoiceResponseId }
  | { readonly type: 'output_text.delta'; readonly utteranceId: VoiceUtteranceId; readonly responseId: VoiceResponseId; readonly text: string }
  | { readonly type: 'output_text.done'; readonly utteranceId: VoiceUtteranceId; readonly responseId: VoiceResponseId; readonly text: string }
  | { readonly type: 'output_audio.started'; readonly responseId: VoiceResponseId }
  | { readonly type: 'output_audio.delta'; readonly responseId: VoiceResponseId; readonly audio: Uint8Array }
  | { readonly type: 'output_audio.done'; readonly responseId: VoiceResponseId }
  | { readonly type: 'response.interrupted'; readonly responseId?: VoiceResponseId }
  | { readonly type: 'task.command'; readonly call: TaskCommandCall }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'closed'; readonly reason?: string }

/** Event exposed by the seam. */
export type VoiceEvent = VoiceProviderEvent | { readonly type: 'task.observation'; readonly observation: TaskObservation }

/** One provider-owned connected session. */
export interface VoiceProviderSession {
  readonly audio: VoiceAudioProfile
  readonly interactionMode: VoiceInteractionMode
  appendAudio(audio: Uint8Array): void
  commitAudio(): void
  interruptResponse(): void
  playbackEnded(): void
  appendTaskObservation(event: TaskObservation): void
  /** Queue plain speech text without persisting it as a task observation. */
  appendSpeechText?(text: string): void
  requestResponse(policy: VoiceResponsePolicy): void
  completeTaskCommand(callId: VoiceCommandCallId, result: TaskCommandResult): void
  close(): Promise<void>
}

/** Provider registration face. */
export interface VoiceProvider {
  readonly id: string
  available(): boolean
  connect(input: {
    readonly voiceSessionId: VoiceSessionId
    readonly agentSessionId: SessionId
    readonly memory?: VoiceConversationMemory
    readonly emit: (event: VoiceProviderEvent) => void
  }): Promise<VoiceProviderSession>
}

/** Public metadata for one attached voice session. */
export interface VoiceSessionInfo {
  readonly id: VoiceSessionId
  readonly agentSessionId: SessionId
  readonly audio: VoiceAudioProfile
  readonly interactionMode: VoiceInteractionMode
}
