import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it, vi } from 'vitest'
import type { VoiceClientSnapshot } from '../src/client/voice-controller.ts'
import { VoiceTextSubmitBridge, type VoiceTextInput } from '../src/client/voice-text-submit.ts'

const SESSION = 'typed-session' as SessionId

function input(draft: string, imageIds: readonly unknown[] = []) {
  const state = { draft, imageIds }
  const value: VoiceTextInput = {
    state: { getSnapshot: () => state },
    setDraft: vi.fn((text: string) => { state.draft = text }),
    submit: vi.fn(),
    notify: vi.fn(),
  }
  return { state, value }
}

describe('VoiceTextSubmitBridge', () => {
  it('consumes plain composer text while voice is active and restores native submit on dispose', () => {
    let snapshot: VoiceClientSnapshot = { state: 'listening', inputMuted: true, sessionId: SESSION, textById: {} }
    const submitText = vi.fn()
    const current = input('  用语音回答  ')
    const nativeSubmit = current.value.submit
    const bridge = new VoiceTextSubmitBridge({ getSnapshot: () => snapshot, submitText }, () => current.value)
    bridge.install(SESSION)

    current.value.submit()
    expect(submitText).toHaveBeenCalledWith('  用语音回答  ')
    expect(current.value.setDraft).toHaveBeenCalledWith('')
    expect(nativeSubmit).not.toHaveBeenCalled()

    snapshot = { state: 'off', inputMuted: false, textById: {} }
    current.state.draft = '普通文本'
    current.value.submit()
    expect(nativeSubmit).toHaveBeenCalledOnce()

    bridge.dispose()
    expect(current.value.submit).toBe(nativeSubmit)
  })

  it('preserves native submission for attachments and retains the draft on voice errors', () => {
    const withImage = input('带图片', ['image'])
    const imageNative = withImage.value.submit
    const imageBridge = new VoiceTextSubmitBridge({
      getSnapshot: () => ({ state: 'speaking', sessionId: SESSION, textById: {} }),
      submitText: vi.fn(),
    }, () => withImage.value)
    imageBridge.install(SESSION)
    withImage.value.submit()
    expect(imageNative).toHaveBeenCalledOnce()

    const failing = input('不要丢失')
    const error = new Error('transport unavailable')
    const failingBridge = new VoiceTextSubmitBridge({
      getSnapshot: () => ({ state: 'connecting', sessionId: SESSION, textById: {} }),
      submitText: () => { throw error },
    }, () => failing.value)
    failingBridge.install(SESSION)
    failing.value.submit()
    expect(failing.state.draft).toBe('不要丢失')
    expect(failing.value.notify).toHaveBeenCalledWith('error', 'transport unavailable')
  })
})
