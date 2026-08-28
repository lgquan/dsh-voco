import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { VoiceClientSnapshot } from './voice-controller.ts'

interface VoiceTextInputState {
  readonly draft: string
  readonly imageIds: readonly unknown[]
}

export interface VoiceTextInput {
  readonly state: { getSnapshot(): VoiceTextInputState }
  setDraft(text: string): void
  submit(mode?: unknown): void
  notify(level: 'info' | 'error', text: string): void
}

interface VoiceTextController {
  getSnapshot(): VoiceClientSnapshot
  submitText(text: string): void
}

interface PatchedInput {
  readonly input: VoiceTextInput
  readonly originalOwnDescriptor: PropertyDescriptor | undefined
  readonly patchedSubmit: (mode?: unknown) => void
}

/** Routes the native composer through Voice while preserving its ordinary offline submission. */
export class VoiceTextSubmitBridge {
  private readonly patched = new Map<SessionId, PatchedInput>()

  constructor(
    private readonly voice: VoiceTextController,
    private readonly resolveInput: (sessionId: SessionId) => VoiceTextInput,
  ) {}

  install(sessionId: SessionId): void {
    if (this.patched.has(sessionId)) return
    const input = this.resolveInput(sessionId)
    const originalOwnDescriptor = Object.getOwnPropertyDescriptor(input, 'submit')
    const originalSubmit = input.submit.bind(input)
    const patchedSubmit = (mode?: unknown): void => {
      const voice = this.voice.getSnapshot()
      const state = input.state.getSnapshot()
      const active = voice.sessionId === sessionId
        && voice.state !== 'off'
        && voice.state !== 'error'
      if (!active || state.draft.trim() === '' || state.imageIds.length > 0) {
        originalSubmit(mode)
        return
      }
      try {
        this.voice.submitText(state.draft)
        input.setDraft('')
      } catch (cause: unknown) {
        input.notify('error', cause instanceof Error ? cause.message : String(cause))
      }
    }
    input.submit = patchedSubmit
    this.patched.set(sessionId, { input, originalOwnDescriptor, patchedSubmit })
  }

  dispose(): void {
    for (const { input, originalOwnDescriptor, patchedSubmit } of this.patched.values()) {
      if (input.submit !== patchedSubmit) continue
      if (originalOwnDescriptor === undefined) delete (input as Partial<VoiceTextInput>).submit
      else Object.defineProperty(input, 'submit', originalOwnDescriptor)
    }
    this.patched.clear()
  }
}
