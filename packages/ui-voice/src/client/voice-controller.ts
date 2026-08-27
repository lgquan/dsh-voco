import type { ObservableSnapshot, SessionId } from '@deepseek-ai/dsh-client-runtime/client'

/** Browser-visible lifecycle of the one active voice transport. */
export type VoiceClientState = 'off' | 'connecting' | 'listening' | 'speaking' | 'error'

/** Live text retained until the matching durable utterance settles. */
export interface VoiceLiveText {
  readonly text: string
}

/** Root-owned voice transport projection shared by every UI seat. */
export interface VoiceClientSnapshot {
  readonly state: VoiceClientState
  readonly sessionId?: SessionId
  readonly textById: Readonly<Record<string, VoiceLiveText>>
}

interface VoiceTransport {
  close(): Promise<void>
}

interface VoiceTransportHandlers {
  readonly onBinary: (audio: ArrayBuffer) => void
  readonly onEvent: (event: unknown) => void
  readonly onPlaybackEnded: () => void
  readonly onUnexpectedClose: () => void
}

interface VoiceReadyEvent {
  readonly type: 'ready'
  readonly voiceSessionId: string
  readonly audio: {
    readonly inputSampleRate: number
    readonly outputSampleRate: number
    readonly format: 'pcm_s16le'
  }
  readonly interactionMode: 'speech-shell' | 'frontend-agent'
}

const INITIAL_SNAPSHOT: VoiceClientSnapshot = { state: 'off', textById: {} }

/** Own the single browser microphone, provider WebSocket, playback queue, and live transcript feed. */
export class VoiceController implements ObservableSnapshot<VoiceClientSnapshot> {
  private snapshot = INITIAL_SNAPSHOT
  private readonly listeners = new Set<() => void>()
  private transport: VoiceTransport | undefined
  private openingTransport: VoiceTransport | undefined
  private openingAbort: AbortController | undefined
  private generation = 0
  private frame: number | undefined

  /** Return the identity-stable snapshot until a voice fact changes. */
  getSnapshot = (): VoiceClientSnapshot => this.snapshot

  /** Subscribe to state and frame-coalesced transcript changes. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Open one voice transport and make it the root-owned active session.
   * @param sessionId - durable voice session to connect.
   */
  async start(sessionId: SessionId): Promise<void> {
    const generation = ++this.generation
    await this.closeTransport()
    if (generation !== this.generation) return
    const openingAbort = new AbortController()
    this.openingAbort = openingAbort
    this.publish({ state: 'connecting', sessionId, textById: {} })
    try {
      const transport = await openVoiceTransport(String(sessionId), {
        onBinary: () => { this.setState('speaking') },
        onEvent: (event) => { this.handleEvent(event) },
        onPlaybackEnded: () => { this.setState('listening') },
        onUnexpectedClose: () => { this.handleUnexpectedClose() },
      }, openingAbort.signal, (opening) => {
        if (generation === this.generation) this.openingTransport = opening
        else void opening.close()
      })
      if (generation !== this.generation) {
        await transport.close()
        return
      }
      this.openingTransport = undefined
      this.transport = transport
      this.setState('listening')
    } catch (cause) {
      if (generation !== this.generation) return
      this.setState('error')
      throw cause
    } finally {
      if (this.openingAbort === openingAbort) this.openingAbort = undefined
      if (generation === this.generation) this.openingTransport = undefined
    }
  }

  /** Retry the failed active Voice Session, when one was created successfully. */
  async retry(): Promise<void> {
    const sessionId = this.snapshot.sessionId
    if (sessionId === undefined) throw new Error('voice retry requires an active session')
    await this.start(sessionId)
  }

  /** Stop capture/playback and await owned browser-resource teardown. */
  async stop(): Promise<void> {
    ++this.generation
    this.openingAbort?.abort()
    this.openingAbort = undefined
    this.publish(INITIAL_SNAPSHOT)
    await this.closeTransport()
  }

  private async closeTransport(): Promise<void> {
    const transports = new Set<VoiceTransport>()
    if (this.transport !== undefined) transports.add(this.transport)
    if (this.openingTransport !== undefined) transports.add(this.openingTransport)
    this.transport = undefined
    this.openingTransport = undefined
    if (this.frame !== undefined) {
      cancelAnimationFrame(this.frame)
      this.frame = undefined
    }
    const settled = await Promise.allSettled([...transports].map(transport => transport.close()))
    const failures: unknown[] = []
    for (const result of settled) {
      if (result.status === 'rejected') failures.push(result.reason as unknown)
    }
    if (failures.length > 0) throw new AggregateError(failures, 'voice transport cleanup failed')
  }

  private handleUnexpectedClose(): void {
    this.openingAbort?.abort()
    this.setState('error')
    void this.closeTransport().catch((cause: unknown) => {
      console.error('voice transport cleanup failed:', cause)
    })
  }

