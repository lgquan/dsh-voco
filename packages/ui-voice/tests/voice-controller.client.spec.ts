// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { resample, VoiceController, voiceUrl } from '../src/client/voice-controller.ts'

const SESSION = 'voice-session' as SessionId

class FakeSocket extends EventTarget {
  static readonly OPEN = 1
  static readonly CLOSED = 3
  readonly url: string
  readyState = 0
  binaryType = ''
  readonly sent: unknown[] = []

  constructor(url: string | URL) {
    super()
    this.url = String(url)
    sockets.push(this)
  }

  open(): void {
    this.readyState = FakeSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  ready(): void {
    this.json(readyPayload())
  }

  send(value: unknown): void { this.sent.push(value) }

  close(): void { this.readyState = FakeSocket.CLOSED }

  json(value: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }))
  }

  raw(value: string): void {
    this.dispatchEvent(new MessageEvent('message', { data: value }))
  }

  binary(value: ArrayBuffer): void {
    this.dispatchEvent(new MessageEvent('message', { data: value }))
  }
}

interface FakeSource {
  connect: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
}

interface FakeGain extends FakeSource {
  gain: { value: number }
}

class FakeBufferSource {
  buffer: { duration: number } | null = null
  onended: (() => void) | null = null
  readonly connect = vi.fn()
  readonly start = vi.fn()
  readonly stop = vi.fn()
}

class FakeAudioContext {
  readonly currentTime = 1
  readonly sampleRate = 48_000
  readonly destination = {}
  readonly audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) }
  readonly source: FakeSource = { connect: vi.fn(), disconnect: vi.fn() }
  readonly gain: FakeGain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }
  readonly sources: FakeBufferSource[] = []
  readonly resume = vi.fn().mockResolvedValue(undefined)
  readonly close = vi.fn().mockResolvedValue(undefined)

  constructor() { contexts.push(this) }

  createMediaStreamSource(): FakeSource { return this.source }
  createGain(): FakeGain { return this.gain }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    return {
      duration: length / sampleRate,
      getChannelData: () => new Float32Array(length),
    }
  }
  createBufferSource(): FakeBufferSource {
    const source = new FakeBufferSource()
    this.sources.push(source)
    return source
  }
}

class FakeWorkletNode {
  readonly port = { onmessage: null as ((event: MessageEvent<Float32Array>) => void) | null, close: vi.fn() }
  readonly connect = vi.fn()
  readonly disconnect = vi.fn()

  constructor() { worklets.push(this) }
}

const sockets: FakeSocket[] = []
const contexts: FakeAudioContext[] = []
const worklets: FakeWorkletNode[] = []
const track = { stop: vi.fn() }
const stream = { getTracks: () => [track] } as unknown as MediaStream
let frames: FrameRequestCallback[] = []
let getUserMedia: ReturnType<typeof vi.fn<() => Promise<MediaStream>>>

function readyPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'ready',
    voiceSessionId: 'provider-voice-session',
    audio: { inputSampleRate: 16_000, outputSampleRate: 24_000, format: 'pcm_s16le' },
    interactionMode: 'frontend-agent',
    ...overrides,
  }
}

beforeEach(() => {
  sockets.length = 0
  contexts.length = 0
  worklets.length = 0
  frames = []
  track.stop.mockClear()
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:voice-worklet')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  getUserMedia = vi.fn<() => Promise<MediaStream>>().mockResolvedValue(stream)
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  })
})

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function start(controller: VoiceController): Promise<FakeSocket> {
  const opening = controller.start(SESSION)
  await vi.waitFor(() => { expect(sockets).toHaveLength(1) })
  sockets[0]!.open()
  await Promise.resolve()
  sockets[0]!.ready()
  await opening
  return sockets[0]!
}

