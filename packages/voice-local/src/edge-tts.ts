import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EdgeTTS } from 'node-edge-tts'

export const EDGE_TTS_VOICE = 'zh-CN-XiaoxiaoNeural'

/** Edge TTS adapter. Returns the service's MP3 bytes for browser decoding. */
export async function synthesizeEdgeSpeech(text: string, rate = '+0%'): Promise<Uint8Array> {
  const normalized = normalizeSpeechText(text)
  if (normalized === '') return new Uint8Array()
  const directory = await mkdtemp(join(tmpdir(), 'dsh-voco-edge-'))
  const output = join(directory, 'speech.mp3')
  try {
    const client = new EdgeTTS({
      voice: EDGE_TTS_VOICE,
      lang: 'zh-CN',
      outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
      rate,
      pitch: 'default',
      volume: 'default',
      timeout: 20_000,
    })
    await client.ttsPromise(normalized, output)
    return new Uint8Array(await readFile(output))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export function normalizeSpeechText(text: string): string {
  return text.normalize('NFKC').replace(/[`*_#>|]/g, ' ').replace(/\s+/g, ' ')
    .replace(/\s+([，。！？；：,.!?;:])/g, '$1').trim()
}

/** Split prose into short requests so the first sentence can play immediately. */
export function splitSpeechText(text: string): string[] {
  const normalized = normalizeSpeechText(text)
  if (normalized === '') return []
  const parts = normalized.match(/[^。！？!?；;：:\n]+[。！？!?；;：:]?|[^。！？!?；;：:\n]+$/g) ?? [normalized]
  return parts.map(part => part.trim()).filter(Boolean)
}
