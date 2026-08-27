import type { VoiceAudioProfile } from '@wayneyu430227/dsh-voice'

export type SpeechBackendEvent =
  | { readonly type: 'ready' }
  | { readonly type: 'transcription.started'; readonly utteranceId: string }
  | { readonly type: 'transcription.updated'; readonly utteranceId: string; readonly text: string }
  | { readonly type: 'transcription.completed'; readonly utteranceId: string; readonly text: string }
  | { readonly type: 'transcription.failed'; readonly utteranceId: string; readonly message: string }
  | { readonly type: 'tts.started'; readonly responseId: string }
  | { readonly type: 'tts.delta'; readonly responseId: string; readonly audio: Uint8Array }
  | { readonly type: 'tts.done'; readonly responseId: string }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'closed'; readonly reason?: string }

/** Internal port isolating model/process details from the provider session. */
export interface SpeechBackend {
  readonly audio: VoiceAudioProfile
  start(emit: (event: SpeechBackendEvent) => void): Promise<void>
  appendAudio(audio: Uint8Array): void
  commitAudio(): void
  synthesize(responseId: string, text: string): void
  interrupt(): void
  close(): Promise<void>
}
