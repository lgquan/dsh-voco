import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(import.meta.dirname, '../packages/voice-app')

describe('dsh-voco distribution interface', () => {
  it('exposes one public package with no internal runtime package dependencies', async () => {
    const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8')) as {
      name?: string
      dependencies?: Record<string, string>
      exports?: Record<string, unknown>
      dsh?: { bundle?: unknown; client?: unknown }
    }

    expect(manifest.name).toBe('@lgquan/dsh-voco')
    expect(Object.keys(manifest.dependencies ?? {}).filter(name => name.startsWith('@lgquan/'))).toEqual([])
    expect(manifest.dsh?.bundle).toBeDefined()
    expect(manifest.dsh?.client).toBeDefined()
    expect(Object.keys(manifest.exports ?? {})).toEqual(expect.arrayContaining([
      '.',
      './llm-tool-call-compat',
      './voice',
      './voice-local',
      './voice-assistant',
      './voice-web',
    ]))
  })

  it('loads every runtime entry through the public package seam', async () => {
    const patch = await readFile(resolve(packageRoot, 'cordis.patch.yml'), 'utf8')
    const packageNames = [...patch.matchAll(/^\s+name: '([^']+)'$/gm)].map(match => match[1])

    expect(packageNames).toEqual([
      '@lgquan/dsh-voco/llm-tool-call-compat',
      '@lgquan/dsh-voco/voice',
      '@lgquan/dsh-voco/voice-local',
      '@lgquan/dsh-voco/voice-assistant',
      '@lgquan/dsh-voco/voice-web',
      '@lgquan/dsh-voco',
    ])
  })
})
