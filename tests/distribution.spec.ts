import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repositoryRoot = resolve(import.meta.dirname, '..')
const packageRoot = resolve(repositoryRoot, 'packages/voice-app')
const packagesRoot = resolve(packageRoot, '..')

describe('dsh-voco distribution interface', () => {
  it('keeps every internal workspace package private', async () => {
    const directories = await readdir(packagesRoot, { withFileTypes: true })
    const manifests = await Promise.all(directories
      .filter(entry => entry.isDirectory())
      .map(async (entry) => ({
        directory: entry.name,
        manifest: JSON.parse(await readFile(resolve(packagesRoot, entry.name, 'package.json'), 'utf8')) as {
          name?: string
          private?: boolean
        },
      })))

    expect(manifests.filter(({ manifest }) => manifest.private !== true)).toEqual([{
      directory: 'voice-app',
      manifest: expect.objectContaining({ name: '@flowingspring/dsh-voco' }),
    }])
  })

  it('exposes one public package with no internal runtime package dependencies', async () => {
    const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8')) as {
      name?: string
      dependencies?: Record<string, string>
      exports?: Record<string, unknown>
      dsh?: { bundle?: unknown; client?: unknown }
    }

    expect(manifest.name).toBe('@flowingspring/dsh-voco')
    expect(Object.keys(manifest.dependencies ?? {}).filter(name => name.startsWith('@flowingspring/'))).toEqual([])
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

  it('keeps the repository-root installation entry aligned with the public package', async () => {
    const [repositoryManifest, packageManifest, repositoryPatch, packagePatch] = await Promise.all([
      readFile(resolve(repositoryRoot, 'package.json'), 'utf8').then(text => JSON.parse(text) as {
        name?: string
        private?: boolean
        version?: string
        dependencies?: Record<string, string>
        dsh?: { bundle?: { patch?: string } }
      }),
      readFile(resolve(packageRoot, 'package.json'), 'utf8').then(text => JSON.parse(text) as {
        version?: string
      }),
      readFile(resolve(repositoryRoot, 'cordis.patch.yml'), 'utf8'),
      readFile(resolve(packageRoot, 'cordis.patch.yml'), 'utf8'),
    ])

    expect(repositoryManifest).toEqual(expect.objectContaining({
      name: 'dsh-voco',
      private: true,
      version: packageManifest.version,
      dependencies: {
        '@flowingspring/dsh-voco': packageManifest.version,
      },
      dsh: {
        bundle: {
          patch: './cordis.patch.yml',
        },
      },
    }))
    expect(repositoryPatch.replaceAll('\r\n', '\n')).toBe(packagePatch.replaceAll('\r\n', '\n'))
  })

  it('keeps public README release links aligned with the package version', async () => {
    const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8')) as {
      version: string
    }
    const readmes = await Promise.all([
      resolve(repositoryRoot, 'README.md'),
      resolve(repositoryRoot, 'README.en.md'),
      resolve(packageRoot, 'README.md'),
      resolve(packageRoot, 'README.zh.md'),
    ].map(path => readFile(path, 'utf8')))
    const tarballUrl = `/releases/download/v${manifest.version}/flowingspring-dsh-voco-${manifest.version}.tgz`
    const releaseUrl = `/releases/tag/v${manifest.version}`

    for (const readme of readmes) {
      expect(readme).toContain(tarballUrl)
      expect(readme).toContain(releaseUrl)
    }
  })
})
