/** Local CPU speech provider using TypeScript and native ONNX runtimes. */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { VoiceProvider } from '@lgquan/dsh-voice'
import { LocalSession } from './session.ts'
import { NodeSpeechBackend } from './node-backend.ts'

export const name = 'voice-local'
export const inject = ['voice']

export interface Config {
  readonly modelDir?: string
  readonly startupTimeoutMs?: number
  readonly inputSampleRate?: number
  readonly outputSampleRate?: number
  readonly threads?: number
  readonly voice?: string
  readonly maxTtsFrames?: number
}

export const Config: z<Config> = z.object({
  modelDir: z.string(),
  startupTimeoutMs: z.natural().min(1).default(120_000),
  inputSampleRate: z.natural().min(1).default(16_000),
  outputSampleRate: z.natural().min(1).default(48_000),
  threads: z.natural().min(1).default(4),
  voice: z.string().default('Junhao'),
  maxTtsFrames: z.natural().min(1),
})

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))

function resolveModelRoot(configured?: string): string {
  const explicit = configured ?? process.env.DSH_VOICE_MODEL_DIR
  if (explicit !== undefined && explicit !== '') return resolve(explicit)
  const workingDirectoryModels = resolve('speech/models')
  return existsSync(workingDirectoryModels)
    ? workingDirectoryModels
    : resolve(PACKAGE_ROOT, '../../../speech/models')
}

/** Register the local provider without exposing worker/model details to consumers. */
export function apply(ctx: Context, config: Config = {}): () => void {
  const provider: VoiceProvider = {
    id: 'local',
    available: () => true,
    connect: async ({ voiceSessionId, emit }) => {
      const backend = new NodeSpeechBackend({
        modelRoot: resolveModelRoot(config.modelDir),
        startupTimeoutMs: config.startupTimeoutMs ?? 120_000,
        inputSampleRate: config.inputSampleRate ?? 16_000,
        outputSampleRate: config.outputSampleRate ?? 48_000,
        threads: config.threads ?? 4,
        voice: config.voice ?? 'Junhao',
        ...(config.maxTtsFrames === undefined ? {} : { maxTtsFrames: config.maxTtsFrames }),
      })
      const session = new LocalSession(backend, emit, voiceSessionId)
      try {
        await session.start()
        return session
      } catch (error: unknown) {
        await session.close().catch(() => {})
        throw error
      }
    },
  }
  return ctx.voice.registerProvider(provider)
}

export { LocalSession } from './session.ts'
export { NodeSpeechBackend, type NodeSpeechConfig } from './node-backend.ts'
export { createModelLayout, assertModelsInstalled, type LocalModelLayout } from './model-layout.ts'
export type { SpeechBackend, SpeechBackendEvent } from './speech-backend.ts'
