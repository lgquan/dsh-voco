// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VocoSettingsCard, type VocoSettingsCardProps } from '../src/client/VocoSettingsCard.tsx'
import { zh } from '../src/client/locales.ts'
import { VocoSettingsController, type VocoSettingsState } from '../src/client/voco-settings-controller.ts'

afterEach(cleanup)

function scope(): SettingsScope<unknown> {
  const snapshot: SettingsScopeSnapshot<unknown> = {
    status: 'ready', value: {}, base: {}, user: undefined, revision: 0, writable: true, mode: 'host',
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    set: vi.fn(),
    unset: vi.fn(),
  }
}

function response(configured: boolean) {
  return {
    result: {
      ok: true as const,
      value: { credentials: { SILICONFLOW_API_KEY: { configured, writable: true } } },
    },
  }
}

describe('Voco settings controller', () => {
  it('stages a write-only key and saves it through the credentials API', async () => {
    const describe = vi.fn().mockResolvedValueOnce(response(false)).mockResolvedValue(response(true))
    const set = vi.fn().mockResolvedValue({ result: { ok: true, value: {} } })
    const controller = new VocoSettingsController(scope(), { credentials: { describe, set } } as never)
    const face = controller.inject()

    face.editApiKey('  sk-test-value  ')
    expect(face.hooks.vocoSettings.getSnapshot()).toMatchObject({ dirty: true, apiKey: '  sk-test-value  ' })
    face.save()

    await waitFor(() => { expect(set).toHaveBeenCalledWith({ ref: 'SILICONFLOW_API_KEY', value: 'sk-test-value' }) })
    await waitFor(() => {
      expect(face.hooks.vocoSettings.getSnapshot()).toMatchObject({
        dirty: false, apiKey: '', apiKeyConfigured: true, saving: false,
      })
    })
  })

  it('keeps the draft when a credential write is rejected', async () => {
    const describe = vi.fn().mockResolvedValue(response(true))
    const set = vi.fn().mockResolvedValue({
      result: { ok: false, error: { code: 'credential-rejected', message: 'rejected' } },
    })
    const controller = new VocoSettingsController(scope(), { credentials: { describe, set } } as never)
    const face = controller.inject()

    face.editApiKey('replacement-key')
    face.save()

    await waitFor(() => {
      expect(face.hooks.vocoSettings.getSnapshot()).toMatchObject({
        dirty: true, apiKey: 'replacement-key', apiKeyConfigured: true, saving: false, failed: true,
      })
    })
  })
})

describe('Voco settings card', () => {
  it('matches the plugin card interaction with one password field', () => {
    const editApiKey = vi.fn()
    const save = vi.fn()
    const discard = vi.fn()
    const state: VocoSettingsState = {
      available: true, writable: true, dirty: false, saving: false, failed: false,
      apiKey: '', apiKeyConfigured: true, apiKeyWritable: true,
    }
    render(<VocoSettingsCard {...({
      t: (key: keyof typeof zh) => zh[key],
      useVocoSettings: (selector: (value: VocoSettingsState) => unknown) => selector(state),
      editApiKey, save, discard,
    } as unknown as VocoSettingsCardProps)} />)

    fireEvent.click(screen.getByRole('button', { name: '展开设置: 语音助手（Voco）' }))
    const input = screen.getByLabelText('API Key') as HTMLInputElement
    expect(input.type).toBe('password')
    expect(input.value).toBe('')
    expect(screen.getByText('已配置密钥。')).toBeTruthy()
    expect(screen.getByText('硅基流动')).toBeTruthy()
    expect(screen.getByText('XingChenAGI/XingChenASR-V3.2-Ultra（免费）')).toBeTruthy()
    fireEvent.change(input, { target: { value: 'sk-new' } })
    expect(editApiKey).toHaveBeenCalledWith('sk-new')
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