  private setState(state: VoiceClientState): void {
    if (this.snapshot.state === state) return
    this.publish({ ...this.snapshot, state })
  }

  private setText(id: string, text: string, cadence: 'immediate' | 'animation-frame'): void {
    if (id === '') return
    const current = this.snapshot.textById[id]
    if (current?.text === text) return
    this.snapshot = {
      ...this.snapshot,
      textById: { ...this.snapshot.textById, [id]: { text } },
    }
    if (cadence === 'immediate') this.notify()
    else this.notifyOnFrame()
  }

  private appendText(id: string, delta: string): void {
    if (id === '' || delta === '') return
    this.setText(id, `${this.snapshot.textById[id]?.text ?? ''}${delta}`, 'animation-frame')
  }

  private handleEvent(input: unknown): void {
    const event = recordOf(input)
    if (event === undefined) return
    const type = stringOf(event.type)
    if (type === 'transcription.started') {
      this.setText(stringOf(event.utteranceId), '', 'immediate')
      this.setState('listening')
      return
    }
    if (type === 'transcription.updated') {
      this.setText(stringOf(event.utteranceId), stringOf(event.text), 'animation-frame')
      return
    }
    if (type === 'transcription.completed') {
      this.setText(stringOf(event.utteranceId), stringOf(event.text), 'immediate')
      return
    }
    if (type === 'output_text.started') {
      this.setText(stringOf(event.utteranceId), '', 'immediate')
      return
    }
    if (type === 'output_text.delta') {
      this.appendText(stringOf(event.utteranceId), stringOf(event.text))
      return
    }
    if (type === 'output_text.done') {
      const text = stringOf(event.text)
      if (text !== '') this.setText(stringOf(event.utteranceId), text, 'immediate')
      return
    }
    if (type === 'output_audio.started') {
      this.setState('speaking')
      return
    }
    if (type === 'response.interrupted') {
      this.setState('listening')
      return
    }
    if (type === 'error') this.handleUnexpectedClose()
  }

  private publish(snapshot: VoiceClientSnapshot): void {
    if (this.frame !== undefined) {
      cancelAnimationFrame(this.frame)
      this.frame = undefined
    }
    this.snapshot = snapshot
    this.notify()
  }

  private notifyOnFrame(): void {
    this.frame ??= requestAnimationFrame(() => {
      this.frame = undefined
      this.notify()
    })
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try { listener() } catch (cause) { console.error('voice snapshot listener failed:', cause) }
    }
  }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

