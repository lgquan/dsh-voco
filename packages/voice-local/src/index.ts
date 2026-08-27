/** Local CPU speech provider using a long-lived Python worker. */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { VoiceProvider } from '@wayneyu430227/dsh-voice'
import { LocalSession } from './session.ts'
import { PythonSpeechBackend } from './python-worker.ts'

export const name = 'voice-local'
export const inject = ['voice']

export interface Config {
  readonly pythonPath?: string
  readonly workerScript?: string
  readonly modelDir?: string
  readonly ttsRoot?: string
  readonly startupTimeoutMs?: number
  readonly inputSampleRate?: number
  readonly outputSampleRate?: number
}

export const Config: z<Config> = z.object({
  pythonPath: z.string().default('python'),
  workerScript: z.string().default('speech/worker.py'),
  modelDir: z.string().default('speech/moss_tts_runtime/models'),
  ttsRoot: z.string(),
  startupTimeoutMs: z.natural().min(1).default(120_000),
  inputSampleRate: z.natural().min(1).default(16_000),
  outputSampleRate: z.natural().min(1).default(48_000),
})

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))

/** Register the local provider without exposing worker/model details to consumers. */
export function apply(ctx: Context, config: Config = {}): () => void {
  const provider: VoiceProvider = {
    id: 'local',
    available: () => true,
    connect: async ({ voiceSessionId, emit }) => {
      const backend = new PythonSpeechBackend({
        pythonPath: config.pythonPath ?? 'python',
        workerScript: resolve(PACKAGE_ROOT, config.workerScript ?? '../../../speech/worker.py'),
        ...(config.modelDir === undefined ? {} : { modelDir: config.modelDir }),
        ...(config.ttsRoot === undefined ? {} : { ttsRoot: config.ttsRoot }),
        startupTimeoutMs: config.startupTimeoutMs ?? 120_000,
        inputSampleRate: config.inputSampleRate ?? 16_000,
        outputSampleRate: config.outputSampleRate ?? 48_000,
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
export { PythonSpeechBackend, type PythonWorkerConfig } from './python-worker.ts'
export type { SpeechBackend, SpeechBackendEvent } from './speech-backend.ts'
