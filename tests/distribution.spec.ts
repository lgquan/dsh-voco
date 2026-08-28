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

    expect(manifest.name).toBe('@flowingspring/dsh-voco')
    expect(Object.keys(manifest.dependencies ?? {}).filter(name => name.startsWith('@lgquan/'))).toEqual([])
    expect(manifest.dsh?.bundle).toBeDefined()
    expect(manifest.dsh?.client).toBeDefined()
    expect(Object.keys(manifest.exports ?? {})).toEqual(expect.arrayContaining([
      '.',
      './client',
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
      '@flowingspring/dsh-voco/llm-tool-call-compat',
      '@flowingspring/dsh-voco/voice',
      '@flowingspring/dsh-voco/voice-local',
      '@flowingspring/dsh-voco/voice-assistant',
      '@flowingspring/dsh-voco/voice-web',
      '@flowingspring/dsh-voco',
    ])
  })
})
