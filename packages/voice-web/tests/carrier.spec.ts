import { once } from 'node:events'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import VoiceRuntime, {
  VoiceResponseId,
  VoiceUtteranceId,
  type VoiceProvider,
  type VoiceProviderEvent,
  type VoiceProviderSession,
} from '@lgquan/dsh-voice'
import WebSocket, { WebSocketServer } from 'ws'
import { apply, type Config } from '../src/index.ts'

interface ProviderConnection {
  readonly emit: (event: VoiceProviderEvent) => void
  readonly session: VoiceProviderSession
  readonly spies: {
    readonly appendAudio: ReturnType<typeof vi.fn>
    readonly commitAudio: ReturnType<typeof vi.fn>
    readonly interruptResponse: ReturnType<typeof vi.fn>
    readonly playbackEnded: ReturnType<typeof vi.fn>
    readonly close: ReturnType<typeof vi.fn>
  }
}

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

function providerConnection(emit: (event: VoiceProviderEvent) => void): ProviderConnection {
  const spies = {
    appendAudio: vi.fn(),
    commitAudio: vi.fn(),
    interruptResponse: vi.fn(),
    playbackEnded: vi.fn(),
    close: vi.fn(() => Promise.resolve()),
  }
  return {
    emit,
    spies,
    session: {
      audio: { inputSampleRate: 16_000, outputSampleRate: 24_000, format: 'pcm_s16le' },
      interactionMode: 'frontend-agent',
      appendAudio: spies.appendAudio,
      commitAudio: spies.commitAudio,
      interruptResponse: spies.interruptResponse,
      playbackEnded: spies.playbackEnded,
      appendTaskObservation: vi.fn(),
      requestResponse: vi.fn(),
      completeTaskCommand: vi.fn(),
      close: spies.close,
    },
  }
}

async function loadCarrier(
  config: Config = {},
  connect?: VoiceProvider['connect'],
): Promise<{
  readonly connect: ReturnType<typeof vi.fn>
  readonly connections: ProviderConnection[]
  readonly url: string
}> {
  context = new Context()
  await context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await context.plugin(VoiceRuntime, { provider: 'test', reconnectGraceMs: 1_000 })
  const connections: ProviderConnection[] = []
  const defaultConnect: VoiceProvider['connect'] = (input) => {
    const connection = providerConnection(input.emit)
    connections.push(connection)
    return Promise.resolve(connection.session)
  }
  const connectSpy = vi.fn(connect ?? defaultConnect)
  context.voice.registerProvider({ id: 'test', available: () => true, connect: connectSpy })
  apply(context, config)
  return {
    connect: connectSpy,
    connections,
    url: `ws://127.0.0.1:${String(context.webServer.port)}/voice?sessionId=voice-source`,
  }
}

async function readJson(socket: WebSocket): Promise<Record<string, unknown>> {
  const [data] = await once(socket, 'message') as [WebSocket.RawData]
  return JSON.parse(Buffer.from(data as ArrayBuffer).toString('utf8')) as Record<string, unknown>
}

async function openVoice(url: string, options?: WebSocket.ClientOptions): Promise<{
  readonly ready: Record<string, unknown>
  readonly socket: WebSocket
}> {
  const socket = new WebSocket(url, options)
  return { socket, ready: await readJson(socket) }
}

async function closeInfo(socket: WebSocket): Promise<{ readonly code: number; readonly reason: string }> {
  const [code, reason] = await once(socket, 'close') as [number, Buffer]
  return { code, reason: reason.toString('utf8') }
}

function captureNextServerSocket(): {
  readonly restore: () => void
  readonly socket: Promise<WebSocket>
} {
  const captured = Promise.withResolvers<WebSocket>()
  // oxlint-disable-next-line typescript/unbound-method -- invoked below with the owning server
  const handleUpgrade = WebSocketServer.prototype.handleUpgrade
  const spy = vi.spyOn(WebSocketServer.prototype, 'handleUpgrade').mockImplementation(function (
    this: WebSocketServer,
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (client: WebSocket, request: IncomingMessage) => void,
  ): void {
    handleUpgrade.call(this, request, socket, head, (client: WebSocket, upgradedRequest: IncomingMessage) => {
      captured.resolve(client)
      callback(client, upgradedRequest)
    })
  })
  return { restore: () => { spy.mockRestore() }, socket: captured.promise }
}

