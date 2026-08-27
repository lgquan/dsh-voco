import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve } from 'node:path'

export interface LocalModelLayout {
  readonly root: string
  readonly vad: string
  readonly asrEncoder: string
  readonly asrDecoder: string
  readonly asrTokens: string
  readonly mossTts: string
  readonly mossCodec: string
}

const REQUIRED_MOSS_FILES = [
  'MOSS-TTS-Nano-100M-ONNX/browser_poc_manifest.json',
  'MOSS-TTS-Nano-100M-ONNX/tts_browser_onnx_meta.json',
  'MOSS-TTS-Nano-100M-ONNX/tokenizer.model',
  'MOSS-TTS-Nano-100M-ONNX/moss_tts_prefill.onnx',
  'MOSS-TTS-Nano-100M-ONNX/moss_tts_decode_step.onnx',
  'MOSS-TTS-Nano-100M-ONNX/moss_tts_local_fixed_sampled_frame.onnx',
  'MOSS-TTS-Nano-100M-ONNX/moss_tts_global_shared.data',
  'MOSS-TTS-Nano-100M-ONNX/moss_tts_local_shared.data',
  'MOSS-Audio-Tokenizer-Nano-ONNX/codec_browser_onnx_meta.json',
  'MOSS-Audio-Tokenizer-Nano-ONNX/moss_audio_tokenizer_decode_full.onnx',
  'MOSS-Audio-Tokenizer-Nano-ONNX/moss_audio_tokenizer_decode_shared.data',
] as const

export function createModelLayout(modelRoot: string): LocalModelLayout {
  const root = resolve(modelRoot)
  return {
    root,
    vad: resolve(root, 'vad/silero_vad.onnx'),
    asrEncoder: resolve(root, 'asr/paraformer/encoder.int8.onnx'),
    asrDecoder: resolve(root, 'asr/paraformer/decoder.int8.onnx'),
    asrTokens: resolve(root, 'asr/paraformer/tokens.txt'),
    mossTts: resolve(root, 'tts/MOSS-TTS-Nano-100M-ONNX'),
    mossCodec: resolve(root, 'tts/MOSS-Audio-Tokenizer-Nano-ONNX'),
  }
}

export async function assertModelsInstalled(layout: LocalModelLayout): Promise<void> {
  const required = [layout.vad, layout.asrEncoder, layout.asrDecoder, layout.asrTokens,
    ...REQUIRED_MOSS_FILES.map(file => resolve(layout.root, 'tts', file))]
  const missing: string[] = []
  await Promise.all(required.map(async (file) => {
    try { await access(file, constants.R_OK) }
    catch { missing.push(file) }
  }))
  if (missing.length > 0) {
    throw new Error('Local voice models are not installed. Run "pnpm run setup:voice-local" first. Missing: ' + missing.join(', '))
  }
}
