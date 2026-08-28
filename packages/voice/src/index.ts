/** Provider-neutral realtime voice session capability seam. @module @lgquan/dsh-voice */
import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { VoiceCommandCallId, VoiceSessionId, VoiceUtteranceId } from './types.ts'
import type {
  TaskCommandCall,
  TaskCommandResult,
  TaskObservation,
  VoiceConversationMemory,
  VoiceEvent,
  VoiceProvider,
  VoiceProviderEvent,
  VoiceProviderSession,
  VoiceResponsePolicy,
  VoiceSessionInfo,
} from './types.ts'

/** Loads bounded durable context for a fresh provider conversation. */
export type VoiceMemorySource = (agentSessionId: SessionId) => Promise<VoiceConversationMemory | undefined>

export * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { voice: VoiceRuntime }
  interface Events {
    /**
     * A provider-backed voice attachment opened or reattached for an Agent session.
     * @param session - opened session metadata.
     * @mode emit
     */
    'voice/session-opened'(session: VoiceSessionInfo): void
    /**
     * A provider-independent voice event arrived.
     * @param session - owning session metadata.
     * @param event - normalized event.
     * @mode emit
     */
    'voice/session-event'(session: VoiceSessionInfo, event: VoiceEvent): void
    /**
     * A browser voice attachment detached while its provider conversation remains live.
     * @param session - detached session metadata.
     * @mode emit
     */
    'voice/session-detached'(session: VoiceSessionInfo): void
    /**
     * A provider-backed voice session final-closed.
     * @param session - final-closed session metadata.
     * @mode emit
     */
    'voice/session-closed'(session: VoiceSessionInfo): void
  }
}

/** Voice seam configuration. */
export interface Config {
  /** Provider id to use; defaults to the sole available registered provider. */
  readonly provider?: string
  /** Maximum pending and replayable frontend command calls retained per voice session. */
  readonly maxCommandCalls?: number
  /** Milliseconds a detached browser may reconnect to the same provider conversation. */
  readonly reconnectGraceMs?: number
}

interface LiveSession {
  readonly info: VoiceSessionInfo
  readonly provider: VoiceProviderSession
  readonly listeners: Set<(event: VoiceEvent) => void>
  readonly commands: Map<VoiceCommandCallId, CommandRecord>
  attached: boolean
  detachTimer?: ReturnType<typeof setTimeout>
}

interface CommandRecord {
  readonly fingerprint: string
  result?: TaskCommandResult
}

