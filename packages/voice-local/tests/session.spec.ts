import { VoiceResponseId, VoiceSessionId } from '@wayneyu430227/dsh-voice'
import { describe, expect, it, vi } from 'vitest'
import { LocalSession } from '../src/index.ts'
import type { SpeechBackend, SpeechBackendEvent } from '../src/speech-backend.ts'

class MemoryBackend implements SpeechBackend {
  readonly audio = { inputSampleRate: 16_000, outputSampleRate: 48_000, format: 'pcm_s16le' as const }
  emit: ((event: SpeechBackendEvent) => void) | undefined
  readonly synthesize = vi.fn<(responseId: string, text: string) => void>()
  readonly interrupt = vi.fn()
  start = vi.fn(async (emit: (event: SpeechBackendEvent) => void) => { this.emit = emit; emit({ type: 'ready' }) })
  appendAudio = vi.fn()
  commitAudio = vi.fn()
  close = vi.fn(async () => {})
}

describe('LocalSession', () => {
  it('maps local ASR and streamed TTS events to the provider seam', async () => {
    const backend = new MemoryBackend()
    const events: unknown[] = []
    const session = new LocalSession(backend, event => events.push(event), VoiceSessionId('voice-local-test'))
    await session.start()
    backend.emit?.({ type: 'transcription.started', utteranceId: 'input-1' })
    backend.emit?.({ type: 'transcription.updated', utteranceId: 'input-1', text: '检查' })
    backend.emit?.({ type: 'transcription.completed', utteranceId: 'input-1', text: '检查完成' })
    session.appendTaskObservation({
      taskId: 'task-1' as never,
      status: 'completed',
      voiceMessage: { id: 'message-1' as never, text: '已经完成。' },
    })
    session.requestResponse({ kind: 'automatic' })
    const responseId = VoiceResponseId('voice-local-test:response:r1')
    backend.emit?.({ type: 'tts.started', responseId })
    backend.emit?.({ type: 'tts.delta', responseId, audio: new Uint8Array([1, 2]) })
    backend.emit?.({ type: 'tts.done', responseId })

    expect(backend.start).toHaveBeenCalledTimes(1)
    expect(backend.synthesize).toHaveBeenCalledWith(expect.stringMatching(/^voice-local-test:response:/), '已经完成。')
    expect(events).toEqual(expect.arrayContaining([
      { type: 'transcription.started', utteranceId: 'voice-local-test:input:input-1' },
      { type: 'transcription.completed', utteranceId: 'voice-local-test:input:input-1', text: '检查完成' },
      { type: 'output_audio.started', responseId },
      { type: 'output_audio.delta', responseId, audio: new Uint8Array([1, 2]) },
      { type: 'output_audio.done', responseId },
    ]))
  })

  it('interrupts TTS without cancelling task observations', () => {
    const backend = new MemoryBackend()
    const session = new LocalSession(backend, () => {}, VoiceSessionId('voice-local-test'))
    session.interruptResponse()
    expect(backend.interrupt).toHaveBeenCalledTimes(1)
  })
})
