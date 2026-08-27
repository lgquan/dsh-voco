# `@lgquan/dsh-voice-agent`

English | [中文](README.zh.md)

The `dsh-voco` patch-layer bundle attaches provider transport directly to the current source Session and restores recent conversation from durable `voice/utterance-end` events. A lightweight frontend model answers ordinary conversation directly and delegates only tool-requiring work. Delegations from one source Session continuously reuse one ordinary task Agent Session. `voice/agent-binding-state` persists the Voice conversation, background Agent, workspace, last task, last-used time, and status; restart recovery prefers that complete record while remaining compatible with `voice/task-session-bound`. Full results and progress remain in the task UI, while an independent model rewrites the final result and user-actionable questions or warnings against the original request. Progress updates stay in the folded task trace and do not create extra Voice-window messages or TTS requests. The background Agent cannot directly specify spoken text. Root-owned audio continues across navigation, and the browser history index exposes saved Voice Sessions in the sidebar.

## Model Experience

### Voice profile composition

#### What the model sees

Voice-initiated work reaches the source Session's fixed background task Agent only as an accepted `realtime_delegation` envelope and exact-id updates. That task Agent alone receives the scoped `send_voice_message` backend tool for structured `progress | result | warning | error | question` events; the bridge creates or resumes the exact target directly, so no project-listing tool is added. The local provider owns speech input and output while the bridge exposes only task orchestration tools.

#### Token effect

The lightweight frontend route consumes one model call per new utterance. Delegated work additionally consumes task-model tokens for execution, backend reporting, and auxiliary event rewrites; local VAD, ASR, and TTS add no per-minute voice API charge.

#### KV Cache effect

Only accepted commands extend the continuously reused task Agent history. Durable binding state restores that exact Agent Session after restart, while recent Voice Session utterances restore the local conversation.

## Known Limitations and Deferred Work

- The shipped provider is local CPU speech; the service seam keeps model details out of the assistant consumer.
- Raw audio remains process-local; a fresh provider connection restores bounded context from durable completed utterance text.
- An active task is persisted as `interrupted` when the service stops. Recovery reports its last spoken progress without automatically replaying the task or any side-effecting command.
- The filtered Voice history index is browser-local; clearing site data does not delete the underlying Sessions.
- The browser client surface targets the dsh Web UI: it is emitted by the copied dsh client tsdown preset and loads through the dsh web runtime's `window.__ModuleLoader__` contract. The server-side packages are transport-agnostic, but the microphone/playback UI is not a standalone browser plugin.
