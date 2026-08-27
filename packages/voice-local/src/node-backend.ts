import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import type { VoiceAudioProfile } from '@lgquan/dsh-voice'
import { assertModelsInstalled, createModelLayout, type LocalModelLayout } from './model-layout.ts'
import { MossTts } from './moss-tts.ts'
import type { SpeechBackend, SpeechBackendEvent } from './speech-backend.ts'

const INPUT_SAMPLE_RATE = 16_000
const VAD_WINDOW_SIZE = 512
const ASR_CHUNK_SAMPLES = 9_600
const TTS_CHUNK_SAMPLES = 12_000

export interface NodeSpeechConfig {
  readonly modelRoot: string
  readonly startupTimeoutMs: number
  readonly inputSampleRate: number
  readonly outputSampleRate: number
  readonly threads: number
  readonly voice: string
  readonly maxTtsFrames?: number
}

/** In-process Node/ONNX adapter; model details remain behind SpeechBackend. */
export class NodeSpeechBackend implements SpeechBackend {
  readonly audio: VoiceAudioProfile
  private emit: ((event: SpeechBackendEvent) => void) | undefined
  private vad: import('sherpa-onnx-node').Vad | undefined
  private recognizer: import('sherpa-onnx-node').OnlineRecognizer | undefined
  private tts: MossTts | undefined
  private buffered = new Float32Array()
  private activeUtteranceId: string | undefined
  private recognitionQueue: Promise<void> = Promise.resolve()
  private synthesisQueue: Promise<void> = Promise.resolve()
  private synthesisGeneration = 0
  private closed = false

  constructor(private readonly config: NodeSpeechConfig) {
    if (config.inputSampleRate !== INPUT_SAMPLE_RATE) throw new Error('local ONNX speech requires 16000 Hz microphone audio')
    this.audio = { inputSampleRate: config.inputSampleRate, outputSampleRate: config.outputSampleRate, format: 'pcm_s16le' }
  }

  async start(emit: (event: SpeechBackendEvent) => void): Promise<void> {
    if (this.emit !== undefined) throw new Error('local speech backend is already started')
    this.emit = emit
    const layout = createModelLayout(this.config.modelRoot)
    await assertModelsInstalled(layout)
    const loading = this.loadModels(layout)
    await withTimeout(loading, this.config.startupTimeoutMs, 'local ONNX speech models did not load in time')
    emit({ type: 'ready' })
  }

  appendAudio(audio: Uint8Array): void {
    if (this.closed || audio.byteLength === 0) return
    if (audio.byteLength % 2 !== 0) {
      this.emit?.({ type: 'error', message: 'microphone PCM16 frame has an odd byte length' })
      return
    }
    const incoming = pcm16ToFloat(audio)
    const combined = new Float32Array(this.buffered.length + incoming.length)
    combined.set(this.buffered)
    combined.set(incoming, this.buffered.length)
    let offset = 0
    while (combined.length - offset >= VAD_WINDOW_SIZE) {
      this.processVadWindow(combined.slice(offset, offset + VAD_WINDOW_SIZE))
      offset += VAD_WINDOW_SIZE
    }
    this.buffered = combined.slice(offset)
  }

  commitAudio(): void {
    if (this.closed || this.vad === undefined) return
    if (this.buffered.length > 0) {
      const padded = new Float32Array(VAD_WINDOW_SIZE)
      padded.set(this.buffered)
      this.buffered = new Float32Array()
      this.processVadWindow(padded)
    }
    this.vad.flush()
    this.consumeSegments()
  }

  synthesize(responseId: string, text: string): void {
    const generation = ++this.synthesisGeneration
    this.synthesisQueue = this.synthesisQueue.catch(() => {}).then(async () => {
      if (generation !== this.synthesisGeneration || this.closed) return
      const tts = this.tts
      if (tts === undefined) return
      this.emit?.({ type: 'tts.started', responseId })
      try {
        const pcm = await tts.synthesize(text, () => generation !== this.synthesisGeneration || this.closed)
        if (generation !== this.synthesisGeneration || this.closed) return
        for (let offset = 0; offset < pcm.length; offset += TTS_CHUNK_SAMPLES) {
          if (generation !== this.synthesisGeneration || this.closed) return
          const chunk = pcm.subarray(offset, Math.min(offset + TTS_CHUNK_SAMPLES, pcm.length))
          this.emit?.({ type: 'tts.delta', responseId, audio: pcmBytes(chunk) })
        }
        this.emit?.({ type: 'tts.done', responseId })
      } catch (error: unknown) {
        if (generation === this.synthesisGeneration && !this.closed) {
          this.emit?.({ type: 'error', message: 'local MOSS TTS failed: ' + errorMessage(error) })
        }
      }
    })
  }

