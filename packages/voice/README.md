# `@lgquan/dsh-voice`

English | [中文](README.zh.md)

Provider-neutral realtime voice capability. `ctx.voice` selects one provider, opens an ephemeral voice transport against a durable Agent `SessionId`, forwards PCM audio, and exposes the explicit `appendTaskObservation(event)` plus `requestResponse(policy)` response boundary. Provider ASR and output-text events carry stable `VoiceUtteranceId` values; generated responses also carry `VoiceResponseId` so interruption affects only the matching response. The consumer records durable `voice/utterance-start` and `voice/utterance-end` events, links each accepted frontend delegation to its background Agent Session through `voice/task-delegated`, and logs every provider-visible observation as `voice/task-observation` before delivery. A consumer may reuse that Agent Session across delegations. An unexpected browser detach retains the exact provider conversation for the configurable `reconnectGraceMs`; provider task commands remain deliverable while observations queue for reattachment. Explicit close, provider closure, or grace expiry releases it. Neither lifecycle disposes either Session's Agent.

## Model Experience

### Transcribed Agent input

#### What the model sees

In speech-shell mode, the task model sees the transcription as an ordinary identified user message. In frontend-agent mode, the bound background task Agent sees only accepted `realtime_delegation` envelopes and exact-id updates associated with `VoiceTaskId` values; the Voice Session itself receives no task-model turn. The task Agent alone owns the scoped backend reporting tool.

#### Token effect

Only text admitted to the task Agent, its normal work, and any backend reporting tool calls consume task-model tokens.

#### KV Cache effect

Admitted text extends history like typed input; provider speech and frontend schemas add no task-model request prefix.

## Known Limitations and Deferred Work

- The first protocol version supports one automatic response policy and PCM signed 16-bit little-endian audio.
- The bundled profile uses the local provider. Completed and interrupted text is durable, but raw audio and local model process state are not reconstructed after process restart.
