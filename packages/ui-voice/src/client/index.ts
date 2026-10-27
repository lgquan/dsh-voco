/** Browser voice UI assembly. @module @flowingspring/dsh-client-ui-voice/client */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-settings-controller/remote'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { VoiceControl, type VoiceControlInjected } from './VoiceControl.tsx'
import {
  VoiceDelegationView, type VoiceDelegationInjected,
  VoiceUtteranceView, type VoiceUtteranceInjected,
} from './VoiceNodeViews.tsx'
import { VoiceOverlay, type VoiceOverlayInjected } from './VoiceOverlay.tsx'
import { VoiceSessionMarkers, type VoiceSessionMarkersInjected } from './VoiceSessionMarkers.tsx'
import { VocoSettingsCard } from './VocoSettingsCard.tsx'
import { VoiceController } from './voice-controller.ts'
import { VoiceHistoryStore } from './voice-history.ts'
import { VoiceTextSubmitBridge, type VoiceTextInput } from './voice-text-submit.ts'
import { voiceDelegationDefinition, voiceUtteranceDefinition } from './voice-definitions.ts'
import { en, NS, type VoiceKey, zh } from './locales.ts'
import { isSessionEffectivelyArchived } from './session-archive.ts'
import { VOCO_SETTINGS_NAMESPACE, VocoSettingsController } from './voco-settings-controller.ts'

export type { VoiceKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Browser Voice conversation copy. */
    voice: VoiceKey
  }
}

export const inject = [
  'conversation', 'uiConversation', 'slots', 'sessions', 'workspaces', 'uiWorkspace', 'locale',
  'remote', 'remote.credentials',
]

type SessionAddress = {
  readonly parentSessionId: SessionId
  readonly childSessionId: SessionId
  readonly mode: 'one-shot' | 'continuable'
}

/**
 * The Harness model-selection UI intentionally hides addressed children. Voice
 * tasks are ordinary durable Agent Sessions, so let that official UI use the
 * same model directory as the parent while retaining navigationAddress for
 * child routing and breadcrumbs.
 */
function enableChildModelSelection(ctx: Context): void {
  const sessions = ctx.sessions as typeof ctx.sessions & {
    subagentAddress: (sessionId: SessionId) => SessionAddress | undefined
    navigationAddress?: (sessionId: SessionId) => SessionAddress | undefined
  }
  const original = sessions.subagentAddress
  if (typeof original !== 'function') return
  ctx.effect(() => {
    sessions.subagentAddress = () => undefined
    return () => { sessions.subagentAddress = original }
  }, 'ui-voice: child model selection compatibility')
}

/** Refresh the Host-backed Session list when the runtime exposes its baseline pull. */
function refreshSessions(ctx: Context): void {
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
export function apply(ctx: Context): void {
  const vocoSettings = new VocoSettingsController(ctx.remote.credentials)
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
    return ctx.conversation.input.for(scope as unknown as Context) as unknown as VoiceTextInput
  })
  const stopVoice = (): Promise<void> => controller.stop()
  const startVoice = async (sourceSessionId: SessionId): Promise<void> => {
    ctx.uiWorkspace.openSession(sourceSessionId)
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
    beginPushToTalk: (sessionId) => { controller.beginPushToTalk(sessionId) },
    endPushToTalk: () => { controller.endPushToTalk() },
    interruptResponse: () => { controller.interruptResponse() },
    setVoiceMuted: (muted) => { controller.setInputMuted(muted) },
  })
  const voiceOverlayInjected = (): VoiceOverlayInjected => ({ hooks: { voice: controller }, stopVoice })
  const voiceSessionMarkersInjected = (): VoiceSessionMarkersInjected => ({
    hooks: { voiceHistory: history.snapshot },
    refreshSubagents: (parentSessionId) => {
      const refresh = (ctx.sessions as typeof ctx.sessions & {
        refreshSubagents?: (id: SessionId) => Promise<void>
      }).refreshSubagents
      if (refresh === undefined) return
      void refresh.call(ctx.sessions, parentSessionId).catch((error: unknown) => {
        console.warn('voice subagent catalog refresh failed:', error)
      })
    },
  })
  const utteranceInjected = (): VoiceUtteranceInjected => ({ hooks: { voice: controller } })
  const delegationInjected = (): VoiceDelegationInjected => ({
    hooks: { voice: controller },
    recordTaskActivity: (id, at, parentSessionId) => { history.recordTaskActivity(id, at, parentSessionId) },
    openSession: (id) => {
      if (isEffectivelyArchivedInContext(ctx, id)) return
      ctx.uiWorkspace.openSession(ctx.sessions.subagentAddress(id) ?? id)
    },
    cancelTask: (id) => { controller.cancelTask(id) },
  })
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-voice: dictionaries')
  ctx.effect(() => ctx.remote.$on('credentials/reference-updated', ref => {
    vocoSettings.refreshCredential(ref)
  }), 'ui-voice: credential invalidations')
  ctx.effect(() => async () => { await controller.stop() }, 'ui-voice: transport teardown')
  ctx.effect(() => () => { textSubmit.dispose() }, 'ui-voice: text submit bridge teardown')
  ctx.effect(() => () => { history.dispose() }, 'ui-voice: history persistence teardown')
  enableChildModelSelection(ctx)
  ctx.uiConversation.events.register(voiceUtteranceDefinition)
  ctx.uiConversation.events.register(voiceDelegationDefinition)
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
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: VOCO_SETTINGS_NAMESPACE,
    order: 20,
    label: () => t('settings.title'),
    locale: NS,
    inject: () => vocoSettings.inject(),
  }, VocoSettingsCard))
}

/** Archive-manager archives one requested ID; Voice treats that state as
 * inherited by every descendant without mutating the third-party archive set. */
function isEffectivelyArchivedInContext(ctx: Context, sessionId: SessionId): boolean {
  const workspaces = (ctx as Context & {
    workspaces?: { list: { getSnapshot(): { readonly archivedSessionIds: readonly SessionId[] } } }
  }).workspaces
  if (workspaces === undefined) return false
  const snapshot = ctx.sessions.list.getSnapshot()
  const sessions = ctx.sessions as typeof ctx.sessions & {
    navigationAddress?: (id: SessionId) => { readonly parentSessionId: SessionId } | undefined
  }
  return isSessionEffectivelyArchived(
    sessionId,
    workspaces.list.getSnapshot().archivedSessionIds,
    snapshot.byId,
    id => sessions.navigationAddress?.(id)?.parentSessionId,
  )
}
