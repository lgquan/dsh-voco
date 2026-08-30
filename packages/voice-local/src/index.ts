/** Silence-gated SiliconFlow cloud ASR with Edge TTS. */
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { loadEnvFile } from 'node:process'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type { VoiceProvider } from '@flowingspring/dsh-voice'
import { DEFAULT_EDGE_TTS_RATE } from './edge-tts.ts'
import { LocalSession } from './session.ts'
import { NodeSpeechBackend } from './node-backend.ts'

export const name = 'voice-local'
export const inject = ['voice']
export const VOICE_LOCAL_SETTINGS_NAMESPACE = settingsNamespace('voice-local')
export const SILICONFLOW_API_KEY_REF = credentialRef('SILICONFLOW_API_KEY')

export interface Config {
  readonly apiKey?: string
  readonly endpoint?: string
  readonly model?: string
  readonly interactionMode?: 'speech-shell' | 'frontend-agent'
  readonly requestTimeoutMs?: number
  readonly inputSampleRate?: number
  readonly outputSampleRate?: number
  readonly ttsRate?: string
  readonly silenceDurationMs?: number
  readonly speechThreshold?: number
  readonly minSpeechDurationMs?: number
  readonly preRollMs?: number
  readonly trailingSilenceMs?: number
  readonly maxUtteranceMs?: number
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  endpoint: z.string().default('https://api.siliconflow.cn/v1/audio/transcriptions'),
  model: z.string().default('XingChenAGI/XingChenASR-V3.2-Ultra'),
  interactionMode: z.union(['speech-shell', 'frontend-agent']).default('speech-shell'),
  requestTimeoutMs: z.natural().min(1).default(60_000),
  inputSampleRate: z.natural().min(1).default(16_000),
  outputSampleRate: z.natural().min(1).default(48_000),
  ttsRate: z.string().default(DEFAULT_EDGE_TTS_RATE),
  silenceDurationMs: z.natural().min(100).default(1_500),
  speechThreshold: z.number().min(0.001).max(0.5).default(0.015),
  minSpeechDurationMs: z.natural().min(20).default(250),
  preRollMs: z.natural().default(400),
  trailingSilenceMs: z.natural().default(200),
  maxUtteranceMs: z.natural().min(1_000).default(60_000),
})

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))

/**
 * Load development configuration from either the source workspace or the
 * bundled single-package layout. DSH-installed profiles still use the
 * process environment, so no package-local `.env` is required in production.
 */
function loadProjectEnv(): void {
  const candidates = [
    resolve(process.cwd(), '.env'),
    resolve(PACKAGE_ROOT, '../../../.env'),
    resolve(PACKAGE_ROOT, '../../../../.env'),
  ]
  const loaded = new Set<string>()
  for (const filename of candidates) {
    if (loaded.has(filename) || !existsSync(filename)) continue
    loaded.add(filename)
    loadEnvFile(filename)
  }
}

export function apply(ctx: Context, config: Config = {}): () => void {
  // The official provider owns env layering. Promoting a .env value into
  // process.env here would make the credentials UI correctly treat it as a
  // read-only inherited value and disable its input.
  if (ctx.get('credentials') === undefined) loadProjectEnv()
  let current = (): Config => config
  installSettingsSection(ctx, VOICE_LOCAL_SETTINGS_NAMESPACE, Config, config, {
    setSource: source => { current = source },
    onChange: () => {},
  })
  const provider: VoiceProvider = {
    id: 'local',
    available: () => true,
    connect: async ({ voiceSessionId, emit }) => {
      const active = current()
      const backend = new NodeSpeechBackend({
        apiKey: await resolveSiliconFlowApiKey(ctx, active),
        endpoint: active.endpoint ?? 'https://api.siliconflow.cn/v1/audio/transcriptions',
        model: active.model ?? 'XingChenAGI/XingChenASR-V3.2-Ultra',
        requestTimeoutMs: active.requestTimeoutMs ?? 60_000,
        inputSampleRate: active.inputSampleRate ?? 16_000,
        outputSampleRate: active.outputSampleRate ?? 48_000,
        ttsRate: active.ttsRate ?? DEFAULT_EDGE_TTS_RATE,
        silenceDurationMs: active.silenceDurationMs ?? 1_500,
        speechThreshold: active.speechThreshold ?? 0.015,
        minSpeechDurationMs: active.minSpeechDurationMs ?? 250,
        preRollMs: active.preRollMs ?? 400,
        trailingSilenceMs: active.trailingSilenceMs ?? 200,
        maxUtteranceMs: active.maxUtteranceMs ?? 60_000,
      })
      const session = new LocalSession(backend, emit, voiceSessionId, active.interactionMode ?? 'speech-shell')
      try { await session.start(); return session } catch (error: unknown) {
        await session.close().catch(() => {})
        throw error
      }
    },
  }
  return ctx.voice.registerProvider(provider)
}

/** Resolve the key per connection so a settings-page write reaches the next attempt. */
export async function resolveSiliconFlowApiKey(ctx: Context, config: Config): Promise<string> {
  if (config.apiKey !== undefined && config.apiKey.trim() !== '') return config.apiKey
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) return (await credentials.resolve(SILICONFLOW_API_KEY_REF))?.value ?? ''
  return process.env.SILICONFLOW_API_KEY ?? ''
}

export { LocalSession } from './session.ts'
export { NodeSpeechBackend, type NodeSpeechConfig } from './node-backend.ts'
export { SiliconFlowAsr, pcm16MonoWav, type SiliconFlowAsrConfig } from './siliconflow-asr.ts'
export type { SpeechBackend, SpeechBackendEvent } from './speech-backend.ts'
