import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  Config, SILICONFLOW_API_KEY_REF, VOICE_LOCAL_SETTINGS_NAMESPACE, resolveSiliconFlowApiKey,
} from '../src/index.ts'

describe('voice-local API key configuration', () => {
  it('marks the legacy literal field secret and exposes a stable settings namespace', () => {
    expect(VOICE_LOCAL_SETTINGS_NAMESPACE).toBe('voice-local')
    expect(SILICONFLOW_API_KEY_REF).toBe('SILICONFLOW_API_KEY')
    expect(JSON.stringify(Config.toJSON())).toContain('secret')
  })

  it('prefers an explicit plugin key over the DSH credential reference', async () => {
    const resolve = vi.fn()
    const ctx = { get: () => ({ resolve }) } as unknown as Context
    await expect(resolveSiliconFlowApiKey(ctx, { apiKey: 'plugin-key' })).resolves.toBe('plugin-key')
    expect(resolve).not.toHaveBeenCalled()
  })

  it('resolves the DSH credential reference for settings-page writes', async () => {
    const resolve = vi.fn().mockResolvedValue({ value: 'credential-key', source: 'file' })
    const ctx = { get: (name: string) => name === 'credentials' ? { resolve } : undefined } as unknown as Context
    await expect(resolveSiliconFlowApiKey(ctx, {})).resolves.toBe('credential-key')
    expect(resolve).toHaveBeenCalledWith('SILICONFLOW_API_KEY')
  })
})