async function openVoiceTransport(
  sessionId: string,
  handlers: VoiceTransportHandlers,
  signal: AbortSignal,
  onOpening: (transport: VoiceTransport) => void,
): Promise<VoiceTransport> {
  const inputContext = new AudioContext()
  const outputContext = new AudioContext()
  const socket = new WebSocket(voiceUrl(sessionId))
  const workletUrl = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'text/javascript' }))
  let stream: MediaStream | undefined
  let source: MediaStreamAudioSourceNode | undefined
  let processor: AudioWorkletNode | undefined
  let silent: GainNode | undefined
  let stopped = false
  let socketClosed = false
  let ready = false
  let outputDone = false
  let inputSampleRate = 16_000
  let outputSampleRate = 24_000
  let playAt = outputContext.currentTime
  const chunks: number[] = []
  const playing = new Set<AudioBufferSourceNode>()

  const transport: VoiceTransport = {
    close: async () => {
      /* v8 ignore next -- controller ownership closes a transport once; the guard protects browser close races. */
      if (stopped) return
      stopped = true
      if (!socketClosed && socket.readyState === WebSocket.OPEN) {
        try { socket.send(JSON.stringify({ type: 'session.close' })) } catch {
          /* A socket closing concurrently cannot carry the final control; the server expires its reconnect grace. */
        }
      }
      socket.removeEventListener('message', onMessage)
      socket.removeEventListener('close', onClose)
      stopPlayback()
      source?.disconnect()
      processor?.disconnect()
      silent?.disconnect()
      processor?.port.close()
      for (const track of stream?.getTracks() ?? []) track.stop()
      socket.close()
      await Promise.allSettled([inputContext.close(), outputContext.close()])
    },
  }

  const stopPlayback = (): void => {
    for (const node of playing) {
      try { node.stop() } catch { /* a completed source is already stopped */ }
    }
    playing.clear()
    playAt = outputContext.currentTime
    outputDone = false
  }
  const notifyPlaybackEnded = (): void => {
    if (outputDone && playing.size === 0 && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'playback.ended' }))
      outputDone = false
      handlers.onPlaybackEnded()
    }
  }
  const onMessage = (message: MessageEvent): void => {
    if (!ready) return
    if (message.data instanceof ArrayBuffer) {
      schedulePcm(outputContext, message.data, outputSampleRate, playing, notifyPlaybackEnded, (value) => { playAt = value }, playAt)
      handlers.onBinary(message.data)
      return
    }
    let event: unknown
    try { event = JSON.parse(String(message.data)) } catch { return }
    const record = recordOf(event)
    if (record?.type === 'transcription.started' || record?.type === 'response.interrupted') stopPlayback()
    if (record?.type === 'output_audio.done') {
      outputDone = true
      notifyPlaybackEnded()
    }
    handlers.onEvent(event)
  }
  const onClose = (): void => {
    socketClosed = true
    handlers.onUnexpectedClose()
  }

  socket.binaryType = 'arraybuffer'
  onOpening(transport)
  try {
    await socketOpened(socket, signal)
    socket.addEventListener('message', onMessage)
    socket.addEventListener('close', onClose)
    const readyEvent = await socketReady(socket, signal)
    inputSampleRate = readyEvent.audio.inputSampleRate
    outputSampleRate = readyEvent.audio.outputSampleRate
    ready = true
    const captured = await microphone(signal)
    if (openingStopped(signal, stopped)) {
      for (const track of captured.getTracks()) track.stop()
      throw new Error('voice connection opening aborted')
    }
    stream = captured
    await abortable(inputContext.audioWorklet.addModule(workletUrl), signal)
    if (openingStopped(signal, stopped)) throw new Error('voice connection opening aborted')
    source = inputContext.createMediaStreamSource(stream)
    processor = new AudioWorkletNode(inputContext, 'dsh-pcm-capture')
    silent = inputContext.createGain()
    silent.gain.value = 0
    processor.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (socket.readyState !== WebSocket.OPEN) return
      chunks.push(...resample(event.data, inputContext.sampleRate, inputSampleRate))
      const frameSize = Math.max(1, Math.round(inputSampleRate / 5))
      while (chunks.length >= frameSize) {
        const part = chunks.splice(0, frameSize)
        const pcm = new Int16Array(part.length)
        for (const [index, sample] of part.entries()) {
          pcm[index] = Math.round(Math.max(-1, Math.min(1, sample)) * 32767)
        }
        socket.send(pcm.buffer)
      }
    }
    source.connect(processor)
    processor.connect(silent)
    silent.connect(inputContext.destination)
  } catch (cause) {
    await transport.close()
    throw cause
  } finally {
    URL.revokeObjectURL(workletUrl)
  }

  return transport
}

function microphone(signal: AbortSignal): Promise<MediaStream> {
  if (signal.aborted) return Promise.reject(new Error('voice connection opening aborted'))
  return new Promise((resolve, reject) => {
    let cancelled = false
    const cleanup = (): void => { signal.removeEventListener('abort', aborted) }
    const aborted = (): void => {
      cancelled = true
      cleanup()
      reject(new Error('voice connection opening aborted'))
    }
    signal.addEventListener('abort', aborted, { once: true })
    let request: Promise<MediaStream>
    try {
      request = navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch (cause) {
      cleanup()
      reject(errorOf(cause))
      return
    }
    void request.then((value) => {
      cleanup()
      if (cancelled || signal.aborted) {
        for (const track of value.getTracks()) track.stop()
        return
      }
      resolve(value)
    }, (cause: unknown) => {
      cleanup()
      if (!cancelled) reject(errorOf(cause))
    })
  })
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('voice connection opening aborted'))
  return new Promise((resolve, reject) => {
    let cancelled = false
    const cleanup = (): void => { signal.removeEventListener('abort', aborted) }
    const aborted = (): void => {
      cleanup()
      cancelled = true
      reject(new Error('voice connection opening aborted'))
    }
    signal.addEventListener('abort', aborted, { once: true })
    void operation.then((value) => {
      cleanup()
      if (!cancelled) resolve(value)
    }, (cause: unknown) => {
      cleanup()
      if (!cancelled) reject(errorOf(cause))
    })
  })
}

function socketOpened(socket: WebSocket, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      socket.removeEventListener('open', opened)
      socket.removeEventListener('error', failed)
      signal.removeEventListener('abort', aborted)
    }
    const opened = (): void => { cleanup(); resolve() }
    const failed = (): void => { cleanup(); reject(new Error('voice websocket failed')) }
    const aborted = (): void => { cleanup(); reject(new Error('voice connection opening aborted')) }
    if (signal.aborted) { aborted(); return }
    socket.addEventListener('open', opened, { once: true })
    socket.addEventListener('error', failed, { once: true })
    signal.addEventListener('abort', aborted, { once: true })
  })
}

