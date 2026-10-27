import { rm } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outputs = [
  'lib',
  'packages/llm-tool-call-compat/lib',
  'packages/ui-voice/lib',
  'packages/voice/lib',
  'packages/voice-app/lib',
  'packages/voice-assistant/lib',
  'packages/voice-local/lib',
  'packages/voice-web/lib',
]

for (const output of outputs) {
  const target = resolve(root, output)
  if (!target.startsWith(root + sep)) throw new Error(`refusing to clean outside repository: ${target}`)
  await rm(target, { recursive: true, force: true })
}
