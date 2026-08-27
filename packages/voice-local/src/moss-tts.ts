/**
 * TypeScript port of the minimal MOSS-TTS-Nano ONNX inference path.
 * Derived from OpenMOSS/MOSS-TTS-Nano's MossOnnxDemoEngine.kt, changed for
 * Node.js streaming delivery. Copyright 2026 OpenMOSS Team, Apache-2.0.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { SentencePieceProcessor } from '@sctg/sentencepiece-js'
import * as ort from 'onnxruntime-node'

interface ModelManifest {
  readonly model_files: { readonly tts_meta: string; readonly codec_meta: string; readonly tokenizer_model: string }
  readonly tts_config: {
    readonly n_vq: number
    readonly audio_pad_token_id: number
    readonly audio_start_token_id: number
    readonly audio_end_token_id: number
    readonly audio_user_slot_token_id: number
    readonly audio_assistant_slot_token_id: number
    readonly audio_codebook_sizes: readonly number[]
  }
  readonly prompt_templates: {
    readonly user_prompt_prefix_token_ids: readonly number[]
    readonly user_prompt_after_reference_token_ids: readonly number[]
    readonly assistant_prompt_prefix_token_ids: readonly number[]
  }
  readonly generation_defaults: { readonly max_new_frames: number }
  readonly builtin_voices: readonly { readonly voice: string; readonly prompt_audio_codes: readonly (readonly number[])[] }[]
}

interface TtsMeta {
  readonly files: { readonly prefill: string; readonly decode_step: string; readonly local_fixed_sampled_frame: string }
  readonly onnx: { readonly decode_input_names: readonly string[]; readonly decode_output_names: readonly string[] }
}

interface CodecMeta {
  readonly files: { readonly decode_full: string }
  readonly codec_config: { readonly sample_rate: number }
}

export interface MossTtsConfig {
  readonly ttsDir: string
  readonly codecDir: string
  readonly voice: string
  readonly threads: number
  readonly maxFrames?: number
}

export class MossTts {
  readonly sampleRate: number
  private constructor(
    private readonly config: MossTtsConfig,
    private readonly manifest: ModelManifest,
    private readonly ttsMeta: TtsMeta,
    private readonly tokenizer: SentencePieceProcessor,
    private readonly prefill: ort.InferenceSession,
    private readonly decode: ort.InferenceSession,
    private readonly sampleFrame: ort.InferenceSession,
    private readonly codec: ort.InferenceSession,
    codecMeta: CodecMeta,
  ) { this.sampleRate = codecMeta.codec_config.sample_rate }

  static async create(config: MossTtsConfig): Promise<MossTts> {
    const manifestPath = resolve(config.ttsDir, 'browser_poc_manifest.json')
    const manifest = await readJson<ModelManifest>(manifestPath)
    const ttsMeta = await readJson<TtsMeta>(resolve(config.ttsDir, manifest.model_files.tts_meta))
    const codecMeta = await readJson<CodecMeta>(resolve(config.codecDir, 'codec_browser_onnx_meta.json'))
    const tokenizer = new SentencePieceProcessor()
    await tokenizer.load(resolve(config.ttsDir, manifest.model_files.tokenizer_model))
    const options: ort.InferenceSession.SessionOptions = {
      executionProviders: ['cpu'], graphOptimizationLevel: 'all',
      intraOpNumThreads: Math.max(1, config.threads), interOpNumThreads: 1,
    }
    const [prefill, decode, sampleFrame, codec] = await Promise.all([
      ort.InferenceSession.create(resolve(config.ttsDir, ttsMeta.files.prefill), options),
      ort.InferenceSession.create(resolve(config.ttsDir, ttsMeta.files.decode_step), options),
      ort.InferenceSession.create(resolve(config.ttsDir, ttsMeta.files.local_fixed_sampled_frame), options),
      ort.InferenceSession.create(resolve(config.codecDir, codecMeta.files.decode_full), options),
    ])
    return new MossTts(config, manifest, ttsMeta, tokenizer, prefill, decode, sampleFrame, codec, codecMeta)
  }

  async synthesize(text: string, cancelled: () => boolean): Promise<Int16Array> {
    const chunks: Int16Array[] = []
    await this.synthesizeStreaming(text, cancelled, chunk => { chunks.push(chunk) })
    return concatPcm(chunks)
  }

  /** Generate speech and deliver decoded PCM batches as soon as they are ready. */
  async synthesizeStreaming(text: string, cancelled: () => boolean, onChunk: (pcm: Int16Array) => void): Promise<void> {
    const tokens = this.tokenizer.encodeIds(normalizeSpeechText(text))
    if (tokens.length === 0) return
    const rows = this.buildInputRows(tokens)
    const rowWidth = rows[0]?.length ?? 0
    const flat = Int32Array.from(rows.flat())
    let past = await this.prefill.run({
      input_ids: new ort.Tensor('int32', flat, [1, rows.length, rowWidth]),
      attention_mask: new ort.Tensor('int32', new Int32Array(rows.length).fill(1), [1, rows.length]),
    })
    let hidden = lastHidden(requiredTensor(past, 'global_hidden'))
    let pastLength = rows.length
    const seen = Array.from({ length: this.manifest.tts_config.n_vq }, () => new Set<number>())
    const random = xorshift32(42)
    const frameLimit = Math.min(this.config.maxFrames ?? this.manifest.generation_defaults.max_new_frames,
      this.manifest.generation_defaults.max_new_frames)
    const pendingFrames: Int32Array[] = []

    const flush = async (): Promise<void> => {
      if (pendingFrames.length === 0 || cancelled()) return
      const chunk = await this.decodeFrames(pendingFrames.splice(0))
      if (chunk.length > 0 && !cancelled()) onChunk(chunk)
    }

    for (let step = 0; step < frameLimit && !cancelled(); step += 1) {
      const frame = await this.nextFrame(hidden, seen, random)
      if (frame === undefined) break
      pendingFrames.push(frame)
      if (pendingFrames.length >= STREAM_FRAME_BATCH) await flush()
      const audioRow = new Int32Array(rowWidth).fill(this.manifest.tts_config.audio_pad_token_id)
      audioRow[0] = this.manifest.tts_config.audio_assistant_slot_token_id
      for (let index = 0; index < frame.length; index += 1) {
        audioRow[index + 1] = frame[index] ?? this.manifest.tts_config.audio_pad_token_id
        seen[index]?.add(frame[index] ?? 0)
      }
      const feeds: Record<string, ort.Tensor> = {
        input_ids: new ort.Tensor('int32', audioRow, [1, 1, rowWidth]),
        past_valid_lengths: new ort.Tensor('int32', Int32Array.of(pastLength), [1]),
      }
      const pastInputs = this.ttsMeta.onnx.decode_input_names.slice(2)
      const presentOutputs = this.ttsMeta.onnx.decode_output_names.slice(1)
      for (let index = 0; index < pastInputs.length; index += 1) {
        const inputName = pastInputs[index]
        const outputName = presentOutputs[index]
        if (inputName !== undefined && outputName !== undefined) feeds[inputName] = requiredTensor(past, outputName)
      }
      past = await this.decode.run(feeds)
      hidden = lastHidden(requiredTensor(past, 'global_hidden'))
      pastLength += 1
    }
    await flush()
  }

  async close(): Promise<void> {
    await Promise.all([this.prefill.release(), this.decode.release(), this.sampleFrame.release(), this.codec.release()])
  }

  private buildInputRows(textTokens: readonly number[]): number[][] {
    const cfg = this.manifest.tts_config
    const rowWidth = cfg.n_vq + 1
    const voice = this.manifest.builtin_voices.find(item => item.voice === this.config.voice && item.prompt_audio_codes.length > 0)
      ?? this.manifest.builtin_voices.find(item => item.prompt_audio_codes.length > 0)
    if (voice === undefined) throw new Error('MOSS manifest contains no built-in voice')
    const textRow = (token: number): number[] => [token, ...new Array<number>(cfg.n_vq).fill(cfg.audio_pad_token_id)]
    const prefix = [...this.manifest.prompt_templates.user_prompt_prefix_token_ids, cfg.audio_start_token_id].map(textRow)
    const audio = voice.prompt_audio_codes.map(codes => [cfg.audio_user_slot_token_id,
      ...Array.from({ length: cfg.n_vq }, (_, index) => codes[index] ?? cfg.audio_pad_token_id)])
    const suffixTokens = [cfg.audio_end_token_id, ...this.manifest.prompt_templates.user_prompt_after_reference_token_ids,
      ...textTokens, ...this.manifest.prompt_templates.assistant_prompt_prefix_token_ids, cfg.audio_start_token_id]
    const rows = [...prefix, ...audio, ...suffixTokens.map(textRow)]
    if (rows.some(row => row.length !== rowWidth)) throw new Error('MOSS prompt row width is invalid')
    return rows
  }

  private async nextFrame(hidden: ort.Tensor, seen: readonly Set<number>[], random: () => number): Promise<Int32Array | undefined> {
    const cfg = this.manifest.tts_config
    const codebookSize = cfg.audio_codebook_sizes[0] ?? 1024
    const mask = new Int32Array(cfg.n_vq * codebookSize)
    for (let channel = 0; channel < seen.length; channel += 1) {
      for (const token of seen[channel] ?? []) if (token >= 0 && token < codebookSize) mask[channel * codebookSize + token] = 1
    }
    const result = await this.sampleFrame.run({
      global_hidden: hidden,
      repetition_seen_mask: new ort.Tensor('int32', mask, [1, cfg.n_vq, codebookSize]),
      assistant_random_u: new ort.Tensor('float32', Float32Array.of(random()), [1]),
      audio_random_u: new ort.Tensor('float32', Float32Array.from({ length: cfg.n_vq }, random), [1, cfg.n_vq]),
    })
    const shouldContinue = requiredTensor(result, 'should_continue').data[0]
    if (Number(shouldContinue) <= 0) return undefined
    return Int32Array.from(requiredTensor(result, 'frame_token_ids').data as Int32Array)
  }

  private async decodeFrames(frames: readonly Int32Array[]): Promise<Int16Array> {
    const nVq = this.manifest.tts_config.n_vq
    const codes = new Int32Array(frames.length * nVq)
    frames.forEach((frame, frameIndex) => codes.set(frame, frameIndex * nVq))
    const result = await this.codec.run({
      audio_codes: new ort.Tensor('int32', codes, [1, frames.length, nVq]),
      audio_code_lengths: new ort.Tensor('int32', Int32Array.of(frames.length), [1]),
    })
    const audio = requiredTensor(result, 'audio')
    const length = Math.min(Number(requiredTensor(result, 'audio_lengths').data[0]), audio.dims.at(-1) ?? 0)
    const channels = audio.dims.length >= 3 ? audio.dims[1] ?? 1 : 1
    const samples = audio.data as Float32Array
    const pcm = new Int16Array(length)
    for (let index = 0; index < length; index += 1) {
      let mixed = 0
      for (let channel = 0; channel < channels; channel += 1) mixed += samples[channel * length + index] ?? 0
      pcm[index] = Math.round(Math.max(-1, Math.min(1, mixed / channels)) * 32767)
    }
    return pcm
  }
}

const STREAM_FRAME_BATCH = 12

function concatPcm(chunks: readonly Int16Array[]): Int16Array {
  const result = new Int16Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

export function normalizeSpeechText(text: string): string {
  return text.normalize('NFKC').replace(/[`*_#>|]/g, ' ').replace(/\s+/g, ' ')
    .replace(/\s+([，。！？；：,.!?;:])/g, '$1').trim()
}

function requiredTensor(result: ort.InferenceSession.OnnxValueMapType, name: string): ort.Tensor {
  const tensor = result[name]
  if (!(tensor instanceof ort.Tensor)) throw new Error('MOSS ONNX output is missing: ' + name)
  return tensor
}

function lastHidden(tensor: ort.Tensor): ort.Tensor {
  const hiddenSize = tensor.dims.at(-1) ?? 0
  const values = tensor.data as Float32Array
  return new ort.Tensor('float32', values.slice(values.length - hiddenSize), [1, hiddenSize])
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T
}

function xorshift32(seed: number): () => number {
  let state = seed | 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return Math.max(1e-6, Math.min(1 - 1e-6, (state >>> 0) / 0x1_0000_0000))
  }
}
