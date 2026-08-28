import { randomUUID } from 'node:crypto'
import type { VoiceAudioProfile } from '@flowingspring/dsh-voice'
import { splitSpeechText, synthesizeEdgeSpeech } from './edge-tts.ts'
import { SiliconFlowAsr } from './siliconflow-asr.ts'
import type { SpeechBackend, SpeechBackendEvent } from './speech-backend.ts'

const INPUT_SAMPLE_RATE = 16_000

export interface NodeSpeechConfig {
  readonly apiKey: string
  readonly endpoint: string
  readonly model: string
  readonly requestTimeoutMs: number
  readonly inputSampleRate: number
  readonly outputSampleRate: number
  readonly ttsRate: string
  readonly silenceDurationMs: number
  readonly speechThreshold: number
  /** Minimum accumulated voiced audio before a candidate becomes an utterance. */
  readonly minSpeechDurationMs?: number
  readonly preRollMs: number
  readonly trailingSilenceMs: number
  readonly maxUtteranceMs: number
  readonly fetch?: typeof fetch
}

interface ActiveUtterance {
  readonly id: string
  readonly frames: Uint8Array[]
  confirmed: boolean
  totalBytes: number
  voicedBytes: number
  silenceBytes: number
}

/** Lightweight PCM silence detector plus SiliconFlow cloud ASR and Edge TTS. */
export class NodeSpeechBackend implements SpeechBackend {
  readonly audio: VoiceAudioProfile
  private readonly asr: SiliconFlowAsr
  private emit: ((event: SpeechBackendEvent) => void) | undefined
  private readonly preRoll: Uint8Array[] = []
  private preRollBytes = 0
  private active: ActiveUtterance | undefined
  private recognitionQueue: Promise<void> = Promise.resolve()
  private synthesisQueue: Promise<void> = Promise.resolve()
  private synthesisGeneration = 0
  private readonly synthesisResponses = new Map<string, { finished: boolean; started: boolean }>()
  private closed = false

  constructor(private readonly config: NodeSpeechConfig) {
    if (config.inputSampleRate !== INPUT_SAMPLE_RATE) throw new Error('SiliconFlow speech input requires 16000 Hz microphone audio')
    if (config.apiKey.trim() === '') throw new Error('SILICONFLOW_API_KEY is required for cloud speech recognition')
    if (config.speechThreshold <= 0 || config.speechThreshold >= 1) throw new Error('speechThreshold must be between 0 and 1')
    if ((config.minSpeechDurationMs ?? 250) <= 0) throw new Error('minSpeechDurationMs must be greater than 0')
    if (!/^[+-]\d{1,3}%$/.test(config.ttsRate)) throw new Error('ttsRate must use an Edge TTS relative percentage such as +20%')
    this.audio = { inputSampleRate: config.inputSampleRate, outputSampleRate: config.outputSampleRate, format: 'audio_mpeg' }
    this.asr = new SiliconFlowAsr({
      apiKey: config.apiKey,
      endpoint: config.endpoint,
      model: config.model,
      timeoutMs: config.requestTimeoutMs,
      ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    })
  }

  start(emit: (event: SpeechBackendEvent) => void): Promise<void> {
    if (this.emit !== undefined) return Promise.reject(new Error('speech backend is already started'))
    this.emit = emit
    emit({ type: 'ready' })
    return Promise.resolve()
  }

  appendAudio(audio: Uint8Array): void {
    if (this.closed || audio.byteLength === 0) return
    if (audio.byteLength % 2 !== 0) {
      this.emit?.({ type: 'error', message: 'microphone PCM16 frame has an odd byte length' })
      return
    }
    const frame = audio.slice()
    const voiced = pcm16Rms(frame) >= this.config.speechThreshold
    if (this.active === undefined) {
      this.rememberPreRoll(frame)
      if (!voiced) return
      this.beginUtterance()
      return
    }
    this.active.frames.push(frame)
    this.active.totalBytes += frame.byteLength
    if (voiced) {
      this.active.voicedBytes += frame.byteLength
      this.active.silenceBytes = 0
      if (!this.active.confirmed && this.active.voicedBytes >= this.bytesFor(this.config.minSpeechDurationMs ?? 250)) {
        this.confirmUtterance()
      }
    } else {
      this.active.silenceBytes += frame.byteLength
    }
    if (!this.active.confirmed && this.active.silenceBytes >= this.bytesFor(this.config.minSpeechDurationMs ?? 250)) {
      this.active = undefined
      return
    }
    if (this.active.silenceBytes >= this.bytesFor(this.config.silenceDurationMs)
      || this.active.totalBytes >= this.bytesFor(this.config.maxUtteranceMs)) this.finishUtterance()
  }

  commitAudio(): void { this.finishUtterance() }

