import { describe, expect, it } from 'vitest'
import { assertModelsInstalled, createModelLayout } from '../src/model-layout.ts'
import { normalizeSpeechText } from '../src/moss-tts.ts'

describe('local ONNX model seam', () => {
  it('maps one model root to all platform-neutral asset paths', () => {
    const layout = createModelLayout('D:/dsh-live/speech/models')
    expect(layout.vad.replaceAll('\\', '/')).toBe('D:/dsh-live/speech/models/vad/silero_vad.onnx')
    expect(layout.asrEncoder.replaceAll('\\', '/')).toContain('/asr/paraformer/encoder.int8.onnx')
    expect(layout.mossTts.replaceAll('\\', '/')).toContain('/tts/MOSS-TTS-Nano-100M-ONNX')
  })

  it('reports setup instructions when assets are absent', async () => {
    await expect(assertModelsInstalled(createModelLayout('D:/missing-dsh-live-models')))
      .rejects.toThrow('pnpm run setup:voice-local')
  })

  it('keeps conversational text while removing markup noise', () => {
    expect(normalizeSpeechText('  **完成了**\n\n请查看 `README.md`。  ')).toBe('完成了 请查看 README.md。')
  })
})
