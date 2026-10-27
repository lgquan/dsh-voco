import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repositoryRoot = resolve(import.meta.dirname, '..')
const sourcePackageRoot = resolve(repositoryRoot, 'packages/voice-app')
const packagesRoot = resolve(sourcePackageRoot, '..')
const supportedDshPeerRange = '^0.2.1-rc.2'
const supportedDshDevelopmentVersion = '0.2.1-rc.2'
const supportedEdgeTtsVersion = '1.2.12'
const removedDshPackages = new Set([
  '@deepseek-ai/dsh-agent-presets',
  '@deepseek-ai/dsh-client-runtime',
])

type PackageManifest = {
  name?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

async function readWorkspaceManifests(): Promise<PackageManifest[]> {
  const directories = await readdir(packagesRoot, { withFileTypes: true })
  const paths = [
    resolve(repositoryRoot, 'package.json'),
    ...directories
      .filter(entry => entry.isDirectory())
      .map(entry => resolve(packagesRoot, entry.name, 'package.json')),
  ]

  return Promise.all(paths.map(path => readFile(path, 'utf8').then(text => JSON.parse(text) as PackageManifest)))
}

describe('dsh-voco distribution interface', () => {
  it('targets the current DSH package graph in every workspace manifest', async () => {
    const manifests = await readWorkspaceManifests()

    for (const manifest of manifests) {
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
        for (const [name, range] of Object.entries(manifest[field] ?? {})) {
          if (!name.startsWith('@deepseek-ai/dsh-')) continue

          expect(removedDshPackages, `${manifest.name} must not depend on removed package ${name}`).not.toContain(name)
          const expected = field === 'peerDependencies'
            ? supportedDshPeerRange
            : supportedDshDevelopmentVersion
          expect(range, `${manifest.name} ${field}.${name}`).toBe(expected)
        }
      }
    }
  })

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

    expect(manifests.every(({ manifest }) => manifest.private === true)).toBe(true)
  })

  it('pins the Edge TTS client that implements the current upstream protocol', async () => {
    const manifests = await readWorkspaceManifests()
    const consumers = manifests.flatMap(manifest => {
      const version = manifest.dependencies?.['node-edge-tts']
      return version === undefined ? [] : [[manifest.name, version] as const]
    }).sort(([left], [right]) => String(left).localeCompare(String(right)))

    expect(consumers).toEqual([
      ['@flowingspring/dsh-voco', supportedEdgeTtsVersion],
      ['@flowingspring/dsh-voco-source', supportedEdgeTtsVersion],
      ['@flowingspring/dsh-voice-local', supportedEdgeTtsVersion],
    ])
  })

  it('exposes one public package with no internal runtime package dependencies', async () => {
    const manifest = JSON.parse(await readFile(resolve(repositoryRoot, 'package.json'), 'utf8')) as {
      name?: string
      private?: boolean
      dependencies?: Record<string, string>
      exports?: Record<string, unknown>
      dsh?: { bundle?: unknown; client?: unknown }
    }

    expect(manifest.name).toBe('@flowingspring/dsh-voco')
    expect(manifest.private).toBeUndefined()
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
    const patch = await readFile(resolve(repositoryRoot, 'cordis.patch.yml'), 'utf8')
    const packageNames = [...patch.matchAll(/^\s+name: '([^']+)'$/gm)].map(match => match[1])

    expect(packageNames).toEqual([
      '@flowingspring/dsh-voco/llm-tool-call-compat',
      '@flowingspring/dsh-voco/voice',
      '@flowingspring/dsh-voco/voice-local',
      '@flowingspring/dsh-voco/voice-assistant',
      '@flowingspring/dsh-voco/voice-web',
      '@flowingspring/dsh-voco',
    ])
    expect(patch).toContain('inject: [webServer, webStartup]')
    expect(patch).toContain('trustedHosts: !!js ctx.webStartup.trustedHosts')
    expect(patch).not.toContain('webRuntime')
  })

  it('declares the nested remote service used by the browser settings bridge', async () => {
    const client = await readFile(resolve(packagesRoot, 'ui-voice/src/client/index.ts'), 'utf8')

    expect(client).toMatch(/export const inject = \[[\s\S]*'remote\.credentials'/)
  })

  it('keeps the repository-root installation entry aligned with the public package', async () => {
    const [repositoryManifest, sourcePackageManifest, repositoryPatch, packagePatch] = await Promise.all([
      readFile(resolve(repositoryRoot, 'package.json'), 'utf8').then(text => JSON.parse(text) as {
        name?: string
        private?: boolean
        version?: string
        dependencies?: Record<string, string>
        dsh?: { bundle?: { patch?: string } }
      }),
      readFile(resolve(sourcePackageRoot, 'package.json'), 'utf8').then(text => JSON.parse(text) as {
        name?: string
        private?: boolean
        version?: string
      }),
      readFile(resolve(repositoryRoot, 'cordis.patch.yml'), 'utf8'),
      readFile(resolve(sourcePackageRoot, 'cordis.patch.yml'), 'utf8'),
    ])

    expect(repositoryManifest.name).toBe('@flowingspring/dsh-voco')
    expect(repositoryManifest.private).toBeUndefined()
    expect(repositoryManifest.version).toBe(sourcePackageManifest.version)
    expect(repositoryManifest.dependencies).not.toHaveProperty('@flowingspring/dsh-voco')
    expect(repositoryManifest.main).toBe('lib/index.js')
    expect(repositoryManifest.types).toBe('lib/types/index.d.ts')
    expect(sourcePackageManifest).toEqual(expect.objectContaining({
      name: '@flowingspring/dsh-voco-source',
      private: true,
    }))
    expect(repositoryPatch.replaceAll('\r\n', '\n')).toBe(packagePatch.replaceAll('\r\n', '\n'))
  })

  it('keeps public README release links aligned with the package version', async () => {
    const manifest = JSON.parse(await readFile(resolve(repositoryRoot, 'package.json'), 'utf8')) as {
      version: string
    }
    const readmes = await Promise.all([
      resolve(repositoryRoot, 'README.md'),
      resolve(repositoryRoot, 'README.en.md'),
      resolve(sourcePackageRoot, 'README.md'),
      resolve(sourcePackageRoot, 'README.zh.md'),
    ].map(path => readFile(path, 'utf8')))
    const tarballUrl = `/releases/download/v${manifest.version}/flowingspring-dsh-voco-${manifest.version}.tgz`
    const releaseUrl = `/releases/tag/v${manifest.version}`

    for (const readme of readmes) {
      expect(readme).toContain(tarballUrl)
      expect(readme).toContain(releaseUrl)
    }
  })
})