describe('VoiceController', () => {
  it('waits for a validated ready event before acquiring the microphone or starting capture', async () => {
    const controller = new VoiceController()
    const opening = controller.start(SESSION)
    await vi.waitFor(() => { expect(sockets).toHaveLength(1) })
    const socket = sockets[0]!
    socket.open()
    await Promise.resolve()
    expect(controller.getSnapshot()).toMatchObject({ state: 'connecting', sessionId: SESSION })
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(worklets).toHaveLength(0)

    socket.ready()
    await opening
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(worklets).toHaveLength(1)
    expect(controller.getSnapshot()).toMatchObject({ state: 'listening', sessionId: SESSION })
    await controller.stop()
  })

  it('resumes browser audio contexts during the user-initiated start', async () => {
    const controller = new VoiceController()
    const opening = controller.start(SESSION)
    await vi.waitFor(() => { expect(sockets).toHaveLength(1) })
    expect(contexts).toHaveLength(2)
    expect(contexts[0]!.resume).toHaveBeenCalledOnce()
    expect(contexts[1]!.resume).toHaveBeenCalledOnce()
    sockets[0]!.open()
    await Promise.resolve()
    sockets[0]!.ready()
    await opening
    await controller.stop()
  })

  it('rejects malformed, unsupported, and provider-error ready payloads before microphone access', async () => {
    const invalid: Array<readonly [unknown, string]> = [
      [null, 'expected a ready event'],
      [readyPayload({ voiceSessionId: '' }), 'has no voiceSessionId'],
      [readyPayload({ audio: undefined }), 'unsupported audio settings'],
      [readyPayload({
        audio: { inputSampleRate: 8_000, outputSampleRate: 24_000, format: 'pcm_s16le' },
      }), 'unsupported audio settings'],
      [readyPayload({
        audio: { inputSampleRate: 16_000, outputSampleRate: 16_000, format: 'pcm_s16le' },
      }), 'unsupported audio settings'],
      [readyPayload({
        audio: { inputSampleRate: 16_000, outputSampleRate: 24_000, format: 'pcm_f32le' },
      }), 'unsupported audio settings'],
      [readyPayload({ interactionMode: 'unknown' }), 'invalid interactionMode'],
      [{ type: 'error' }, 'voice setup failed before ready'],
      [{ type: 'error', message: 'provider rejected setup' }, 'provider rejected setup'],
    ]
    for (const [value, message] of invalid) {
      const controller = new VoiceController()
      const expectedSockets = sockets.length + 1
      const opening = controller.start(SESSION)
      await vi.waitFor(() => { expect(sockets).toHaveLength(expectedSockets) })
      const socket = sockets.at(-1)!
      socket.open()
      await Promise.resolve()
      socket.json(value)
      await expect(opening).rejects.toThrow(message)
      expect(controller.getSnapshot().state).toBe('error')
      expect(socket.readyState).toBe(FakeSocket.CLOSED)
    }

    const controller = new VoiceController()
    const expectedSockets = sockets.length + 1
    const opening = controller.start(SESSION)
    await vi.waitFor(() => { expect(sockets).toHaveLength(expectedSockets) })
    const socket = sockets.at(-1)!
    socket.open()
    await Promise.resolve()
    socket.raw('{')
    await expect(opening).rejects.toThrow()
    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it('settles setup when the open socket errors, closes, or stops before ready', async () => {
    for (const [event, message] of [
      ['error', 'failed before ready'],
      ['close', 'opening aborted'],
    ] as const) {
      const controller = new VoiceController()
      const expectedSockets = sockets.length + 1
      const opening = controller.start(SESSION)
      await vi.waitFor(() => { expect(sockets).toHaveLength(expectedSockets) })
      const socket = sockets.at(-1)!
      socket.open()
      await Promise.resolve()
      socket.dispatchEvent(new Event(event))
      await expect(opening).rejects.toThrow(message)
      await vi.waitFor(() => { expect(contexts.at(-1)?.close).toHaveBeenCalled() })
    }

    const controller = new VoiceController()
    const expectedSockets = sockets.length + 1
    const opening = controller.start(SESSION)
    await vi.waitFor(() => { expect(sockets).toHaveLength(expectedSockets) })
    const socket = sockets.at(-1)!
    socket.open()
    await Promise.resolve()
    await controller.stop()
    await expect(opening).resolves.toBeUndefined()
    expect(controller.getSnapshot().state).toBe('off')
    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it('settles stop during pending microphone and AudioWorklet setup', async () => {
    let resolveMedia: ((value: typeof stream) => void) | undefined
    getUserMedia.mockReturnValueOnce(new Promise((resolve) => { resolveMedia = resolve }))
    const mediaController = new VoiceController()
    const mediaOpening = mediaController.start(SESSION)
    await vi.waitFor(() => { expect(sockets).toHaveLength(1) })
    sockets[0]!.open()
    await Promise.resolve()
    sockets[0]!.ready()
    await vi.waitFor(() => { expect(getUserMedia).toHaveBeenCalledTimes(1) })
    await mediaController.stop()
    await expect(mediaOpening).resolves.toBeUndefined()
    resolveMedia?.(stream)
    await vi.waitFor(() => { expect(track.stop).toHaveBeenCalledTimes(1) })

    let resolveModule: (() => void) | undefined
    const moduleController = new VoiceController()
    const moduleOpening = moduleController.start(SESSION)
    await vi.waitFor(() => { expect(sockets).toHaveLength(2) })
    contexts[2]!.audioWorklet.addModule.mockReturnValueOnce(new Promise<void>((resolve) => {
      resolveModule = resolve
    }))
    sockets[1]!.open()
    await Promise.resolve()
    sockets[1]!.ready()
    await vi.waitFor(() => { expect(contexts[2]!.audioWorklet.addModule).toHaveBeenCalled() })
    await moduleController.stop()
    await expect(moduleOpening).resolves.toBeUndefined()
    resolveModule?.()
    expect(track.stop).toHaveBeenCalledTimes(2)
  })

  it('aborts pending microphone setup when the ready socket closes unexpectedly', async () => {
    let resolveMedia: ((value: typeof stream) => void) | undefined
    getUserMedia.mockReturnValueOnce(new Promise((resolve) => { resolveMedia = resolve }))
    const controller = new VoiceController()
    const opening = controller.start(SESSION)
    await vi.waitFor(() => { expect(sockets).toHaveLength(1) })
    sockets[0]!.open()
    await Promise.resolve()
    sockets[0]!.ready()
    await vi.waitFor(() => { expect(getUserMedia).toHaveBeenCalledTimes(1) })
    sockets[0]!.dispatchEvent(new Event('close'))
    await expect(opening).rejects.toThrow('voice connection opening aborted')
    expect(controller.getSnapshot().state).toBe('error')
    resolveMedia?.(stream)
    await vi.waitFor(() => { expect(track.stop).toHaveBeenCalledTimes(1) })
    expect(contexts.every(context => context.close.mock.calls.length === 1)).toBe(true)
  })

  it('releases setup resources when microphone or AudioWorklet initialization fails', async () => {
    getUserMedia.mockRejectedValueOnce('microphone failed')
    const mediaController = new VoiceController()
    const mediaOpening = mediaController.start(SESSION)
    await vi.waitFor(() => { expect(sockets).toHaveLength(1) })
    sockets[0]!.open()
    await Promise.resolve()
    sockets[0]!.ready()
    await expect(mediaOpening).rejects.toThrow('microphone failed')
    expect(track.stop).not.toHaveBeenCalled()

    const moduleController = new VoiceController()
    const moduleOpening = moduleController.start(SESSION)
    await vi.waitFor(() => { expect(sockets).toHaveLength(2) })
    contexts[2]!.audioWorklet.addModule.mockRejectedValueOnce(new Error('worklet failed'))
    sockets[1]!.open()
    await Promise.resolve()
    sockets[1]!.ready()
    await expect(moduleOpening).rejects.toThrow('worklet failed')
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(contexts.every(context => context.close.mock.calls.length === 1)).toBe(true)
  })

  it('contains ownership changes during construction and the final capture connection', async () => {
    const constructingController = new VoiceController()
    class StoppingSocket extends FakeSocket {
      constructor(url: string | URL) {
        super(url)
        void constructingController.stop()
      }
    }
    vi.stubGlobal('WebSocket', StoppingSocket)
    await expect(constructingController.start(SESSION)).resolves.toBeUndefined()
    expect(constructingController.getSnapshot().state).toBe('off')
    expect(contexts.every(context => context.close.mock.calls.length === 1)).toBe(true)

    vi.stubGlobal('WebSocket', FakeSocket)
    const connectingController = new VoiceController()
    const contextOffset = contexts.length
    const socketOffset = sockets.length
    const connecting = connectingController.start(SESSION)
    await vi.waitFor(() => { expect(sockets).toHaveLength(socketOffset + 1) })
    contexts[contextOffset]!.gain.connect.mockImplementationOnce(() => {
      void connectingController.stop()
    })
    sockets[socketOffset]!.open()
    await Promise.resolve()
    sockets[socketOffset]!.ready()
    await expect(connecting).resolves.toBeUndefined()
    expect(connectingController.getSnapshot().state).toBe('off')
  })

  it('contains aborts between open, ready, microphone, worklet, and capture setup phases', async () => {
    const beforeReady = new VoiceController()
    const beforeReadyOpening = beforeReady.start(SESSION)
    await vi.waitFor(() => { expect(sockets).toHaveLength(1) })
    sockets[0]!.open()
    const beforeReadyStop = beforeReady.stop()
    await Promise.all([beforeReadyOpening, beforeReadyStop])
    expect(beforeReady.getSnapshot().state).toBe('off')

    const closedBeforeReady = new VoiceController()
    const closedOpening = closedBeforeReady.start(SESSION)
    await vi.waitFor(() => { expect(sockets).toHaveLength(2) })
    sockets[1]!.open()
    sockets[1]!.close()
    await expect(closedOpening).rejects.toThrow('closed before ready')

    const afterReady = new VoiceController()
    const afterReadyOpening = afterReady.start(SESSION)
    await vi.waitFor(() => { expect(sockets).toHaveLength(3) })
    sockets[2]!.open()
    await Promise.resolve()
    sockets[2]!.ready()
    const afterReadyStop = afterReady.stop()
    await Promise.all([afterReadyOpening, afterReadyStop])
    expect(getUserMedia).not.toHaveBeenCalled()

    const afterMedia = new VoiceController()
    getUserMedia.mockImplementationOnce(() => {
      const request = {
        then(resolve: (value: typeof stream) => void): void {
          resolve(stream)
          void afterMedia.stop()
        },
      }
      return request as unknown as Promise<MediaStream>
    })
    const afterMediaOpening = afterMedia.start(SESSION)
    await vi.waitFor(() => { expect(sockets).toHaveLength(4) })
    sockets[3]!.open()
    await Promise.resolve()
    sockets[3]!.ready()
    await expect(afterMediaOpening).resolves.toBeUndefined()
    expect(track.stop).toHaveBeenCalledTimes(1)

    const beforeWorkletWait = new VoiceController()
    const beforeWorkletOpening = beforeWorkletWait.start(SESSION)
    await vi.waitFor(() => { expect(sockets).toHaveLength(5) })
    contexts[8]!.audioWorklet.addModule.mockImplementationOnce(() => {
      void beforeWorkletWait.stop()
      return Promise.resolve()
    })
    sockets[4]!.open()
    await Promise.resolve()
    sockets[4]!.ready()
    await expect(beforeWorkletOpening).resolves.toBeUndefined()
    expect(track.stop).toHaveBeenCalledTimes(2)

    const afterWorklet = new VoiceController()
    const afterWorkletOpening = afterWorklet.start(SESSION)
    await vi.waitFor(() => { expect(sockets).toHaveLength(6) })
    const operation = {
      then(resolve: () => void): void {
        resolve()
        void afterWorklet.stop()
      },
    }
    contexts[10]!.audioWorklet.addModule.mockReturnValueOnce(operation)
    sockets[5]!.open()
    await Promise.resolve()
    sockets[5]!.ready()
    await expect(afterWorkletOpening).resolves.toBeUndefined()
    expect(track.stop).toHaveBeenCalledTimes(3)
  })

  it('contains synchronous microphone failures and late rejected setup operations', async () => {
    getUserMedia.mockImplementationOnce(() => { throw new Error('synchronous microphone failure') })
    const synchronous = new VoiceController()
    const synchronousOpening = synchronous.start(SESSION)
    await vi.waitFor(() => { expect(sockets).toHaveLength(1) })
    sockets[0]!.open()
    await Promise.resolve()
    sockets[0]!.ready()
    await expect(synchronousOpening).rejects.toThrow('synchronous microphone failure')

    let rejectMedia: ((cause: unknown) => void) | undefined
    getUserMedia.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectMedia = reject }))
    const media = new VoiceController()
    const mediaOpening = media.start(SESSION)
    await vi.waitFor(() => { expect(sockets).toHaveLength(2) })
    sockets[1]!.open()
    await Promise.resolve()
    sockets[1]!.ready()
    await vi.waitFor(() => { expect(getUserMedia).toHaveBeenCalledTimes(2) })
    await media.stop()
    await expect(mediaOpening).resolves.toBeUndefined()
    rejectMedia?.(new Error('late media rejection'))

    let rejectModule: ((cause: unknown) => void) | undefined
    const worklet = new VoiceController()
    const workletOpening = worklet.start(SESSION)
    await vi.waitFor(() => { expect(sockets).toHaveLength(3) })
    contexts[4]!.audioWorklet.addModule.mockReturnValueOnce(new Promise((_resolve, reject) => {
      rejectModule = reject
    }))
    sockets[2]!.open()
    await Promise.resolve()
    sockets[2]!.ready()
    await vi.waitFor(() => { expect(contexts[4]!.audioWorklet.addModule).toHaveBeenCalled() })
    await worklet.stop()
    await expect(workletOpening).resolves.toBeUndefined()
    rejectModule?.(new Error('late worklet rejection'))
    await Promise.resolve()
  })

  it('rejects binary data as the initial ready payload', async () => {
    const controller = new VoiceController()
    const opening = controller.start(SESSION)
    await vi.waitFor(() => { expect(sockets).toHaveLength(1) })
    sockets[0]!.open()
    await Promise.resolve()
    sockets[0]!.binary(new ArrayBuffer(0))
    await expect(opening).rejects.toThrow('expected a ready event')
  })

  it('keeps live ASR/TTS text, playback, and capture under one root owner', async () => {
    const controller = new VoiceController()
    const socket = await start(controller)
    expect(controller.getSnapshot()).toMatchObject({ state: 'listening', sessionId: SESSION })
    expect(socket.url).toContain('sessionId=voice-session')

    const notified = vi.fn()
    const dispose = controller.subscribe(notified)
    const noisy = controller.subscribe(() => { throw new Error('listener') })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    socket.json({ type: 'transcription.started', utteranceId: 'user-1' })
    socket.json({ type: 'transcription.started' })
    socket.json({ type: 'transcription.updated', utteranceId: 'user-1', text: '你' })
    socket.json({ type: 'transcription.updated', utteranceId: 'user-1', text: '你好' })
    expect(frames).toHaveLength(1)
    frames.shift()!(0)
    expect(controller.getSnapshot().textById['user-1']?.text).toBe('你好')
    socket.json({ type: 'transcription.completed', utteranceId: 'user-1', text: '你好。' })
    socket.json({ type: 'transcription.completed', utteranceId: 'user-1', text: '你好。' })
    socket.json({ type: 'transcription.updated', utteranceId: 'user-1', text: '' })

    socket.json({ type: 'output_text.started', utteranceId: 'assistant-1', responseId: 'response-1' })
    socket.json({ type: 'output_text.delta', utteranceId: 'assistant-1', responseId: 'response-1', text: '完成' })
    frames.shift()!(0)
    socket.json({
      type: 'output_text.done', utteranceId: 'assistant-1', responseId: 'response-1', text: '已经完成',
    })
    socket.json({ type: 'output_text.done', utteranceId: 'assistant-1', responseId: 'response-1', text: '' })
    socket.json({ type: 'output_text.delta', utteranceId: 'assistant-2', responseId: 'response-2', text: '新' })
    socket.json({ type: 'output_text.done', utteranceId: 'assistant-2', responseId: 'response-2', text: '新回复' })
    expect(controller.getSnapshot().textById['assistant-1']?.text).toBe('已经完成')

    socket.binary(new Int16Array([1, -1]).buffer)
    expect(controller.getSnapshot().state).toBe('speaking')
    socket.json({ type: 'output_audio.done', responseId: 'response-1' })
    contexts[1]!.sources[0]!.onended?.()
    expect(socket.sent).toContain(JSON.stringify({ type: 'playback.ended' }))
    expect(controller.getSnapshot().state).toBe('listening')

    const samples = new Float32Array(9_600).fill(.5)
    worklets[0]!.port.onmessage?.(new MessageEvent('message', { data: samples }))
    expect(socket.sent.some(value => value instanceof ArrayBuffer)).toBe(true)
    expect(notified).toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalledWith('voice snapshot listener failed:', expect.any(Error))

    socket.raw('{')
    socket.json(null)
    socket.json('not-an-event')
    socket.json({ type: 'unknown' })

    noisy()
    dispose()
    await controller.stop()
    expect(socket.sent).toContain(JSON.stringify({ type: 'session.close' }))
    expect(controller.getSnapshot()).toEqual({ state: 'off', textById: {} })
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(contexts.every(context => context.close.mock.calls.length === 1)).toBe(true)
  })

  it('stops queued audio on barge-in and reports unexpected close and provider errors', async () => {
    const controller = new VoiceController()
    const socket = await start(controller)
    socket.binary(new Int16Array([1]).buffer)
    const source = contexts[1]!.sources[0]!
    source.stop.mockImplementationOnce(() => { throw new Error('already stopped') })
    socket.json({ type: 'transcription.started', utteranceId: 'user-1' })
    expect(source.stop).toHaveBeenCalledTimes(1)
    socket.json({ type: 'output_audio.started', responseId: 'response-2' })
    expect(controller.getSnapshot().state).toBe('speaking')
    socket.json({ type: 'response.interrupted', responseId: 'response-2' })
    expect(controller.getSnapshot().state).toBe('listening')
    socket.json({ type: 'error', message: 'provider failed' })
    expect(controller.getSnapshot().state).toBe('error')
    socket.dispatchEvent(new Event('close'))
    expect(controller.getSnapshot().state).toBe('error')
    await vi.waitFor(() => { expect(track.stop).toHaveBeenCalledTimes(1) })
    expect(socket.sent).toContain(JSON.stringify({ type: 'session.close' }))
    await controller.stop()
  })

  it('cleans resources when connection establishment fails', async () => {
    const controller = new VoiceController()
    const opening = controller.start(SESSION)
    await vi.waitFor(() => { expect(sockets).toHaveLength(1) })
    sockets[0]!.dispatchEvent(new Event('error'))
    await expect(opening).rejects.toThrow('voice websocket failed')
    expect(controller.getSnapshot().state).toBe('error')
    expect(track.stop).not.toHaveBeenCalled()
    expect(contexts.every(context => context.close.mock.calls.length === 1)).toBe(true)

    await controller.stop()
  })

  it('retries the active Session while cancelling a pending text frame', async () => {
    const controller = new VoiceController()
    const first = await start(controller)
    first.json({ type: 'output_text.delta', utteranceId: 'assistant-1', text: '待刷新' })
    expect(frames).toHaveLength(1)
    const retrying = controller.retry()
    await vi.waitFor(() => { expect(sockets).toHaveLength(2) })
    sockets[1]!.open()
    await Promise.resolve()
    sockets[1]!.ready()
    await retrying
    expect(cancelAnimationFrame).toHaveBeenCalled()
    expect(controller.getSnapshot()).toMatchObject({ state: 'listening', sessionId: SESSION })

    const captureSocket = sockets[1]!
    captureSocket.readyState = 0
    worklets[1]!.port.onmessage?.(new MessageEvent('message', { data: new Float32Array(9_600) }))
    expect(captureSocket.sent).toHaveLength(0)
    await controller.stop()
  })

  it('closes a transport that finishes opening after stop and ignores its stale success', async () => {
    const controller = new VoiceController()
    const opening = controller.start(SESSION)
    await vi.waitFor(() => { expect(sockets).toHaveLength(1) })
    await controller.stop()
    await opening
    expect(controller.getSnapshot().state).toBe('off')
    expect(track.stop).not.toHaveBeenCalled()
    expect(sockets[0]!.readyState).toBe(FakeSocket.CLOSED)
  })

  it('abandons start while an earlier transport teardown is pending', async () => {
    const controller = new VoiceController()
    let resolveClose: (() => void) | undefined
    const close = vi.fn(() => new Promise<void>((resolve) => { resolveClose = resolve }))
    ;(controller as unknown as { transport: { close(): Promise<void> } }).transport = { close }
    const opening = controller.start(SESSION)
    await vi.waitFor(() => { expect(close).toHaveBeenCalledTimes(1) })
    const stopping = controller.stop()
    resolveClose?.()
    await Promise.all([opening, stopping])
    expect(sockets).toHaveLength(0)
    expect(controller.getSnapshot().state).toBe('off')
  })

  it('does not turn a stopped connection failure back into a visible error', async () => {
    const controller = new VoiceController()
    const opening = controller.start(SESSION)
    await vi.waitFor(() => { expect(sockets).toHaveLength(1) })
    await controller.stop()
    sockets[0]!.dispatchEvent(new Event('error'))
    await expect(opening).resolves.toBeUndefined()
    expect(controller.getSnapshot().state).toBe('off')
  })

  it('reports an asynchronous unexpected-close cleanup failure', async () => {
    const controller = new VoiceController()
    const socket = await start(controller)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    ;(controller as unknown as { transport: { close(): Promise<void> } }).transport = {
      close: vi.fn().mockRejectedValue(new Error('cleanup failed')),
    }
    socket.dispatchEvent(new Event('close'))
    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith('voice transport cleanup failed:', expect.any(Error))
    })
    expect(controller.getSnapshot().state).toBe('error')
  })

  it('resamples equal-rate and downsampled PCM deterministically', () => {
    expect(resample(new Float32Array([0, .5, 1]), 16_000, 16_000)).toEqual([0, .5, 1])
    expect(resample(new Float32Array([0, 1, 0, -1]), 4, 2)).toEqual([0, 0])
    expect(voiceUrl('session', { href: 'https://example.test/chat', protocol: 'https:' }).href)
      .toBe('wss://example.test/voice?sessionId=session')
    expect(voiceUrl('session', { href: 'http://example.test/chat', protocol: 'http:' }).href)
      .toBe('ws://example.test/voice?sessionId=session')
  })
})
