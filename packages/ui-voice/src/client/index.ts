/** Browser voice UI assembly. @module @flowingspring/dsh-client-ui-voice/client */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { VoiceControl, type VoiceControlInjected } from './VoiceControl.tsx'
import { VoiceHistoryAction, type VoiceHistoryActionInjected } from './VoiceHistoryAction.tsx'
import {
  VoiceDelegationView, type VoiceDelegationInjected,
  VoiceUtteranceView, type VoiceUtteranceInjected,
} from './VoiceNodeViews.tsx'
import { VoiceOverlay, type VoiceOverlayInjected } from './VoiceOverlay.tsx'
import { VoiceController } from './voice-controller.ts'
import { VoiceHistoryStore } from './voice-history.ts'
import { VoiceTextSubmitBridge, type VoiceTextInput } from './voice-text-submit.ts'
import { voiceDelegationDefinition, voiceUtteranceDefinition } from './voice-definitions.ts'
import { en, NS, type VoiceKey, zh } from './locales.ts'

export type { VoiceKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Browser Voice conversation copy. */
    voice: VoiceKey
  }
}

export const inject = ['conversation', 'conversationEvents', 'slots', 'sessions', 'locale']

/** Mount root transport controls and durable Voice conversation renderers. @param ctx - browser context. */
export function apply(ctx: ClientContext): void {
  const controller = new VoiceController()
  const history = new VoiceHistoryStore()
  const textSubmit = new VoiceTextSubmitBridge(controller, (sessionId) => {
    const scope = ctx.sessions.scope(sessionId)
    if (scope === undefined) throw new Error(`voice input session "${sessionId}" is unavailable`)
    return ctx.conversation.input.for(scope) as VoiceTextInput
  })
  const stopVoice = (): Promise<void> => controller.stop()
  const startVoice = async (sourceSessionId: SessionId): Promise<void> => {
    ctx.sessions.open(sourceSessionId)
    textSubmit.install(sourceSessionId)
    await controller.start(sourceSessionId)
    history.record(sourceSessionId)
  }
  const voiceControlInjected = (): VoiceControlInjected => ({
    hooks: { voice: controller },
    startVoice,
    retryVoice: async () => {
      await controller.retry()
      const sessionId = controller.getSnapshot().sessionId
      if (sessionId !== undefined) history.record(sessionId)
    },
    stopVoice,
  })
  const voiceOverlayInjected = (): VoiceOverlayInjected => ({
    hooks: { voice: controller },
    openVoiceSession: (id) => { ctx.sessions.open(id) },
    stopVoice,
  })
  const utteranceInjected = (): VoiceUtteranceInjected => ({ hooks: { voice: controller } })
  const delegationInjected = (): VoiceDelegationInjected => ({
    hooks: { voice: controller },
    openSession: (id) => { ctx.sessions.open(id) },
    cancelTask: (id) => { controller.cancelTask(id) },
  })
  const historyInjected = (): VoiceHistoryActionInjected => ({
    hooks: { voice: controller, voiceHistory: history.snapshot },
    openSession: (id) => {
      history.record(id)
      ctx.sessions.open(id)
    },
  })

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-voice: dictionaries')
  ctx.effect(() => async () => { await controller.stop() }, 'ui-voice: transport teardown')
  ctx.effect(() => () => { textSubmit.dispose() }, 'ui-voice: text submit bridge teardown')
  ctx.effect(() => () => { history.dispose() }, 'ui-voice: history persistence teardown')
  ctx.conversationEvents.register(voiceUtteranceDefinition)
  ctx.conversationEvents.register(voiceDelegationDefinition)
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'voice',
    order: 20,
    locale: NS,
    inject: voiceControlInjected,
  }, VoiceControl))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'voice-active',
    order: 20,
    locale: NS,
    inject: voiceOverlayInjected,
  }, VoiceOverlay))
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'voice-history',
    order: 10,
    locale: NS,
    inject: historyInjected,
  }, VoiceHistoryAction))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'voice-utterance',
    locale: NS,
    inject: utteranceInjected,
  }, VoiceUtteranceView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'voice-delegation',
    locale: NS,
    inject: delegationInjected,
  }, VoiceDelegationView))
}
