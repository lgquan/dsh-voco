import { useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { VoiceClientSnapshot } from './voice-controller.ts'
import type { VoiceDelegationChatData } from './voice-definitions.ts'
import type { VoiceKey } from './locales.ts'
import css from './VoiceNodeViews.module.css'

/** Live transcript source injected into the Voice utterance renderer. */
export interface VoiceUtteranceInjected {
  hooks: {
    voice: { getSnapshot(): VoiceClientSnapshot; subscribe(listener: () => void): () => void }
  }
}

/** Navigation action injected into the task-card renderer. */
export interface VoiceDelegationInjected {
  hooks: {
    voice: { getSnapshot(): VoiceClientSnapshot; subscribe(listener: () => void): () => void }
  }
  readonly openSession: (id: SessionId) => void
  readonly cancelTask: (id: string) => void
}

export type VoiceUtteranceViewProps =
  PropsRuntime<'conversation.chat.node', 'voice-utterance'>
  & InjectFace<VoiceUtteranceInjected>
  & PropsLocale<'voice'>
export type VoiceDelegationViewProps =
  PropsRuntime<'conversation.chat.node', 'voice-delegation'>
  & InjectFace<VoiceDelegationInjected>
  & PropsLocale<'voice'>

/** Render a durable Voice utterance while replacing its unsettled text with live WebSocket deltas. */
export function VoiceUtteranceView({ node, sessionId, useVoice, t }: VoiceUtteranceViewProps) {
  const liveText = useVoice(snapshot => snapshot.sessionId === sessionId
    ? snapshot.textById[String(node.data.utteranceId)]?.text
    : undefined)
  const text = node.data.text ?? liveText ?? (node.data.role === 'user'
    ? t('utterance.user.pending')
    : t('utterance.assistant.pending'))
  return (
    <article
      className={css.utterance}
      data-voice-utterance
      data-role={node.data.role}
      data-state={node.data.state}
    >
      <div className={css.bubble}>{text}</div>
      <div className={css.meta}>
        <span className={css.voiceBadge}>
          <span className={css.miniWave} aria-hidden><i /><i /><i /></span>
          {t('badge.voice')}
        </span>
        {node.data.state === 'interrupted' && <span>{t('utterance.interrupted')}</span>}
      </div>
    </article>
  )
}

const STATUS_KEYS: Record<VoiceDelegationChatData['status'], VoiceKey> = {
  accepted: 'task.status.accepted',
  queued: 'task.status.queued',
  running: 'task.status.running',
  'waiting-user': 'task.status.waiting-user',
  completed: 'task.status.completed',
  failed: 'task.status.failed',
  cancelled: 'task.status.cancelled',
  interrupted: 'task.status.interrupted',
}

/** Render the task link from a Voice Session to its bound background Agent Session. */
export function VoiceDelegationView({ node, sessionId, useSessions, useVoice, openSession, cancelTask, t }: VoiceDelegationViewProps) {
  const [expanded, setExpanded] = useState(false)
  const navigable = useSessions(sessions => sessions.ids.includes(node.data.taskSessionId))
  const connected = useVoice(voice => voice.sessionId === sessionId && voice.state !== 'off' && voice.state !== 'error')
  const cancellable = connected && !isTerminalTaskStatus(node.data.status)
  return (
    <article className={css.taskCard} data-voice-delegation data-status={node.data.status}>
      <header className={css.taskHeader}>
        <span className={css.taskDot} aria-hidden />
        <span className={css.taskTitle}>{t('task.title')}</span>
        <span className={css.taskStatus}>{t(STATUS_KEYS[node.data.status])}</span>
      </header>
      {expanded && (
        <div className={css.taskDetails}>
          <p className={css.taskInput}>{node.data.input}</p>
          {node.data.update !== undefined && <p className={css.taskUpdate}>{node.data.update}</p>}
        </div>
      )}
      <div className={css.taskActions}>
        <button type="button" className={css.taskLink} onClick={() => { setExpanded(value => !value) }}>
          {expanded ? t('task.collapse') : t('task.expand')}
        </button>
        {cancellable && (
          <button type="button" className={`${css.taskLink} ${css.taskCancel}`} onClick={() => { cancelTask(String(node.data.taskId)) }}>
            {t('task.cancel')}
          </button>
        )}
        <button
          type="button"
          className={css.taskLink}
          disabled={!navigable}
          onClick={() => { openSession(node.data.taskSessionId) }}
        >
          {t('task.open')}
        </button>
      </div>
    </article>
  )
}

function isTerminalTaskStatus(status: VoiceDelegationChatData['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted'
}
