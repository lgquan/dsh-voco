import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import {
  createSnapshotStore, type SettingsScope, type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'

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
  private credential = { configured: false, writable: true }

  constructor(
    private readonly scope: SettingsScope<unknown>,
    private readonly api: Pick<IApiClient, 'credentials'>,
  ) {
    this.store = createSnapshotStore(this.projection())
    scope.subscribe(() => { this.publish() })
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
    const snapshot = this.scope.getSnapshot()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
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
    let response
    try {
      response = await this.api.credentials.describe({ refs: [SILICONFLOW_API_KEY_REF] })
    } catch {
      return
    }
    if (!response.result.ok) return
    const view = response.result.value.credentials[SILICONFLOW_API_KEY_REF]
    this.credential = {
      configured: view?.configured ?? false,
      writable: view?.writable ?? true,
    }
    this.publish()
  }

  private async save(): Promise<void> {
    const value = this.draft.trim()
    if (value === '' || this.saving || !this.scope.getSnapshot().writable || !this.credential.writable) return
    this.saving = true
    this.failed = false
    this.publish()
    try {
      const response = await this.api.credentials.set({ ref: SILICONFLOW_API_KEY_REF, value })
      if (!response.result.ok) {
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
