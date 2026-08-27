import { createInterface } from 'node:readline'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { resolve } from 'node:path'
import type { VoiceAudioProfile } from '@wayneyu430227/dsh-voice'
import type { SpeechBackend, SpeechBackendEvent } from './speech-backend.ts'

interface WorkerMessage {
  readonly type: string
  readonly [key: string]: unknown
}

export interface PythonWorkerConfig {
  readonly pythonPath: string
  readonly workerScript: string
  readonly modelDir?: string
  readonly ttsRoot?: string
  readonly startupTimeoutMs: number
  readonly inputSampleRate: number
  readonly outputSampleRate: number
}

/** Long-lived stdio adapter for the local Python speech worker. */
export class PythonSpeechBackend implements SpeechBackend {
  readonly audio: VoiceAudioProfile
  private child: ChildProcessWithoutNullStreams | undefined
  private emit: ((event: SpeechBackendEvent) => void) | undefined
  private closed = false
  private stderr = ''

  constructor(private readonly config: PythonWorkerConfig) {
    this.audio = {
      inputSampleRate: config.inputSampleRate,
      outputSampleRate: config.outputSampleRate,
      format: 'pcm_s16le',
    }
  }

  async start(emit: (event: SpeechBackendEvent) => void): Promise<void> {
    if (this.child !== undefined) throw new Error('local speech worker is already started')
    this.emit = emit
    const args = [resolve(this.config.workerScript)]
    if (this.config.modelDir !== undefined && this.config.modelDir !== '') args.push('--model-dir', this.config.modelDir)
    if (this.config.ttsRoot !== undefined && this.config.ttsRoot !== '') args.push('--tts-root', this.config.ttsRoot)
    const child = spawn(this.config.pythonPath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.child = child
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      try { this.receive(JSON.parse(line) as WorkerMessage) }
      catch { emit({ type: 'error', message: 'local speech worker emitted invalid JSON: ' + line.slice(0, 200) }) }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const message = chunk.toString('utf8').trim()
      if (message !== '') this.stderr = (this.stderr + '\n' + message).trim().slice(-4_000)
    })
    child.once('error', (error) => emit({ type: 'error', message: error.message }))
    child.once('exit', (code, signal) => {
      this.child = undefined
      if (!this.closed) {
        const diagnostic = this.stderr === '' ? '' : ': ' + this.stderr
        emit({ type: 'closed', reason: 'worker exited (' + String(code ?? signal ?? 'unknown') + ')' + diagnostic })
      }
    })
    await this.waitForReady()
  }

  appendAudio(audio: Uint8Array): void { this.send({ type: 'audio', audio: Buffer.from(audio).toString('base64') }) }
  commitAudio(): void { this.send({ type: 'commit' }) }
  synthesize(responseId: string, text: string): void { this.send({ type: 'synthesize', responseId, text }) }
  interrupt(): void { this.send({ type: 'interrupt' }) }

  async close(): Promise<void> {
    this.closed = true
    const child = this.child
    if (child === undefined) return
    this.send({ type: 'close' })
    child.stdin.end()
    await new Promise<void>((resolveClose) => {
      const timer = setTimeout(() => { child.kill(); resolveClose() }, 1_000)
      child.once('exit', () => { clearTimeout(timer); resolveClose() })
    })
    this.child = undefined
  }

  private async waitForReady(): Promise<void> {
    await new Promise<void>((resolveReady, reject) => {
      const timeout = setTimeout(() => reject(new Error('local speech worker did not become ready within ' + String(this.config.startupTimeoutMs) + 'ms')), this.config.startupTimeoutMs)
      const previous = this.emit
      this.emit = (event) => {
        previous?.(event)
        if (event.type === 'ready') { clearTimeout(timeout); resolveReady() }
        else if (event.type === 'error') { clearTimeout(timeout); reject(new Error(event.message)) }
        else if (event.type === 'closed') { clearTimeout(timeout); reject(new Error(event.reason ?? 'local speech worker closed before ready')) }
      }
    })
  }

  private send(message: Record<string, unknown>): void {
    if (this.child === undefined || this.child.stdin.destroyed) return
    this.child.stdin.write(JSON.stringify(message) + '\n')
  }

  private receive(message: WorkerMessage): void {
    const emit = this.emit
    if (emit === undefined) return
    switch (message.type) {
      case 'ready': emit({ type: 'ready' }); return
      case 'transcription.started': emit({ type: 'transcription.started', utteranceId: String(message.utteranceId) }); return
      case 'transcription.updated': emit({ type: 'transcription.updated', utteranceId: String(message.utteranceId), text: String(message.text) }); return
      case 'transcription.completed': emit({ type: 'transcription.completed', utteranceId: String(message.utteranceId), text: String(message.text) }); return
      case 'transcription.failed': emit({ type: 'transcription.failed', utteranceId: String(message.utteranceId), message: String(message.message) }); return
      case 'tts.started': emit({ type: 'tts.started', responseId: String(message.responseId) }); return
      case 'tts.delta': emit({ type: 'tts.delta', responseId: String(message.responseId), audio: Buffer.from(String(message.audio), 'base64') }); return
      case 'tts.done': emit({ type: 'tts.done', responseId: String(message.responseId) }); return
      case 'error': emit({ type: 'error', message: String(message.message) }); return
      case 'closed': emit({ type: 'closed', reason: String(message.reason ?? '') }); return
      default: emit({ type: 'error', message: 'local speech worker sent unknown event "' + message.type + '"' })
    }
  }
}