  synthesize(responseId: string, text: string): void {
    const generation = this.synthesisGeneration
    const response = this.synthesisResponses.get(responseId) ?? { finished: false, started: false }
    this.synthesisResponses.set(responseId, response)
    this.synthesisQueue = this.synthesisQueue.catch(() => {}).then(async () => {
      if (generation !== this.synthesisGeneration || this.closed) return
      if (!response.started) {
        response.started = true
        this.emit?.({ type: 'tts.started', responseId })
      }
      try {
        for (const sentence of splitSpeechText(text)) {
          if (generation !== this.synthesisGeneration || this.closed) return
          const audio = await synthesizeEdgeSpeech(sentence, this.config.ttsRate)
          if (generation !== this.synthesisGeneration || this.closed) return
          this.emit?.({ type: 'tts.delta', responseId, audio })
        }
        if (generation !== this.synthesisGeneration || this.closed) return
        if (response.finished) {
          this.synthesisResponses.delete(responseId)
          this.emit?.({ type: 'tts.done', responseId })
        }
      } catch (error: unknown) {
        if (generation === this.synthesisGeneration && !this.closed) {
          this.emit?.({ type: 'error', message: 'Edge TTS failed: ' + errorMessage(error) })
        }
      }
    })
  }

  finishSynthesis(responseId: string): void {
    const response = this.synthesisResponses.get(responseId)
    if (response !== undefined) response.finished = true
  }

  interrupt(): void {
    this.synthesisGeneration += 1
    this.synthesisResponses.clear()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.synthesisGeneration += 1
    this.synthesisResponses.clear()
    this.active = undefined
    this.preRoll.splice(0)
    await Promise.allSettled([this.recognitionQueue, this.synthesisQueue])
    this.emit?.({ type: 'closed', reason: 'SiliconFlow speech backend closed' })
    this.emit = undefined
  }

  private beginUtterance(): void {
    const frames = this.preRoll.splice(0)
    const totalBytes = this.preRollBytes
    this.preRollBytes = 0
    const last = frames.at(-1)
    this.active = {
      id: randomUUID(),
      frames,
      confirmed: false,
      totalBytes,
      voicedBytes: last?.byteLength ?? 0,
      silenceBytes: 0,
    }
    if (this.active.voicedBytes >= this.bytesFor(this.config.minSpeechDurationMs ?? 250)) this.confirmUtterance()
  }

  private confirmUtterance(): void {
    const utterance = this.active
    if (utterance === undefined || utterance.confirmed) return
    utterance.confirmed = true
    this.interrupt()
    this.emit?.({ type: 'transcription.started', utteranceId: utterance.id })
  }

  private finishUtterance(): void {
    const utterance = this.active
    if (utterance === undefined) return
    this.active = undefined
    const keepSilence = this.bytesFor(this.config.trailingSilenceMs)
    const trimBytes = Math.max(0, utterance.silenceBytes - keepSilence)
    const pcm = concatFrames(utterance.frames, Math.max(0, utterance.totalBytes - trimBytes))
    if (!utterance.confirmed || utterance.voicedBytes < this.bytesFor(this.config.minSpeechDurationMs ?? 250)
      || pcm.byteLength === 0) return
    this.recognitionQueue = this.recognitionQueue.catch(() => {}).then(async () => {
      if (this.closed) return
      try {
        const text = await this.asr.transcribe(pcm, this.config.inputSampleRate)
        if (this.closed) return
        if (text === '') {
          this.emit?.({ type: 'transcription.failed', utteranceId: utterance.id, message: '云端语音识别没有返回文字。' })
        } else {
          this.emit?.({ type: 'transcription.completed', utteranceId: utterance.id, text })
        }
      } catch (error: unknown) {
        if (!this.closed) this.emit?.({ type: 'transcription.failed', utteranceId: utterance.id, message: errorMessage(error) })
      }
    })
  }

  private rememberPreRoll(frame: Uint8Array): void {
    this.preRoll.push(frame)
    this.preRollBytes += frame.byteLength
    const limit = this.bytesFor(this.config.preRollMs)
    while (this.preRollBytes > limit && this.preRoll.length > 1) {
      const removed = this.preRoll.shift()
      if (removed !== undefined) this.preRollBytes -= removed.byteLength
    }
  }

  private bytesFor(milliseconds: number): number {
    return Math.round(this.config.inputSampleRate * 2 * milliseconds / 1000)
  }
}

function pcm16Rms(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let squares = 0
  const samples = bytes.byteLength / 2
  for (let offset = 0; offset < bytes.byteLength; offset += 2) {
    const value = view.getInt16(offset, true) / 32768
    squares += value * value
  }
  return samples === 0 ? 0 : Math.sqrt(squares / samples)
}

function concatFrames(frames: readonly Uint8Array[], length: number): Uint8Array {
  const output = new Uint8Array(length)
  let offset = 0
  for (const frame of frames) {
    if (offset >= length) break
    const part = frame.subarray(0, Math.min(frame.byteLength, length - offset))
    output.set(part, offset)
    offset += part.byteLength
  }
  return output
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
