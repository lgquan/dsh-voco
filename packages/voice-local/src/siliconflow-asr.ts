const WAV_HEADER_BYTES = 44

export interface SiliconFlowAsrConfig {
  readonly apiKey: string
  readonly endpoint: string
  readonly model: string
  readonly timeoutMs: number
  readonly fetch?: typeof fetch
}

/** Upload one completed PCM utterance to SiliconFlow and return its final transcript. */
export class SiliconFlowAsr {
  constructor(private readonly config: SiliconFlowAsrConfig) {}

  async transcribe(pcm: Uint8Array, sampleRate: number): Promise<string> {
    if (pcm.byteLength === 0) return ''
    const wav = pcm16MonoWav(pcm, sampleRate)
    const form = new FormData()
    form.append('file', new Blob([wav.buffer as ArrayBuffer], { type: 'audio/wav' }), 'utterance.wav')
    form.append('model', this.config.model)
    const response = await (this.config.fetch ?? fetch)(this.config.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(this.config.timeoutMs),
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`SiliconFlow ASR returned ${response.status}: ${body.slice(0, 500)}`)
    let parsed: unknown
    try { parsed = JSON.parse(body) as unknown } catch {
      throw new Error('SiliconFlow ASR returned invalid JSON')
    }
    if (!isRecord(parsed) || typeof parsed.text !== 'string') {
      throw new Error('SiliconFlow ASR response has no text field')
    }
    return parsed.text.trim()
  }
}

/** Wrap signed 16-bit little-endian mono PCM in a standard WAV container. */
export function pcm16MonoWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  if (pcm.byteLength % 2 !== 0) throw new Error('PCM16 input has an odd byte length')
  const wav = new Uint8Array(WAV_HEADER_BYTES + pcm.byteLength)
  const view = new DataView(wav.buffer)
  writeAscii(wav, 0, 'RIFF')
  view.setUint32(4, 36 + pcm.byteLength, true)
  writeAscii(wav, 8, 'WAVE')
  writeAscii(wav, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(wav, 36, 'data')
  view.setUint32(40, pcm.byteLength, true)
  wav.set(pcm, WAV_HEADER_BYTES)
  return wav
}

function writeAscii(target: Uint8Array, offset: number, value: string): void {
  for (const [index, character] of [...value].entries()) target[offset + index] = character.charCodeAt(0)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