  interrupt(): void { this.synthesisGeneration += 1 }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.synthesisGeneration += 1
    this.vad?.clear()
    await Promise.allSettled([this.recognitionQueue, this.synthesisQueue])
    await this.tts?.close()
    this.emit?.({ type: 'closed', reason: 'local ONNX backend closed' })
    this.emit = undefined
  }

  private async loadModels(layout: LocalModelLayout): Promise<void> {
    const threads = Math.max(1, this.config.threads)
    // MOSS imports onnxruntime-node statically. Load sherpa afterwards because
    // both native packages carry an ONNX Runtime DLL on Windows.
    const nativeModule = ['sherpa', 'onnx', 'node'].join('-')
    const sherpa = createRequire(import.meta.url)(nativeModule) as typeof import('sherpa-onnx-node').default
    this.vad = new sherpa.Vad({
      sileroVad: { model: layout.vad, threshold: 0.5, minSpeechDuration: 0.25, minSilenceDuration: 0.6, windowSize: VAD_WINDOW_SIZE },
      sampleRate: INPUT_SAMPLE_RATE, debug: false, numThreads: Math.min(threads, 2),
    }, 120)
    this.recognizer = new sherpa.OnlineRecognizer({
      featConfig: { sampleRate: INPUT_SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        paraformer: { encoder: layout.asrEncoder, decoder: layout.asrDecoder },
        tokens: layout.asrTokens, numThreads: threads, provider: 'cpu', debug: 0,
      },
    })
    this.tts = await MossTts.create({ ttsDir: layout.mossTts, codecDir: layout.mossCodec,
      voice: this.config.voice, threads, ...(this.config.maxTtsFrames === undefined ? {} : { maxFrames: this.config.maxTtsFrames }) })
  }

  private processVadWindow(window: Float32Array): void {
    const vad = this.vad
    if (vad === undefined) return
    vad.acceptWaveform(window)
    if (vad.isDetected() && this.activeUtteranceId === undefined) {
      // Barge-in is a speech event, not a task cancellation. Stop only the
      // current local synthesis; the Harness task continues untouched.
      this.synthesisGeneration += 1
      this.activeUtteranceId = randomUUID()
      this.emit?.({ type: 'transcription.started', utteranceId: this.activeUtteranceId })
    }
    this.consumeSegments()
  }

  private consumeSegments(): void {
    const vad = this.vad
    if (vad === undefined) return
    while (!vad.isEmpty()) {
      const segment = vad.front(false)
      vad.pop()
      const utteranceId = this.activeUtteranceId ?? randomUUID()
      if (this.activeUtteranceId === undefined) this.emit?.({ type: 'transcription.started', utteranceId })
      this.activeUtteranceId = undefined
      const samples = Float32Array.from(segment.samples)
      this.recognitionQueue = this.recognitionQueue.catch(() => {}).then(() => this.transcribe(utteranceId, samples))
    }
  }

  private async transcribe(utteranceId: string, samples: Float32Array): Promise<void> {
    const recognizer = this.recognizer
    if (recognizer === undefined || this.closed) return
    try {
      const stream = recognizer.createStream()
      let previous = ''
      for (let offset = 0; offset < samples.length; offset += ASR_CHUNK_SAMPLES) {
        stream.acceptWaveform({ samples: samples.subarray(offset, Math.min(offset + ASR_CHUNK_SAMPLES, samples.length)), sampleRate: INPUT_SAMPLE_RATE })
        while (recognizer.isReady(stream)) recognizer.decode(stream)
        const text = recognizer.getResult(stream).text.trim()
        if (text !== '' && text !== previous) {
          previous = text
          this.emit?.({ type: 'transcription.updated', utteranceId, text })
        }
        await Promise.resolve()
      }
      stream.acceptWaveform({ samples: new Float32Array(Math.round(INPUT_SAMPLE_RATE * 0.4)), sampleRate: INPUT_SAMPLE_RATE })
      stream.inputFinished()
      while (recognizer.isReady(stream)) recognizer.decode(stream)
      const finalText = recognizer.getResult(stream).text.trim() || previous
      this.emit?.({ type: 'transcription.completed', utteranceId, text: finalText })
    } catch (error: unknown) {
      this.emit?.({ type: 'transcription.failed', utteranceId, message: errorMessage(error) })
    }
  }
}

function pcm16ToFloat(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return Float32Array.from({ length: bytes.byteLength / 2 }, (_, index) => view.getInt16(index * 2, true) / 32768)
}

function pcmBytes(pcm: Int16Array): Uint8Array {
  const bytes = new Uint8Array(pcm.byteLength)
  bytes.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength))
  return bytes
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds) })])
  } finally { if (timer !== undefined) clearTimeout(timer) }
}