describe('voice WebSocket carrier', () => {
  it('reattaches after network loss and final-closes on explicit stop', async () => {
    const loaded = await loadCarrier()
    const first = await openVoice(loaded.url)
    const connection = loaded.connections[0] as ProviderConnection
    connection.spies.close.mockRejectedValue(new Error('provider close failed'))
    const warn = vi.spyOn((context as Context).logger, 'warn').mockImplementation(() => undefined)

    first.socket.terminate()
    await once(first.socket, 'close')
    await vi.waitFor(() => { expect(connection.spies.interruptResponse).toHaveBeenCalledOnce() })
    expect(connection.spies.close).not.toHaveBeenCalled()

    const second = await openVoice(loaded.url)
    expect(second.ready.voiceSessionId).toBe(first.ready.voiceSessionId)
    expect(loaded.connect).toHaveBeenCalledOnce()

    second.socket.send(JSON.stringify({ type: 'session.close' }))
    await once(second.socket, 'close')
    await vi.waitFor(() => { expect(connection.spies.close).toHaveBeenCalledOnce() })
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'provider close failed' }))
  })

  it('carries PCM, control frames, JSON events, and binary provider audio', async () => {
    const loaded = await loadCarrier()
    const { socket } = await openVoice(loaded.url)
    const connection = loaded.connections[0] as ProviderConnection
    const commands: VoiceProviderEvent[] = []
    ;(context as Context).on('voice/session-event', (_session, event) => {
      if (event.type === 'task.command') commands.push(event)
    })

    socket.send(Buffer.from([1, 2, 3]), { binary: true })
    socket.send(JSON.stringify({ type: 'audio.commit' }))
    socket.send(JSON.stringify({ type: 'response.interrupt' }))
    socket.send(JSON.stringify({ type: 'playback.ended' }))
    socket.send(JSON.stringify({ type: 'task.cancel', taskId: 'task-from-browser' }))
    await vi.waitFor(() => {
      expect(connection.spies.appendAudio).toHaveBeenCalledWith(Buffer.from([1, 2, 3]))
      expect(connection.spies.commitAudio).toHaveBeenCalledOnce()
      expect(connection.spies.interruptResponse).toHaveBeenCalledOnce()
      expect(connection.spies.playbackEnded).toHaveBeenCalledOnce()
      expect(commands).toEqual([expect.objectContaining({
        type: 'task.command',
        call: expect.objectContaining({ command: { type: 'cancel_task', taskId: 'task-from-browser' } }),
      })])
    })

    const transcription = readJson(socket)
    connection.emit({
      type: 'transcription.completed',
      utteranceId: VoiceUtteranceId('user-1'),
      text: 'hello',
    })
    expect(await transcription).toMatchObject({ type: 'transcription.completed', text: 'hello' })

    const audio = once(socket, 'message')
    connection.emit({
      type: 'output_audio.delta',
      responseId: VoiceResponseId('response-1'),
      audio: new Uint8Array([4, 5, 6]),
    })
    const [data, isBinary] = await audio as [WebSocket.RawData, boolean]
    expect(isBinary).toBe(true)
    expect(Buffer.from(data as ArrayBuffer)).toEqual(Buffer.from([4, 5, 6]))

    const closed = closeInfo(socket)
    socket.send(JSON.stringify({ type: 'unknown' }))
    expect(await closed).toEqual({ code: 1008, reason: 'unknown control frame' })
    await vi.waitFor(() => { expect(connection.spies.close).toHaveBeenCalledOnce() })
  })

  it('rejects missing sessions and every malformed control representation', async () => {
    const loaded = await loadCarrier()
    const missing = new WebSocket(loaded.url.replace('?sessionId=voice-source', ''))
    expect(await closeInfo(missing)).toEqual({ code: 1008, reason: 'sessionId is required' })
    expect(loaded.connect).not.toHaveBeenCalled()

    for (const frame of ['{', 'null', '"primitive"']) {
      const { socket } = await openVoice(loaded.url)
      const connection = loaded.connections.at(-1) as ProviderConnection
      const warn = vi.spyOn((context as Context).logger, 'warn').mockImplementation(() => undefined)
      connection.spies.close.mockRejectedValue('close value')
      const closed = closeInfo(socket)
      socket.send(frame)
      expect(await closed).toEqual({ code: 1008, reason: 'invalid control frame' })
      await vi.waitFor(() => { expect(connection.spies.close).toHaveBeenCalledOnce() })
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'close value' }))
      warn.mockRestore()
    }
  })

  it('final-closes the provider when ws rejects an oversized frame', async () => {
    const loaded = await loadCarrier({ maxAudioFrameBytes: 4 })
    const { socket } = await openVoice(loaded.url)
    const connection = loaded.connections[0] as ProviderConnection
    const closed = closeInfo(socket)

    socket.send(Buffer.alloc(5), { binary: true })

    expect((await closed).code).toBe(1009)
    await vi.waitFor(() => { expect(connection.spies.close).toHaveBeenCalledOnce() })
  })

  it('forwards a provider terminal event and closes the browser transport', async () => {
    const loaded = await loadCarrier()
    const { socket } = await openVoice(loaded.url)
    const connection = loaded.connections[0] as ProviderConnection
    const terminal = readJson(socket)
    const closed = closeInfo(socket)

    connection.emit({ type: 'closed', reason: 'provider ended' })

    expect(await terminal).toEqual({ type: 'closed', reason: 'provider ended' })
    expect(await closed).toEqual({ code: 1011, reason: 'voice provider closed' })
    await vi.waitFor(() => { expect(connection.spies.close).toHaveBeenCalledOnce() })
  })

  it('validates configured authorities and enforces the upgrade trust fence', async () => {
    context = new Context()
    await context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await context.plugin(VoiceRuntime, { provider: 'test' })
    expect(() => { apply(context as Context, { trustedHosts: ['voice.test/path'] }) })
      .toThrow('is not a bare host[:port] authority')
    await context.fiber.dispose()
    context = undefined

    const loaded = await loadCarrier({ trustedHosts: ['voice.test'] })
    const forbidden = new WebSocket(loaded.url, { headers: { Host: 'evil.test' } })
    const [, response] = await once(forbidden, 'unexpected-response') as [unknown, IncomingMessage]
    const ended = once(response, 'end')
    response.resume()
    await ended
    expect(response.statusCode).toBe(403)
    forbidden.on('error', () => undefined)
    forbidden.terminate()

    const trusted = await openVoice(loaded.url, { headers: { Host: 'voice.test' } })
    trusted.socket.send(JSON.stringify({ type: 'session.close' }))
    await once(trusted.socket, 'close')
  })

  it('reports provider setup failure before closing the socket', async () => {
    const loaded = await loadCarrier({}, () => Promise.reject(new Error('connect failed')))
    const socket = new WebSocket(loaded.url)
    const message = readJson(socket)
    const closed = closeInfo(socket)

    expect(await message).toEqual({ type: 'error', message: 'Error: connect failed' })
    expect(await closed).toEqual({ code: 1011, reason: 'voice setup failed' })
  })

  it('closes a provider that finishes opening after its browser disconnected', async () => {
    const capture = captureNextServerSocket()
    try {
      const deferred = Promise.withResolvers<VoiceProviderSession>()
      const loaded = await loadCarrier({}, () => deferred.promise)
      const connection = providerConnection(() => undefined)
      const lifecycle: string[] = []
      const activeContext = context as Context
      activeContext.on('voice/session-opened', () => { lifecycle.push('opened') })
      activeContext.on('voice/session-closed', () => { lifecycle.push('closed') })
      const socket = new WebSocket(loaded.url)
      const serverSocket = await capture.socket
      await vi.waitFor(() => { expect(loaded.connect).toHaveBeenCalledOnce() })
      const closed = Promise.all([once(socket, 'close'), once(serverSocket, 'close')])
      serverSocket.terminate()
      await closed

      deferred.resolve(connection.session)
      await vi.waitFor(() => { expect(lifecycle).toEqual(['opened', 'closed']) })
      expect(connection.spies.close).toHaveBeenCalledOnce()
    } finally {
      capture.restore()
    }
  })

  it('contains a setup rejection after the browser has already disconnected', async () => {
    const capture = captureNextServerSocket()
    try {
      const deferred = Promise.withResolvers<VoiceProviderSession>()
      const loaded = await loadCarrier({}, () => deferred.promise)
      const socket = new WebSocket(loaded.url)
      const serverSocket = await capture.socket
      await vi.waitFor(() => { expect(loaded.connect).toHaveBeenCalledOnce() })
      const closed = Promise.all([once(socket, 'close'), once(serverSocket, 'close')])
      serverSocket.terminate()
      await closed

      deferred.reject('connect value')
      await new Promise<void>((resolve) => { setImmediate(resolve) })
    } finally {
      capture.restore()
    }
  })

  it('terminates active clients when the carrier is disposed', async () => {
    const loaded = await loadCarrier()
    const { socket } = await openVoice(loaded.url)
    const closed = once(socket, 'close')
    const activeContext = context as Context
    context = undefined

    await activeContext.fiber.dispose()
    await closed
  })

  it('contains a WebSocketServer close callback failure during disposal', async () => {
    const close = vi.spyOn(WebSocketServer.prototype, 'close').mockImplementation((callback) => {
      callback?.(new Error('server close failed'))
    })
    try {
      await loadCarrier()
      const activeContext = context as Context
      context = undefined
      await activeContext.fiber.dispose()
      expect(close).toHaveBeenCalledOnce()
    } finally {
      close.mockRestore()
    }
  })
})