/** Provider registry and connected-session coordinator. */
export class VoiceRuntime extends Service {
  static Config: z<Config> = z.object({
    provider: z.string(),
    maxCommandCalls: z.natural().min(1).default(256),
    reconnectGraceMs: z.natural().min(1).default(60_000),
  })
  private readonly providers = new Map<string, VoiceProvider>()
  private readonly sessions = new Map<VoiceSessionId, LiveSession>()
  private readonly memory = { source: undefined as VoiceMemorySource | undefined }
  private readonly configuredProvider: string | undefined
  private readonly maxCommandCalls: number
  private readonly reconnectGraceMs: number

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'voice')
    this.configuredProvider = config.provider
    this.maxCommandCalls = config.maxCommandCalls ?? 256
    this.reconnectGraceMs = config.reconnectGraceMs ?? 60_000
    ctx.effect(() => async () => {
      const settled = await Promise.allSettled([...this.sessions.keys()].map(id => this.close(id)))
      const failures: unknown[] = []
      for (const result of settled) {
        if (result.status === 'rejected') failures.push(result.reason as unknown)
      }
      if (failures.length > 0) throw new AggregateError(failures, 'failed to close voice provider sessions')
    }, 'voice provider sessions')
  }

  /**
   * Register one provider.
   * @param provider - provider implementation.
   * @returns disposer removing it.
   */
  registerProvider(provider: VoiceProvider): () => void {
    if (this.providers.has(provider.id)) throw new Error(`voice provider "${provider.id}" is already registered`)
    this.providers.set(provider.id, provider)
    return () => { this.providers.delete(provider.id) }
  }

  /**
   * Register the sole durable conversation-memory source.
   * @param source - loader keyed by the durable source Agent session.
   * @returns disposer removing it when still current.
   */
  registerMemorySource(source: VoiceMemorySource): () => void {
    if (this.memory.source !== undefined) throw new Error('voice conversation memory source is already registered')
    this.memory.source = source
    return () => {
      if (this.memory.source === source) this.memory.source = undefined
    }
  }

  /**
   * Open or reattach a voice transport for an Agent session.
   * @param agentSessionId - durable Agent identity.
   * @returns connected session metadata.
   */
  async open(agentSessionId: SessionId): Promise<VoiceSessionInfo> {
    const detached = [...this.sessions.values()].find(live => (
      !live.attached && live.info.agentSessionId === agentSessionId
    ))
    if (detached !== undefined) {
      clearTimeout(detached.detachTimer)
      delete detached.detachTimer
      detached.attached = true
      this.ctx.emit('voice/session-opened', detached.info)
      return detached.info
    }
    const id = VoiceSessionId(randomUUID())
    const provider = this.resolveProvider()
    const memory = await this.memory.source?.(agentSessionId)
    const holder: { live?: LiveSession } = {}
    const connected = await provider.connect({
      voiceSessionId: id,
      agentSessionId,
      ...(memory !== undefined && memory.items.length > 0 ? { memory } : {}),
      emit: (event) => {
        const live = holder.live
        if (live === undefined || this.sessions.get(id) !== live) return
        this.acceptProviderEvent(live, event)
      },
    })
    const info: VoiceSessionInfo = {
      id,
      agentSessionId,
      audio: connected.audio,
      interactionMode: connected.interactionMode,
    }
    const live: LiveSession = {
      info,
      provider: connected,
      listeners: new Set(),
      commands: new Map(),
      attached: true,
    }
    holder.live = live
    this.sessions.set(id, live)
    this.ctx.emit('voice/session-opened', info)
    return info
  }

  /**
   * Subscribe to one session's events; a failing listener is logged without starving later listeners.
   * @param id - voice session.
   * @param listener - event receiver.
   * @returns disposer.
   */
  subscribe(id: VoiceSessionId, listener: (event: VoiceEvent) => void): () => void {
    const live = this.requireAttachedSession(id)
    live.listeners.add(listener)
    return () => { live.listeners.delete(listener) }
  }

  /**
   * Forward microphone PCM.
   * @param id - voice session.
   * @param audio - PCM bytes.
   */
  appendAudio(id: VoiceSessionId, audio: Uint8Array): void { this.requireAttachedSession(id).provider.appendAudio(audio) }
  /**
   * Commit current microphone input.
   * @param id - voice session.
   */
  commitAudio(id: VoiceSessionId): void { this.requireAttachedSession(id).provider.commitAudio() }
  /**
   * Cancel current provider speech.
   * @param id - voice session.
   */
  interruptResponse(id: VoiceSessionId): void { this.requireAttachedSession(id).provider.interruptResponse() }
  /**
   * Report local playback completion.
   * @param id - voice session.
   */
  playbackEnded(id: VoiceSessionId): void { this.requireAttachedSession(id).provider.playbackEnded() }

  /**
   * Append model-independent task state.
   * @param id - voice session.
   * @param event - observation.
   */
  appendTaskObservation(id: VoiceSessionId, event: TaskObservation): void {
    const live = this.requireAttachedSession(id)
    live.provider.appendTaskObservation(event)
    this.publish(live, { type: 'task.observation', observation: event })
  }

  /** Queue one already-rewritten speech fragment for the attached provider. */
  appendSpeechText(id: VoiceSessionId, text: string): boolean {
    const provider = this.requireAttachedSession(id).provider
    if (provider.appendSpeechText === undefined) return false
    provider.appendSpeechText(text)
    return true
  }

  /** Whether the attached provider supports independent speech fragments. */
  supportsSpeechText(id: VoiceSessionId): boolean {
    return this.requireAttachedSession(id).provider.appendSpeechText !== undefined
  }

  /**
   * Ask the provider to speak pending observations.
   * @param id - voice session.
   * @param policy - response policy.
   */
  requestResponse(id: VoiceSessionId, policy: VoiceResponsePolicy): void {
    this.requireAttachedSession(id).provider.requestResponse(policy)
  }

  /**
   * Complete one admitted frontend command exactly once.
   * @param id - voice session.
   * @param callId - provider command call.
   * @param result - typed bridge result.
   */
  completeTaskCommand(id: VoiceSessionId, callId: VoiceCommandCallId, result: TaskCommandResult): void {
    const live = this.requireSession(id)
    const record = live.commands.get(callId)
    if (record === undefined) throw new Error(`voice command call "${callId}" is not pending`)
    if (record.result !== undefined) throw new Error(`voice command call "${callId}" is already completed`)
    live.provider.completeTaskCommand(callId, result)
    record.result = result
  }

  /** Submit one validated command from a non-provider frontend control. */
  submitTaskCommand(id: VoiceSessionId, call: TaskCommandCall): void {
    this.acceptTaskCommand(this.requireAttachedSession(id), call)
  }

  /** Route browser-typed text through the same transcript and task path as recognized speech. */
  submitText(id: VoiceSessionId, text: string): void {
    const value = text.trim()
    if (value === '') throw new Error('voice text submission requires non-empty text')
    const live = this.requireAttachedSession(id)
    const utteranceId = VoiceUtteranceId(`typed:${randomUUID()}`)
    live.provider.interruptResponse()
    this.publish(live, { type: 'transcription.started', utteranceId })
    this.publish(live, { type: 'transcription.completed', utteranceId, text: value })
    this.acceptTaskCommand(live, {
      id: VoiceCommandCallId(`typed:${randomUUID()}`),
      command: { type: 'route_transcription', input: value },
    })
  }

  /**
   * Detach the browser while retaining the provider conversation for bounded reconnection.
   * @param id - voice session.
   */
  detach(id: VoiceSessionId): void {
    const live = this.sessions.get(id)
    if (live === undefined || !live.attached) return
    live.attached = false
    live.listeners.clear()
    this.ctx.emit('voice/session-detached', live.info)
    try {
      live.provider.interruptResponse()
    } catch (error: unknown) {
      this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
    }
    live.detachTimer = setTimeout(() => {
      delete live.detachTimer
      void this.close(id).catch((error: unknown) => {
        this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      })
    }, this.reconnectGraceMs)
    live.detachTimer.unref()
  }

  /**
   * Final-close one provider conversation without disposing its Agent.
   * @param id - voice session.
   */
  async close(id: VoiceSessionId): Promise<void> {
    const live = this.sessions.get(id)
    if (live === undefined) return
    this.sessions.delete(id)
    if (live.detachTimer !== undefined) clearTimeout(live.detachTimer)
    live.attached = false
    live.listeners.clear()
    this.ctx.emit('voice/session-closed', live.info)
    await live.provider.close()
  }

  private publish(live: LiveSession, event: VoiceEvent): void {
    this.ctx.emit('voice/session-event', live.info, event)
    for (const listener of live.listeners) {
      try { listener(event) } catch (error: unknown) {
        this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }

  private acceptProviderEvent(live: LiveSession, event: VoiceProviderEvent): void {
    if (event.type === 'closed') {
      this.publish(live, event)
      void this.close(live.info.id).catch((error: unknown) => {
        this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      })
      return
    }
    if (!live.attached && event.type !== 'task.command') return
    if (event.type !== 'task.command') {
      this.publish(live, event)
      return
    }
    this.acceptTaskCommand(live, event.call)
  }

  private acceptTaskCommand(live: LiveSession, call: TaskCommandCall): void {
    const fingerprint = commandFingerprint(call)
    const existing = live.commands.get(call.id)
    if (existing === undefined) {
      if (live.commands.size >= this.maxCommandCalls) {
        live.provider.completeTaskCommand(call.id, {
          kind: 'rejected',
          code: 'capacity_exceeded',
          message: `voice session already tracks ${String(this.maxCommandCalls)} command calls`,
        })
        return
      }
      live.commands.set(call.id, { fingerprint })
      this.publish(live, { type: 'task.command', call })
      return
    }
    if (existing.fingerprint !== fingerprint) {
      this.publish(live, {
        type: 'error',
        message: `voice command call "${call.id}" was reused with different arguments`,
      })
      return
    }
    if (existing.result !== undefined) live.provider.completeTaskCommand(call.id, existing.result)
  }

  private requireSession(id: VoiceSessionId): LiveSession {
    const live = this.sessions.get(id)
    if (live === undefined) throw new Error(`voice session "${id}" is not open`)
    return live
  }

  private requireAttachedSession(id: VoiceSessionId): LiveSession {
    const live = this.requireSession(id)
    if (!live.attached) throw new Error(`voice session "${id}" is detached`)
    return live
  }

  private resolveProvider(): VoiceProvider {
    if (this.configuredProvider !== undefined) {
      const provider = this.providers.get(this.configuredProvider)
      if (provider === undefined) throw new Error(`configured voice provider "${this.configuredProvider}" is not registered`)
      if (!provider.available()) throw new Error(`configured voice provider "${this.configuredProvider}" is unavailable`)
      return provider
    }
    const available = [...this.providers.values()].filter(provider => provider.available())
    if (available.length !== 1) throw new Error(available.length === 0 ? 'no usable voice provider is registered' : 'multiple usable voice providers are registered; configure one explicitly')
    return available[0] as VoiceProvider
  }
}

export default VoiceRuntime

function commandFingerprint(call: TaskCommandCall): string {
  const command = call.command
  switch (command.type) {
    case 'route_transcription': return JSON.stringify([command.type, command.input])
    case 'realtime_delegation': return JSON.stringify([command.type, command.input, command.transcriptDelta])
    case 'send_task_message': return JSON.stringify([command.type, command.taskId, command.message])
    case 'cancel_task': return JSON.stringify([command.type, command.taskId])
    /* v8 ignore next -- closed-union exhaustiveness guard */
    default: return assertNever(command)
  }
}

/* v8 ignore next -- only reachable through the closed-union guard */
function assertNever(value: never): never {
  throw new Error(`unexpected task command: ${JSON.stringify(value)}`)
}
