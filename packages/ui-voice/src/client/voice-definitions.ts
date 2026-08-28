import type {
  ChatConversationViewNode, ConversationNodeDefinition, SessionId,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  TaskObservation, VoiceTaskId, VoiceUtteranceId,
} from '@lgquan/dsh-voice'

/** Renderer-ready durable Voice utterance. */
export interface VoiceUtteranceChatData {
  readonly utteranceId: VoiceUtteranceId
  readonly role: 'user' | 'assistant'
  readonly text?: string
  readonly state: 'streaming' | 'completed' | 'interrupted'
}

/** Renderer-ready delegated task link and its latest observation. */
export interface VoiceDelegationChatData {
  readonly taskId: VoiceTaskId
  readonly taskSessionId: SessionId
  readonly input: string
  readonly status: TaskObservation['status']
  readonly update?: string
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** One user ASR or assistant TTS transcript produced in Voice Mode. */
    'voice-utterance': VoiceUtteranceChatData
    /** One independent DSH task delegated by the Voice frontend Agent. */
    'voice-delegation': VoiceDelegationChatData
  }
}

type VoiceUtteranceState = VoiceUtteranceChatData
type VoiceDelegationState = VoiceDelegationChatData

/** Fold one streamed utterance into a stable Chat node. */
export const voiceUtteranceDefinition: ConversationNodeDefinition<VoiceUtteranceState> = {
  kind: 'voice-utterance',
  target: 'chat',
  match: (event) => {
    if (event.type === 'voice/utterance-start') {
      return { id: String(event.data.utteranceId), role: 'start' }
    }
    if (event.type === 'voice/utterance-end') {
      return { id: String(event.data.utteranceId), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'voice/utterance-start') {
      throw new Error('voice utterance start requires voice/utterance-start')
    }
    return {
      utteranceId: match.event.data.utteranceId,
      role: match.event.data.role,
      state: 'streaming',
    }
  },
  update: (context, match) => {
    if (match.event.type !== 'voice/utterance-end') return context.state
    return {
      ...context.state,
      text: match.event.data.text,
      state: match.event.data.state,
    }
  },
  buildViewNode: (context): ChatConversationViewNode | null => {
    if (context.start === undefined || context.state === undefined) return null
    const emptyInterrupted = context.state.state === 'interrupted'
      && (context.state.text?.trim() ?? '') === ''
    return {
      key: context.key,
      kind: 'voice-utterance',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      // A live start may already be materialized before an empty noise segment
      // settles. Conversation nodes cannot be withdrawn after publication, so
      // keep its stable identity and hide it instead.
      visibility: emptyInterrupted ? 'hidden' : 'visible',
      data: context.state as VoiceUtteranceState,
    }
  },
}

/** Fold a delegated task and all observations into one navigation card. */
export const voiceDelegationDefinition: ConversationNodeDefinition<VoiceDelegationState> = {
  kind: 'voice-delegation',
  target: 'chat',
  match: (event) => {
    if (event.type === 'voice/task-delegated') {
      return { id: String(event.data.taskId), role: 'start' }
    }
    if (event.type === 'voice/task-observation') {
      return { id: String(event.data.taskId), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'voice/task-delegated') {
      throw new Error('voice delegation start requires voice/task-delegated')
    }
    return {
      taskId: match.event.data.taskId,
      taskSessionId: match.event.data.taskSessionId,
      input: match.event.data.input,
      status: 'accepted',
    }
  },
  update: (context, match) => {
    if (match.event.type !== 'voice/task-observation') return context.state
    const observation = match.event.data
    const update = observation.voiceMessage?.text
      ?? observation.announcement
      ?? observation.reason
      ?? context.state.update
    return {
      ...context.state,
      status: observation.status,
      ...(update === undefined ? {} : { update }),
    }
  },
  buildViewNode: (context): ChatConversationViewNode | null => {
    if (context.start === undefined) return null
    return {
      key: context.key,
      kind: 'voice-delegation',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data: context.state as VoiceDelegationState,
    }
  },
}
