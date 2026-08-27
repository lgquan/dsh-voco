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
  readonly openSession: (id: SessionId) => void
}

export type VoiceUtteranceViewProps =
  PropsRuntime<'conversation.chat.node', 'voice-utterance'>
  & InjectFace<VoiceUtteranceInjected>
  & PropsLocale<'voice'>
export type VoiceDelegationViewProps =
  PropsRuntime<'conversation.chat.node', 'voice-delegation'>
  & VoiceDelegationInjected
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
  running: 'task.status.running',
  completed: 'task.status.completed',
  failed: 'task.status.failed',
  cancelled: 'task.status.cancelled',
  interrupted: 'task.status.interrupted',
}

/** Render the minimum one-way link from a Voice Session to its independent DSH task. */
export function VoiceDelegationView({ node, useSessions, openSession, t }: VoiceDelegationViewProps) {
  const navigable = useSessions(sessions => sessions.ids.includes(node.data.taskSessionId))
  return (
    <article className={css.taskCard} data-voice-delegation data-status={node.data.status}>
      <header className={css.taskHeader}>
        <span className={css.taskDot} aria-hidden />
        <span className={css.taskTitle}>{t('task.title')}</span>
        <span className={css.taskStatus}>{t(STATUS_KEYS[node.data.status])}</span>
      </header>
      <p className={css.taskInput}>{node.data.input}</p>
      {node.data.update !== undefined && <p className={css.taskUpdate}>{node.data.update}</p>}
      <button
        type="button"
        className={css.taskLink}
        disabled={!navigable}
        onClick={() => { openSession(node.data.taskSessionId) }}
      >
        {t('task.open')}
      </button>
    </article>
  )
}
