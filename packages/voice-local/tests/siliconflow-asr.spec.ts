import { describe, expect, it, vi } from 'vitest'
import { NodeSpeechBackend, SiliconFlowAsr, pcm16MonoWav } from '../src/index.ts'
import type { SpeechBackendEvent } from '../src/speech-backend.ts'

const edgeTtsMocks = vi.hoisted(() => ({
  synthesize: vi.fn(async () => new Uint8Array([1, 2, 3])),
}))

vi.mock('../src/edge-tts.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/edge-tts.ts')>(),
  synthesizeEdgeSpeech: edgeTtsMocks.synthesize,
}))

describe('SiliconFlow cloud ASR', () => {
  it('encodes PCM16 mono audio as a valid WAV file', () => {
    const pcm = new Uint8Array([1, 2, 3, 4])
    const wav = pcm16MonoWav(pcm, 16_000)
    const view = new DataView(wav.buffer)
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF')
    expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe('WAVE')
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getUint32(40, true)).toBe(4)
    expect(wav.subarray(44)).toEqual(pcm)
  })

  it('uploads multipart WAV audio with the configured model', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      expect(init?.headers).toEqual({ Authorization: 'Bearer test-key' })
      const form = init?.body as FormData
      expect(form.get('model')).toBe('XingChenAGI/XingChenASR-V3.2-Ultra')
      const file = form.get('file')
      expect(file).toBeInstanceOf(Blob)
      expect((file as Blob).type).toBe('audio/wav')
      return new Response(JSON.stringify({ text: '识别成功。' }), { status: 200 })
    })
    const asr = new SiliconFlowAsr({
      apiKey: 'test-key', endpoint: 'https://example.test/asr',
      model: 'XingChenAGI/XingChenASR-V3.2-Ultra', timeoutMs: 1_000, fetch,
    })
    await expect(asr.transcribe(new Uint8Array([1, 0, 2, 0]), 16_000)).resolves.toBe('识别成功。')
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('reports the provider response when transcription fails', async () => {
    const asr = new SiliconFlowAsr({
      apiKey: 'invalid', endpoint: 'https://example.test/asr', model: 'test-model', timeoutMs: 1_000,
      fetch: async () => new Response('{"message":"unauthorized"}', { status: 401 }),
    })
    await expect(asr.transcribe(new Uint8Array([1, 0]), 16_000))
      .rejects.toThrow('SiliconFlow ASR returned 401')
  })

  it('submits one utterance after the configured silence duration', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => (
      new Response(JSON.stringify({ text: '云端结果' }), { status: 200 })
    ))
    const backend = new NodeSpeechBackend({
      apiKey: 'test-key', endpoint: 'https://example.test/asr', model: 'test-model',
      requestTimeoutMs: 1_000, inputSampleRate: 16_000, outputSampleRate: 48_000,
      ttsRate: '+20%',
      silenceDurationMs: 400, speechThreshold: 0.01, preRollMs: 200,
      trailingSilenceMs: 100, maxUtteranceMs: 5_000, minSpeechDurationMs: 200, fetch,
    })
    const events: SpeechBackendEvent[] = []
    await backend.start(event => events.push(event))
    backend.appendAudio(pcmFrame(0.2, 200))
    backend.appendAudio(pcmFrame(0, 200))
    backend.appendAudio(pcmFrame(0, 200))
    await vi.waitFor(() => {
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'transcription.started' }),
        expect.objectContaining({ type: 'transcription.completed', text: '云端结果' }),
      ]))
    })
    expect(fetch).toHaveBeenCalledOnce()
    await backend.close()
  })

  it('ignores a short noise spike without uploading or opening a transcription', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => (
      new Response(JSON.stringify({ text: '' }), { status: 200 })
    ))
    const backend = new NodeSpeechBackend({
      apiKey: 'test-key', endpoint: 'https://example.test/asr', model: 'test-model',
      requestTimeoutMs: 1_000, inputSampleRate: 16_000, outputSampleRate: 48_000,
      ttsRate: '+20%',
      silenceDurationMs: 400, speechThreshold: 0.01, preRollMs: 200,
      trailingSilenceMs: 100, maxUtteranceMs: 5_000, fetch,
    })
    const events: SpeechBackendEvent[] = []
    await backend.start(event => events.push(event))

    backend.appendAudio(pcmFrame(0.2, 80))
    backend.appendAudio(pcmFrame(0, 400))
    await Promise.resolve()
    await Promise.resolve()
    await backend.close()

    expect(fetch).not.toHaveBeenCalled()
    expect(events.filter(event => event.type.startsWith('transcription.'))).toEqual([])
  })

  it('does not interrupt playback when a long noise candidate produces empty ASR', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => (
      new Response(JSON.stringify({ text: '' }), { status: 200 })
    ))
    const backend = new NodeSpeechBackend({
      apiKey: 'test-key', endpoint: 'https://example.test/asr', model: 'test-model',
      requestTimeoutMs: 1_000, inputSampleRate: 16_000, outputSampleRate: 48_000,
      ttsRate: '+20%', silenceDurationMs: 400, speechThreshold: 0.01, preRollMs: 200,
      trailingSilenceMs: 100, maxUtteranceMs: 5_000, minSpeechDurationMs: 200, fetch,
    })
    const interrupt = vi.spyOn(backend, 'interrupt')
    const events: SpeechBackendEvent[] = []
    await backend.start(event => events.push(event))

    backend.appendAudio(pcmFrame(0.2, 200))
    backend.appendAudio(pcmFrame(0, 400))
    await vi.waitFor(() => { expect(fetch).toHaveBeenCalledOnce() })
    await vi.waitFor(() => {
      expect(events).toContainEqual(expect.objectContaining({ type: 'transcription.failed' }))
    })

    expect(interrupt).not.toHaveBeenCalled()
    await backend.close()
  })

  it('passes the configured relative speech rate to Edge TTS', async () => {
    const backend = new NodeSpeechBackend({
      apiKey: 'test-key', endpoint: 'https://example.test/asr', model: 'test-model',
      requestTimeoutMs: 1_000, inputSampleRate: 16_000, outputSampleRate: 48_000,
      ttsRate: '+20%', silenceDurationMs: 400, speechThreshold: 0.01, preRollMs: 200,
      trailingSilenceMs: 100, maxUtteranceMs: 5_000,
    })
    const events: SpeechBackendEvent[] = []
    await backend.start(event => events.push(event))
    backend.synthesize('response-rate', '语速测试。')
    backend.finishSynthesis('response-rate')

    await vi.waitFor(() => {
      expect(edgeTtsMocks.synthesize).toHaveBeenCalledWith('语速测试。', '+20%')
      expect(events).toEqual(expect.arrayContaining([
        { type: 'tts.started', responseId: 'response-rate' },
        { type: 'tts.delta', responseId: 'response-rate', audio: new Uint8Array([1, 2, 3]) },
        { type: 'tts.done', responseId: 'response-rate' },
      ]))
    })
    await backend.close()
  })
})

function pcmFrame(amplitude: number, milliseconds: number): Uint8Array {
  const samples = Math.round(16_000 * milliseconds / 1_000)
  const output = new Uint8Array(samples * 2)
  const view = new DataView(output.buffer)
  for (let index = 0; index < samples; index += 1) {
    view.setInt16(index * 2, Math.round(amplitude * 32767), true)
  }
  return output
}
