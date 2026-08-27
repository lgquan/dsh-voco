import { VoiceResponseId, VoiceSessionId, VoiceTaskId } from '@lgquan/dsh-voice'
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
    session.playbackEnded()

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

  it('routes completed ASR before starting a background delegation in frontend-agent mode', async () => {
    const backend = new MemoryBackend()
    const events: unknown[] = []
    const session = new LocalSession(
      backend,
      event => events.push(event),
      VoiceSessionId('voice-frontend-test'),
      'frontend-agent',
    )
    await session.start()
    backend.emit?.({ type: 'transcription.completed', utteranceId: 'input-2', text: '检查项目状态' })
    backend.emit?.({ type: 'transcription.completed', utteranceId: 'input-3', text: '   ' })

    expect(events).toEqual(expect.arrayContaining([{
      type: 'task.command',
      call: expect.objectContaining({
        command: { type: 'route_transcription', input: '检查项目状态' },
      }),
    }]))
    expect(events.filter(event => (event as { type?: string }).type === 'task.command')).toHaveLength(1)
    expect(session.interactionMode).toBe('frontend-agent')

    const firstCommand = events.find(event => (event as { type?: string }).type === 'task.command') as {
      call: { id: never }
    }
    session.completeTaskCommand(firstCommand.call.id, { kind: 'handled' })
    backend.emit?.({ type: 'transcription.completed', utteranceId: 'input-task', text: '修改项目文件' })
    const taskCommand = events.findLast(event => (
      (event as { type?: string }).type === 'task.command'
    )) as { call: { id: never } }
    session.completeTaskCommand(taskCommand.call.id, { kind: 'accepted', taskId: VoiceTaskId('task-fixed') })
    backend.emit?.({ type: 'transcription.completed', utteranceId: 'input-4', text: '再检查测试' })
    expect(events.at(-1)).toMatchObject({
      type: 'task.command',
      call: { command: { type: 'send_task_message', taskId: 'task-fixed', message: '再检查测试' } },
    })

    session.appendTaskObservation({ taskId: VoiceTaskId('task-fixed'), status: 'completed' })
    backend.emit?.({ type: 'transcription.completed', utteranceId: 'input-5', text: '开始下一项' })
    expect(events.at(-1)).toMatchObject({
      type: 'task.command',
      call: { command: { type: 'route_transcription', input: '开始下一项' } },
    })
  })

  it('projects exactly the same response text into the UI text stream and TTS', () => {
    const backend = new MemoryBackend()
    const events: unknown[] = []
    const session = new LocalSession(backend, event => events.push(event), VoiceSessionId('voice-output'))
    session.appendTaskObservation({
      taskId: VoiceTaskId('task-output'),
      status: 'completed',
      voiceMessage: { id: 'message-output' as never, text: '第一句完成。第二句请确认。' },
    })
    session.requestResponse({ kind: 'automatic' })

    expect(events.find(event => (event as { type?: string }).type === 'output_text.done')).toBeUndefined()
    session.playbackEnded()
    expect(events.find(event => (event as { type?: string }).type === 'output_text.done')).toMatchObject({
      type: 'output_text.done',
      text: '第一句完成。第二句请确认。',
    })
    expect(backend.synthesize).toHaveBeenCalledWith(expect.any(String), '第一句完成。第二句请确认。')

    session.appendSpeechText('独立模型重写后的第一句。')
    session.appendSpeechText('这是同一条回复的第二句。')
    session.requestResponse({ kind: 'automatic' })
    expect(events.findLast(event => (event as { type?: string }).type === 'output_text.delta')).toMatchObject({
      type: 'output_text.delta',
      text: '独立模型重写后的第一句。\n这是同一条回复的第二句。',
    })
    expect(backend.synthesize).toHaveBeenLastCalledWith(
      expect.any(String),
      '独立模型重写后的第一句。\n这是同一条回复的第二句。',
    )
  })
})
