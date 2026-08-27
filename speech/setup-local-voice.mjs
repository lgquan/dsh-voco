import { createWriteStream } from 'node:fs'
import { access, mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import process from 'node:process'

const ROOT = resolve(import.meta.dirname, 'models')
const HF = 'https://huggingface.co'

const FILES = [
  ['vad/silero_vad.onnx', 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx'],
  ['asr/paraformer/encoder.int8.onnx', `${HF}/csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en/resolve/main/encoder.int8.onnx`],
  ['asr/paraformer/decoder.int8.onnx', `${HF}/csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en/resolve/main/decoder.int8.onnx`],
  ['asr/paraformer/tokens.txt', `${HF}/csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en/resolve/main/tokens.txt`],
  ...mossFiles('OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX', 'tts/MOSS-TTS-Nano-100M-ONNX', [
    'browser_poc_manifest.json', 'tts_browser_onnx_meta.json', 'tokenizer.model',
    'moss_tts_prefill.onnx', 'moss_tts_decode_step.onnx', 'moss_tts_local_fixed_sampled_frame.onnx',
    'moss_tts_global_shared.data', 'moss_tts_local_shared.data',
  ]),
  ...mossFiles('OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX', 'tts/MOSS-Audio-Tokenizer-Nano-ONNX', [
    'codec_browser_onnx_meta.json', 'moss_audio_tokenizer_decode_full.onnx', 'moss_audio_tokenizer_decode_shared.data',
  ]),
]

console.log(`Preparing local ONNX voice models under ${ROOT}`)
await mkdir(ROOT, { recursive: true })
for (let index = 0; index < FILES.length; index += 1) {
  const [relative, url] = FILES[index]
  const destination = resolve(ROOT, relative)
  if (await nonEmpty(destination)) {
    console.log(`[${index + 1}/${FILES.length}] cached ${relative}`)
    continue
  }
  console.log(`[${index + 1}/${FILES.length}] downloading ${relative}`)
  await download(url, destination)
}
console.log('Local voice models are ready. Python, pip, Torch, and virtual environments are not required.')

function mossFiles(repository, directory, names) {
  return names.map(name => [`${directory}/${name}`, `${HF}/${repository}/resolve/main/${name}`])
}

async function nonEmpty(file) {
  try { return (await stat(file)).size > 0 }
  catch { return false }
}

async function download(url, destination) {
  await mkdir(dirname(destination), { recursive: true })
  const partial = destination + '.part'
  await rm(partial, { force: true })
  let lastError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'dsh-voco-model-installer/1.0' } })
      if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status} ${response.statusText}`)
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial))
      if (!(await nonEmpty(partial))) throw new Error('downloaded file is empty')
      await rename(partial, destination)
      return
    } catch (error) {
      lastError = error
      await rm(partial, { force: true })
      if (attempt < 3) console.warn(`  retry ${attempt}/3: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`Failed to download ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

await access(ROOT)
