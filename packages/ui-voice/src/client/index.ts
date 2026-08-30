/** Browser voice UI assembly. @module @flowingspring/dsh-client-ui-voice/client */
import type { ClientContext, SessionFace, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
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
import { isSessionEffectivelyArchived } from './session-archive.ts'

export type { VoiceKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Browser Voice conversation copy. */
    voice: VoiceKey
  }
}

export const inject = ['conversation', 'conversationEvents', 'slots', 'sessions', 'workspaces', 'locale', 'remote']

/** Public archive-manager RPC surface. Kept structural so the voice package
 * remains optional and does not take a hard dependency on the community plugin. */
interface ArchiveManagerWorkspaceRegistry {
  deleteSession?: (sessionId: SessionId) => Promise<{
    readonly ok: boolean
    readonly error?: { readonly message?: string }
  }>
}

function archiveManagerRegistry(ctx: ClientContext): ArchiveManagerWorkspaceRegistry | undefined {
  try {
    const registry = ctx.get('remote.workspaceRegistry') as unknown
    if (registry === null || typeof registry !== 'object') return undefined
    return registry as ArchiveManagerWorkspaceRegistry
  } catch {
    return undefined
  }
}

/** Call archive-manager's complete deletion path when its remote is installed. */
async function deleteWithArchiveManager(ctx: ClientContext, sessionId: SessionId): Promise<void> {
  const deleteSession = archiveManagerRegistry(ctx)?.deleteSession
  if (typeof deleteSession !== 'function') throw new Error('archive-manager 删除服务不可用')
  const result = await deleteSession(sessionId)
  if (!result.ok) throw new Error(result.error?.message ?? 'archive-manager 删除会话失败')
}

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
    childActions: {
      rename: async (id, title) => {
        const session = ensureChildSession(ctx, id)
        if (session === undefined) throw new Error(`unknown session "${id}"`)
        const result = await session.rename(title)
        if (!result.ok) throw new Error(result.error.message)
      },
      fork: async (id) => {
        ensureChildSession(ctx, id)
        const childId = await ctx.sessions.fork({ sessionId: id, increaseTitle: true })
        ctx.sessions.open(childId)
      },
      ...(archiveManagerRegistry(ctx)?.deleteSession === undefined ? {} : {
        delete: async (id: SessionId) => {
          const parentId = (ctx.sessions as typeof ctx.sessions & {
            navigationAddress?: (sessionId: SessionId) => { readonly parentSessionId: SessionId } | undefined
          }).navigationAddress?.(id)?.parentSessionId
          await deleteWithArchiveManager(ctx, id)
          refreshSessions(ctx)
          if (parentId !== undefined) {
            const refreshSubagents = (ctx.sessions as typeof ctx.sessions & {
              refreshSubagents?: (sessionId: SessionId) => Promise<void>
            }).refreshSubagents
            await refreshSubagents?.call(ctx.sessions, parentId)
          }
        },
      }),
    },
    openSession: (id) => {
      if (isEffectivelyArchivedInContext(ctx, id)) return
      const sessions = ctx.sessions as typeof ctx.sessions & {
        subagentAddress?: (sessionId: SessionId) => { readonly parentSessionId: SessionId; readonly childSessionId: SessionId; readonly mode: 'one-shot' | 'continuable' } | undefined
        navigationAddress?: (sessionId: SessionId) => { readonly parentSessionId: SessionId; readonly childSessionId: SessionId; readonly mode: 'one-shot' | 'continuable' } | undefined
        openSubagent?: (address: { readonly parentSessionId: SessionId; readonly childSessionId: SessionId; readonly mode: 'one-shot' | 'continuable' }) => void
      }
      const address = sessions.subagentAddress?.(id) ?? sessions.navigationAddress?.(id)
      if (address !== undefined && sessions.openSubagent !== undefined) {
        sessions.openSubagent(address)
        return
      }
      ctx.sessions.open(id)
    },
    refreshSubagents: (parentSessionId) => {
      const refresh = (ctx.sessions as typeof ctx.sessions & {
        refreshSubagents?: (id: SessionId) => Promise<void>
      }).refreshSubagents
      if (refresh === undefined) return
      void refresh.call(ctx.sessions, parentSessionId).catch((error: unknown) => {
        console.warn('voice subagent catalog refresh failed:', error)
      })
    },
    setSubagentCatalogOpen: (parentSessionId, open) => {
      const setOpen = (ctx.sessions as typeof ctx.sessions & {
        setSubagentCatalogOpen?: (id: SessionId, open: boolean) => void
      }).setSubagentCatalogOpen
      setOpen?.call(ctx.sessions, parentSessionId, open)
    },
  })
  const utteranceInjected = (): VoiceUtteranceInjected => ({ hooks: { voice: controller } })
  const delegationInjected = (): VoiceDelegationInjected => ({
    hooks: { voice: controller },
    recordTaskActivity: (id, at) => { history.recordTaskActivity(id, at) },
    openSession: (id) => {
      if (isEffectivelyArchivedInContext(ctx, id)) return
      const sessions = ctx.sessions as typeof ctx.sessions & {
        subagentAddress?: (sessionId: SessionId) => { readonly parentSessionId: SessionId; readonly childSessionId: SessionId; readonly mode: 'one-shot' | 'continuable' } | undefined
        navigationAddress?: (sessionId: SessionId) => { readonly parentSessionId: SessionId; readonly childSessionId: SessionId; readonly mode: 'one-shot' | 'continuable' } | undefined
        openSubagent?: (address: { readonly parentSessionId: SessionId; readonly childSessionId: SessionId; readonly mode: 'one-shot' | 'continuable' }) => void
      }
      const address = sessions.subagentAddress?.(id) ?? sessions.navigationAddress?.(id)
      if (address !== undefined && sessions.openSubagent !== undefined) {
        sessions.openSubagent(address)
        return
      }
      ctx.sessions.open(id)
    },
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

/** Archive-manager archives one requested ID; Voice treats that state as
 * inherited by every descendant without mutating the third-party archive set. */
function isEffectivelyArchivedInContext(ctx: ClientContext, sessionId: SessionId): boolean {
  const workspaces = (ctx as ClientContext & {
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

function ensureChildSession(ctx: ClientContext, id: SessionId): SessionFace | undefined {
  const sessions = ctx.sessions as typeof ctx.sessions & {
    navigationAddress?: (sessionId: SessionId) => { readonly parentSessionId: SessionId; readonly childSessionId: SessionId; readonly mode: 'one-shot' | 'continuable' } | undefined
    openSubagent?: (address: { readonly parentSessionId: SessionId; readonly childSessionId: SessionId; readonly mode: 'one-shot' | 'continuable' }) => void
  }
  const address = sessions.navigationAddress?.(id)
  if (address !== undefined) sessions.openSubagent?.(address)
  return ctx.sessions.binding(id)?.session
}
