import { useEffect, useRef } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { VoiceClientSnapshot } from './voice-controller.ts'
import css from './VoiceControl.module.css'

/** Business callbacks and the root-owned transport snapshot. */
export interface VoiceControlInjected {
  hooks: {
    voice: { getSnapshot(): VoiceClientSnapshot; subscribe(listener: () => void): () => void }
  }
  /** Start a fresh Voice conversation located from the current Session. */
  readonly startVoice: (sourceSessionId: SessionId) => Promise<void>
  readonly retryVoice: () => Promise<void>
  readonly beginPushToTalk: (sourceSessionId: SessionId) => void
  readonly endPushToTalk: () => void
  readonly interruptResponse: () => void
  readonly setVoiceMuted: (muted: boolean) => void
}

export type VoiceControlProps =
  PropsRuntime<'conversation.input.right'> & InjectFace<VoiceControlInjected> & PropsLocale<'voice'>

/** Start a fresh Voice Session from this Session's location or control the active connection. */
export function VoiceControl({
  sessionId, useVoice, startVoice, retryVoice, beginPushToTalk, endPushToTalk, setVoiceMuted, t,
  interruptResponse,
}: VoiceControlProps) {
  const state = useVoice(snapshot => snapshot.state)
  const activeSessionId = useVoice(snapshot => snapshot.sessionId)
  const inputMuted = useVoice(snapshot => snapshot.inputMuted)
  const pushToTalkActive = useVoice(snapshot => snapshot.pushToTalkActive)
  const timer = useRef<number | undefined>(undefined)
  const pointerDown = useRef(false)
  const longPress = useRef(false)
  const suppressClick = useRef(false)

  const clearTimer = (): void => {
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current)
      timer.current = undefined
    }
  }

  const releasePushToTalk = (): void => {
    clearTimer()
    pointerDown.current = false
    if (longPress.current) {
      longPress.current = false
      endPushToTalk()
    }
  }

  useEffect(() => {
    window.addEventListener('blur', releasePushToTalk)
    document.addEventListener('visibilitychange', releasePushToTalk)
    return () => {
      window.removeEventListener('blur', releasePushToTalk)
      document.removeEventListener('visibilitychange', releasePushToTalk)
      releasePushToTalk()
    }
  }, [])

  const toggle = async (): Promise<void> => {
    if (state === 'error' && activeSessionId !== undefined) {
      try { await retryVoice() } catch { /* controller owns the visible error state */ }
      return
    }
    if (state !== 'off' && state !== 'error') {
      setVoiceMuted(!inputMuted)
      return
    }
    try {
      await startVoice(sessionId)
    } catch { /* controller owns the visible error state */ }
  }

  const label = state === 'off'
    ? t('control.start')
    : state === 'error'
      ? t('control.retry')
      : inputMuted
        ? t('control.unmute')
        : t('control.mute')
  const active = state !== 'off' && state !== 'error'
  const interrupt = (): void => {
    try { interruptResponse() } catch { /* controller owns the visible connection state */ }
  }
  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    pointerDown.current = true
    longPress.current = false
    suppressClick.current = false
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    clearTimer()
    timer.current = window.setTimeout(() => {
      timer.current = undefined
      if (!pointerDown.current) return
      longPress.current = true
      suppressClick.current = true
      beginPushToTalk(sessionId)
    }, 400)
  }
  const onPointerUp = (event: React.PointerEvent<HTMLButtonElement>): void => {
    releasePushToTalk()
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }
  const onPointerCancel = (): void => {
    releasePushToTalk()
  }
  const onClick = (): void => {
    if (suppressClick.current) {
      suppressClick.current = false
      return
    }
    void toggle()
  }
  return (
    <span className={css.controls}>
      {state === 'speaking' && (
        <button
          type="button"
          className={`${css.button} ${css.interruptButton}`}
          aria-label={t('control.interrupt')}
          title={t('control.interrupt')}
          data-state={state}
          onClick={interrupt}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
            <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <rect x="5.25" y="5.25" width="5.5" height="5.5" rx="1" fill="currentColor" />
          </svg>
        </button>
      )}
      <button
        type="button"
        className={`${css.button} ${active ? css.active : ''}`}
        aria-label={pushToTalkActive ? t('control.pushToTalk') : label}
        aria-pressed={active ? inputMuted : undefined}
        title={label}
        data-state={state}
        data-muted={inputMuted}
        data-push-to-talk={pushToTalkActive}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={onPointerCancel}
        onClick={onClick}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
          <rect x="5" y="2" width="6" height="8" rx="3" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2M5.5 14h5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          {inputMuted && (
            <path d="M2.5 2.5l11 11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          )}
        </svg>
      </button>
    </span>
  )
}
