# `@wayneyu430227/dsh-voice-agent`

English | [中文](README.zh.md)

The `dsh-live` patch-layer bundle attaches provider transport directly to the current source Session and restores recent conversation from durable `voice/utterance-end` events. Delegations from one source Session continuously reuse one ordinary task Agent Session. Full results remain in the task UI while `COMPLETE` carries an adaptive, conversational spoken response. Root-owned audio continues across navigation, and the browser history index exposes saved Voice Sessions in the sidebar.

## Model Experience

### Voice profile composition

#### What the model sees

Voice-initiated work reaches a fresh task Agent only as an accepted `realtime_delegation` envelope and exact-id updates. That task Agent alone receives the scoped `send_voice_message` backend tool for `STATUS` and `COMPLETE`; the bridge creates the target directly, so no project-listing tool is added. The local provider owns speech input and output while the bridge exposes only task orchestration tools.

#### Token effect

Accepted delegation text, ordinary task work, and backend reporting calls consume text-model tokens; local VAD, ASR, and TTS add no per-minute voice API charge.

#### KV Cache effect

Only accepted commands extend the continuously reused task Agent history; recent Voice Session utterances restore the local conversation.

## Known Limitations and Deferred Work

- The shipped provider is local CPU speech; the service seam keeps model details out of the assistant consumer.
- Raw audio remains process-local; a fresh provider connection restores bounded context from durable completed utterance text.
- The filtered Voice history index is browser-local; clearing site data does not delete the underlying Sessions.
- The browser client surface targets the dsh Web UI: it is emitted by the copied dsh client tsdown preset and loads through the dsh web runtime's `window.__ModuleLoader__` contract. The server-side packages are transport-agnostic, but the microphone/playback UI is not a standalone browser plugin.
