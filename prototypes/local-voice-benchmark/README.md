# Local voice benchmark prototype

> THROWAWAY PROTOTYPE — this directory measures feasibility. It is not production code and must not be imported by the plugin.

This prototype answers one question: can Silero VAD, streaming FunASR, and a local TTS produce an acceptable voice experience on the current Intel Arc/CPU Windows machine?

All environments, model caches, recordings, and results stay below this directory and are ignored by Git.

## Commands

```powershell
.\run.ps1 system
.\run.ps1 devices
.\run.ps1 record -Seconds 10
.\run.ps1 vad .\audio\microphone.wav
.\run.ps1 asr .\audio\microphone.wav
.\run.ps1 all .\audio\microphone.wav
.\run-tts.ps1
.\run-moss-tts.ps1
```

For the microphone sentence, read naturally:

> 请帮我检查这个 TypeScript 项目的 Agent、RAG、API、DeepSeek 和 MCP 配置。

The first run downloads Python packages and ASR models, so it is not representative of steady-state latency. Later runs reuse the local caches.

## Acceptance targets

- ASR first partial: about 1 second from speech start.
- ASR final result: about 1.2 seconds after speech ends, no more than 1.5 seconds.
- Technical-keyword accuracy: at least 90% on the prepared sentence set.
- TTS first audio: about 1 second after the first text chunk.
- TTS real-time factor: below 1 without playback starvation.
- Barge-in: playback stops within about 300ms after confirmed speech.
- Echo false interruption: no more than 1 in 20 speaker-playback trials.
