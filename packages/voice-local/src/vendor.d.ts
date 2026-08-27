declare module 'sherpa-onnx-node' {
  export interface SpeechSegment {
    readonly samples: Float32Array
    readonly start: number
  }

  export interface OnlineStream {
    acceptWaveform(input: { readonly samples: Float32Array; readonly sampleRate: number }): void
    inputFinished(): void
  }

  export interface OnlineRecognizerResult {
    readonly text: string
  }

  export class OnlineRecognizer {
    constructor(config: Record<string, unknown>)
    createStream(): OnlineStream
    isReady(stream: OnlineStream): boolean
    decode(stream: OnlineStream): void
    getResult(stream: OnlineStream): OnlineRecognizerResult
  }

  export class Vad {
    constructor(config: Record<string, unknown>, bufferSizeInSeconds: number)
    acceptWaveform(samples: Float32Array): void
    isDetected(): boolean
    isEmpty(): boolean
    front(enableExternalBuffer?: boolean): SpeechSegment
    pop(): void
    flush(): void
    clear(): void
  }

  const sherpa: { readonly OnlineRecognizer: typeof OnlineRecognizer; readonly Vad: typeof Vad }
  export default sherpa
}
