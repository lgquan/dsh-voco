import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve } from 'node:path'

export interface LocalModelLayout {
  readonly root: string
  readonly vad: string
  readonly asrEncoder: string
  readonly asrDecoder: string
  readonly asrTokens: string
}

export function createModelLayout(modelRoot: string): LocalModelLayout {
  const root = resolve(modelRoot)
  return {
    root,
    vad: resolve(root, 'vad/silero_vad.onnx'),
    asrEncoder: resolve(root, 'asr/paraformer/encoder.int8.onnx'),
    asrDecoder: resolve(root, 'asr/paraformer/decoder.int8.onnx'),
    asrTokens: resolve(root, 'asr/paraformer/tokens.txt'),
  }
}

export async function assertModelsInstalled(layout: LocalModelLayout): Promise<void> {
  const required = [layout.vad, layout.asrEncoder, layout.asrDecoder, layout.asrTokens]
  const missing: string[] = []
  await Promise.all(required.map(async (file) => {
    try { await access(file, constants.R_OK) }
    catch { missing.push(file) }
  }))
  if (missing.length > 0) {
    throw new Error('Local voice models are not installed. Run "pnpm run setup:voice-local" first. Missing: ' + missing.join(', '))
  }
}