function socketReady(socket: WebSocket, signal: AbortSignal): Promise<VoiceReadyEvent> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      socket.removeEventListener('message', received)
      socket.removeEventListener('error', failed)
      socket.removeEventListener('close', closed)
      signal.removeEventListener('abort', aborted)
    }
    const settle = (operation: () => void): void => { cleanup(); operation() }
    const received = (message: MessageEvent): void => {
      try {
        const value: unknown = message.data instanceof ArrayBuffer
          ? undefined
          : JSON.parse(String(message.data)) as unknown
        settle(() => { resolve(parseReady(value)) })
      } catch (cause) {
        settle(() => { reject(errorOf(cause)) })
      }
    }
    const failed = (): void => { settle(() => { reject(new Error('voice websocket failed before ready')) }) }
    const closed = (): void => { settle(() => { reject(new Error('voice websocket closed before ready')) }) }
    const aborted = (): void => { settle(() => { reject(new Error('voice connection opening aborted')) }) }
    if (signal.aborted) { aborted(); return }
    if (socket.readyState !== WebSocket.OPEN) { closed(); return }
    socket.addEventListener('message', received)
    socket.addEventListener('error', failed, { once: true })
    socket.addEventListener('close', closed, { once: true })
    signal.addEventListener('abort', aborted, { once: true })
  })
}

function openingStopped(signal: AbortSignal, stopped: boolean): boolean {
  return signal.aborted || stopped
}

function errorOf(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

function parseReady(value: unknown): VoiceReadyEvent {
  const event = recordOf(value)
  if (event?.type === 'error') {
    const message = stringOf(event.message)
    throw new Error(message === '' ? 'voice setup failed before ready' : message)
  }
  if (event?.type !== 'ready') throw new Error('voice websocket expected a ready event')
  const voiceSessionId = stringOf(event.voiceSessionId)
  if (voiceSessionId === '') throw new Error('voice websocket ready event has no voiceSessionId')
  const audio = recordOf(event.audio)
  if (audio?.inputSampleRate !== 16_000
    || (audio.outputSampleRate !== 24_000 && audio.outputSampleRate !== 48_000)
    || audio.format !== 'pcm_s16le') {
    throw new Error('voice websocket ready event has unsupported audio settings')
  }
  if (event.interactionMode !== 'speech-shell' && event.interactionMode !== 'frontend-agent') {
    throw new Error('voice websocket ready event has an invalid interactionMode')
  }
  return { type: 'ready', voiceSessionId, audio: {
    inputSampleRate: audio.inputSampleRate,
    outputSampleRate: audio.outputSampleRate,
    format: 'pcm_s16le',
  }, interactionMode: event.interactionMode }
}

/**
 * Resolve the dedicated WebSocket URL for one durable Voice Session.
 * @param sessionId - durable voice session id.
 * @param location - browser location used for host and protocol defaults.
 * @returns the /voice WebSocket URL carrying the session id.
 */
export function voiceUrl(sessionId: string, location: Pick<Location, 'href' | 'protocol'> = window.location): URL {
  const url = new URL('/voice', location.href)
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('sessionId', sessionId)
  return url
}

const CAPTURE_WORKLET = `
class DshPcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel) this.port.postMessage(channel.slice())
    return true
  }
}
registerProcessor('dsh-pcm-capture', DshPcmCaptureProcessor)
`

/**
 * Resample browser float PCM into the provider input rate.
 * @param input - float samples at `fromRate`.
 * @param fromRate - source sample rate in Hz.
 * @param toRate - target sample rate in Hz.
 * @returns linearly interpolated samples at `toRate`.
 */
export function resample(input: Float32Array, fromRate: number, toRate: number): number[] {
  if (fromRate === toRate) return [...input]
  const ratio = fromRate / toRate
  const result = new Array<number>(Math.floor(input.length / ratio))
  for (let index = 0; index < result.length; index += 1) {
    const position = index * ratio
    const left = Math.floor(position)
    const fraction = position - left
    const leftSample = input[left] as number
    const rightSample = input[Math.min(left + 1, input.length - 1)] as number
    result[index] = leftSample * (1 - fraction) + rightSample * fraction
  }
  return result
}

function schedulePcm(
  context: AudioContext,
  bytes: ArrayBuffer,
  sampleRate: number,
  playing: Set<AudioBufferSourceNode>,
  ended: () => void,
  setPlayAt: (value: number) => void,
  currentPlayAt: number,
): void {
  const pcm = new Int16Array(bytes)
  const buffer = context.createBuffer(1, pcm.length, sampleRate)
  const channel = buffer.getChannelData(0)
  for (const [index, sample] of pcm.entries()) channel[index] = sample / 32768
  const node = context.createBufferSource()
  node.buffer = buffer
  node.connect(context.destination)
  const start = Math.max(currentPlayAt, context.currentTime)
  setPlayAt(start + buffer.duration)
  playing.add(node)
  node.onended = () => { playing.delete(node); ended() }
  node.start(start)
}
