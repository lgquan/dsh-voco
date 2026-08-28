/** Dedicated browser WebSocket carrier for realtime voice audio and events. @module @lgquan/dsh-voice-web */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { assertTrustedAuthority, isTrustedApiRequest } from './api-request-trust.ts'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { SessionId } from '@deepseek-ai/dsh-session'
import { VoiceCommandCallId, VoiceTaskId, type VoiceEvent } from '@lgquan/dsh-voice'
import WebSocket, { WebSocketServer } from 'ws'

export const name = 'voice-web'
export const inject = ['voice', 'webServer']
/** Dedicated browser voice upgrade pathname. */
export const VOICE_PATH = '/voice'

/** Browser carrier configuration. */
export interface Config {
  /** Extra host authorities trusted for the /voice upgrade, beyond the Web surface defaults. */
  readonly trustedHosts?: string[]
  /** Maximum accepted audio frame size in bytes. */
  readonly maxAudioFrameBytes?: number
}
export const Config: z<Config> = z.object({
  trustedHosts: z.array(String).default([]),
  maxAudioFrameBytes: z.natural().min(1).default(64 * 1024),
})

/** Register the `/voice` upgrade route. @param ctx - web and voice context. @param config - trust and frame limits. */
export function apply(ctx: Context, config: Config = {}): void {
  const trustedHosts = config.trustedHosts ?? []
  for (const authority of trustedHosts) assertTrustedAuthority(authority)
  const maxAudioFrameBytes = config.maxAudioFrameBytes ?? 64 * 1024
  const server = new WebSocketServer({ noServer: true, maxPayload: maxAudioFrameBytes })

  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: VOICE_PATH,
    handler: (request, socket, head) => {
      if (!isTrustedApiRequest(request, trustedHosts)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 9\r\n\r\nforbidden')
        return
      }
      server.handleUpgrade(request, socket, head, (websocket) => {
        /* v8 ignore next -- node:http always sets url on server upgrade requests */
        void attach(ctx, websocket, request.url ?? VOICE_PATH)
      })
    },
  }), 'voice-web route')

  ctx.effect(() => async () => {
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    })
  }, 'voice-web sockets')
}

async function attach(ctx: Context, socket: WebSocket, rawUrl: string): Promise<void> {
  const voice = ctx.voice
  type VoiceId = Awaited<ReturnType<typeof voice.open>>['id']
  let voiceId: VoiceId | undefined
  let unsubscribe: (() => void) | undefined
  const state = { closed: false, finalClose: false }
  const finalClose = (id: VoiceId): void => {
    void voice.close(id).catch((error: unknown) => {
      ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
    })
  }
  socket.once('close', () => {
    state.closed = true
    unsubscribe?.()
    if (voiceId === undefined) return
    if (state.finalClose) finalClose(voiceId)
    else voice.detach(voiceId)
  })
  socket.on('error', (error) => {
    /* v8 ignore next -- other WebSocket errors are transport loss and retain the provider for reconnect */
    if ((error as Error & { code?: string }).code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') state.finalClose = true
  })
  try {
    const value = new URL(rawUrl, 'http://voice.local').searchParams.get('sessionId')
    if (value === null || value === '') { state.finalClose = true; socket.close(1008, 'sessionId is required'); return }
    const session = await voice.open(SessionId(value))
    voiceId = session.id
    if (state.closed) { await voice.close(session.id); return }
    unsubscribe = voice.subscribe(session.id, (event) => {
      sendEvent(socket, event)
      if (event.type === 'closed') {
        state.finalClose = true
        socket.close(1011, 'voice provider closed')
      }
    })
    socket.send(JSON.stringify({ type: 'ready', voiceSessionId: session.id, audio: session.audio, interactionMode: session.interactionMode }))
    socket.on('message', (data, isBinary) => {
      // ws server sockets keep their default `nodebuffer` binary type.
      const frame = data as Buffer
      if (isBinary) {
        voice.appendAudio(session.id, frame)
        return
      }
      let control: unknown
      const text = frame.toString('utf8')
      try { control = JSON.parse(text) } catch { state.finalClose = true; socket.close(1008, 'invalid control frame'); return }
      if (control === null || typeof control !== 'object') { state.finalClose = true; socket.close(1008, 'invalid control frame'); return }
      const type = (control as Record<string, unknown>).type
      if (type === 'audio.commit') voice.commitAudio(session.id)
      else if (type === 'response.interrupt') voice.interruptResponse(session.id)
      else if (type === 'playback.ended') voice.playbackEnded(session.id)
      else if (type === 'task.cancel') {
        const taskId = (control as Record<string, unknown>).taskId
        if (typeof taskId !== 'string' || taskId === '') {
          state.finalClose = true
          socket.close(1008, 'taskId is required')
          return
        }
        voice.submitTaskCommand(session.id, {
          id: VoiceCommandCallId(`browser:${randomUUID()}`),
          command: { type: 'cancel_task', taskId: VoiceTaskId(taskId) },
        })
      }
      else if (type === 'text.submit') {
        const submitted = (control as Record<string, unknown>).text
        if (typeof submitted !== 'string' || submitted.trim() === '') {
          state.finalClose = true
          socket.close(1008, 'text is required')
          return
        }
        voice.submitText(session.id, submitted)
      }
      else if (type === 'session.close') {
        state.finalClose = true
        unsubscribe?.()
        finalClose(session.id)
        socket.close(1000, 'voice session closed')
      } else {
        state.finalClose = true
        socket.close(1008, 'unknown control frame')
      }
    })
  } catch (error) {
    state.finalClose = true
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'error', message: String(error) }))
    socket.close(1011, 'voice setup failed')
  }
}

function sendEvent(socket: WebSocket, event: VoiceEvent): void {
  /* v8 ignore next -- the close-race guard cannot be scheduled deterministically */
  if (socket.readyState !== WebSocket.OPEN) return
  if (event.type === 'output_audio.delta') socket.send(event.audio, { binary: true })
  else socket.send(JSON.stringify(event))
}
