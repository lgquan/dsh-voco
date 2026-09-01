import { cp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const source = resolve(root, 'packages/voice-app/lib/types')
const target = resolve(root, 'lib/types')

await rm(target, { recursive: true, force: true })
await cp(source, target, { recursive: true })
