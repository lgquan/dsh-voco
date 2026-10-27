import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-settings-controller/remote'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

export const VOCO_SETTINGS_NAMESPACE = 'voice-local'
export const SILICONFLOW_API_KEY_REF = 'SILICONFLOW_API_KEY'

export interface VocoSettingsState {
  readonly available: boolean
  readonly writable: boolean
  readonly dirty: boolean
  readonly saving: boolean
  readonly failed: boolean
  readonly apiKey: string
  readonly apiKeyConfigured: boolean
  readonly apiKeyWritable: boolean
}

export interface VocoSettingsFace {
  readonly hooks: { readonly vocoSettings: SnapshotStore<VocoSettingsState> }
  readonly editApiKey: (value: string) => void
  readonly save: () => void
  readonly discard: () => void
}

/** Bridges the voice-local namespace and the write-only DSH credentials API. */
export class VocoSettingsController {
  private readonly store: SnapshotStore<VocoSettingsState>
  private draft = ''
  private saving = false
  private failed = false
  private available = false
  private credential = { configured: false, writable: false }

  constructor(private readonly credentials: Context['remote']['credentials']) {
    this.store = createSnapshotStore(this.projection())
    void this.readCredential()
  }

  refreshCredential(ref: string): void {
    if (ref === SILICONFLOW_API_KEY_REF) void this.readCredential()
  }

  inject(): VocoSettingsFace {
    return {
      hooks: { vocoSettings: this.store },
      editApiKey: value => {
        this.draft = value
        this.failed = false
        this.publish()
      },
      save: () => { void this.save() },
      discard: () => {
        this.draft = ''
        this.failed = false
        this.publish()
      },
    }
  }

  private projection(): VocoSettingsState {
    return {
      available: this.available,
      writable: this.credential.writable,
      dirty: this.draft.trim() !== '',
      saving: this.saving,
      failed: this.failed,
      apiKey: this.draft,
      apiKeyConfigured: this.credential.configured,
      apiKeyWritable: this.credential.writable,
    }
  }

  private publish(): void { this.store.set(this.projection()) }

  private async readCredential(): Promise<void> {
    let result
    try {
      result = await this.credentials.describe([SILICONFLOW_API_KEY_REF])
    } catch {
      return
    }
    if (!result.ok) return
    const view = result.value[SILICONFLOW_API_KEY_REF]
    this.available = true
    this.credential = {
      configured: view?.configured ?? false,
      writable: view?.writable ?? false,
    }
    this.publish()
  }

  private async save(): Promise<void> {
    const value = this.draft.trim()
    if (value === '' || this.saving || !this.available || !this.credential.writable) return
    this.saving = true
    this.failed = false
    this.publish()
    try {
      const result = await this.credentials.set(SILICONFLOW_API_KEY_REF, value)
      if (!result.ok) {
        this.failed = true
        return
      }
      await this.readCredential()
      if (this.credential.configured) this.draft = ''
      else this.failed = true
    } catch {
      this.failed = true
    } finally {
      this.saving = false
      this.publish()
    }
  }
}
