import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { VoiceClientSnapshot, VoiceClientState } from './voice-controller.ts'
import type { VoiceKey } from './locales.ts'
import css from './VoiceOverlay.module.css'

/** Root-level voice connection actions. */
export interface VoiceOverlayInjected {
  hooks: {
    voice: { getSnapshot(): VoiceClientSnapshot; subscribe(listener: () => void): () => void }
  }
  readonly stopVoice: () => Promise<void>
}

export type VoiceOverlayProps =
  PropsRuntime<'shell.overlay'> & InjectFace<VoiceOverlayInjected> & PropsLocale<'voice'>

const STATE_KEYS: Record<Exclude<VoiceClientState, 'off'>, VoiceKey> = {
  connecting: 'overlay.connecting',
  listening: 'overlay.listening',
  speaking: 'overlay.speaking',
  error: 'overlay.error',
}

/** Keep the active Voice Session controllable while another Session is selected. */
export function VoiceOverlay({ useVoice, stopVoice, t }: VoiceOverlayProps) {
  const voice = useVoice(snapshot => snapshot)
  if (voice.state === 'off') return null
  const statusKey = voice.inputMuted && voice.state !== 'error' ? 'overlay.muted' : STATE_KEYS[voice.state]
  return (
    <aside className={css.root} data-voice-overlay data-state={voice.state} data-muted={voice.inputMuted} aria-live="polite">
      <span className={css.wave} aria-hidden>
        <i /><i /><i /><i />
      </span>
      <span className={css.status}>{t(statusKey)}</span>
      <button type="button" className={css.stop} onClick={() => { void stopVoice() }}>
        {t('overlay.stop')}
      </button>
    </aside>
  )
}
