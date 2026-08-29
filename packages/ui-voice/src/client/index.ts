/** Browser voice UI assembly. @module @flowingspring/dsh-client-ui-voice/client */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { VoiceControl, type VoiceControlInjected } from './VoiceControl.tsx'
import {
  VoiceDelegationView, type VoiceDelegationInjected,
  VoiceUtteranceView, type VoiceUtteranceInjected,
} from './VoiceNodeViews.tsx'
import { VoiceOverlay, type VoiceOverlayInjected } from './VoiceOverlay.tsx'
import { VoiceSessionMarkers, type VoiceSessionMarkersInjected } from './VoiceSessionMarkers.tsx'
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

/** Refresh the Host-backed Session list when the runtime exposes its baseline pull. */
function refreshSessions(ctx: ClientContext): void {
  // `refresh()` exists on the concrete SessionRuntime used by dsh Web, but is
  // intentionally omitted from the narrow feature-facing ISessions contract.
  // Keep this compatibility bridge optional for older runtimes and fixtures.
  const service = ctx.sessions as unknown as { refresh?: () => Promise<void> }
  if (typeof service.refresh !== 'function') return
  void service.refresh.call(ctx.sessions).catch((cause: unknown) => {
    console.warn('voice session list refresh failed:', cause)
  })
}

/** Mount root transport controls and durable Voice conversation renderers. @param ctx - browser context. */
export function apply(ctx: ClientContext): void {
  const controller = new VoiceController({
    onConversationStarted: () => {
      // Voice events are appended by the Host, while the browser's session
      // list keeps its own blank-bit cache. Refresh once after the first
      // completed turn so Workspace new-session creation does not reuse the
      // now-engaged Voice Session.
      refreshSessions(ctx)
    },
  })
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
    interruptResponse: () => { controller.interruptResponse() },
    setVoiceMuted: (muted) => { controller.setInputMuted(muted) },
  })
  const voiceOverlayInjected = (): VoiceOverlayInjected => ({ hooks: { voice: controller }, stopVoice })
  const voiceSessionMarkersInjected = (): VoiceSessionMarkersInjected => ({
    hooks: { voiceHistory: history.snapshot },
  })
  const utteranceInjected = (): VoiceUtteranceInjected => ({ hooks: { voice: controller } })
  const delegationInjected = (): VoiceDelegationInjected => ({
    hooks: { voice: controller },
    openSession: (id) => { ctx.sessions.open(id) },
    cancelTask: (id) => { controller.cancelTask(id) },
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
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'voice-session-markers',
    order: 10,
    locale: NS,
    inject: voiceSessionMarkersInjected,
  }, VoiceSessionMarkers))
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
