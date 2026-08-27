# `@lgquan/dsh-voice-assistant`

English | [中文](README.zh.md)

Consumer that binds one attached voice transport to the current durable Session. In `speech-shell` mode, a completed transcription becomes `followup` when no voice task is active and `steer` while one is running in that Session. In `frontend-agent` mode, transcriptions remain in the provider conversation and only validated `TaskCommandCall` events create or control a text task Agent.

`realtime_delegation` allocates the authoritative `VoiceTaskId` and a fresh ordinary task Session, then returns the id on the wire as `delegation_id`. The task Agent inherits the Voice Session's workspace, working directory, preset composition, provider, and model. Its first user message is a `<realtime_delegation>` envelope containing the id, self-contained input, and optional transcript delta; the Voice Session records `voice/task-delegated` with the target `SessionId` for navigation. `send_task_message` sends an exact-id `<realtime_delegation_update>` through that task Agent's `steer`, and `cancel_task` calls that Agent's `cancel({kind: 'user'})`. Unknown, terminal, and cancelling ids return typed rejections without Agent mutation; `dsh-voice` suppresses duplicate provider call ids before this consumer runs.

The plugin installs `send_voice_message` and its guidance only in the active task Agent's scope. The bridge created that exact target, so the backend tool exposes no project listing or selection. `STATUS` messages may repeat and are logged and delivered to the provider without requesting speech. `COMPLETE` is accepted once but held until the authoritative turn succeeds; completed, failed, and cancelled observations request provider speech from their exact backend text. Failure or cancellation discards a buffered COMPLETE. If a successful turn omits `COMPLETE`, the bridge falls back to the last assistant text and then to `completedAnnouncement`.

The exact identified task message is associated with its turn through `agent/inbox/claimed`; the corresponding durable `turn/end` is the task terminal. Every `TaskObservation` is appended to the source Session as `voice/task-observation` before provider delivery. Provider ASR and output-text lifecycles become durable utterance start/end events; deltas remain live browser state. The provider external-text projection makes terminal speech text part of that same durable assistant history. These plugin-owned records are required-on-read: the plugin registers their types with `KNOWN_SESSION_EVENT_TYPES` at load, because DSH core has no generic skip-unknown-plugin-event registration surface yet. Speech-shell mode requests external-text speech for assistant output, while frontend-agent mode requests exact provider speech only for terminal observations. Terminal mapping is `completed` → completed, `aborted` → cancelled, and every other end reason → failed. Voice disconnect detaches transport only, keeps the task Agent and scoped reporting tool while its task is active, continues completing validated provider commands, and queues bounded observations for a same-process reconnect; reconnecting after only STATUS observations remains silent.

## Model Experience

### Voice task observations

#### What the model sees

Speech-shell transcriptions enter the Voice Session Agent as human messages. Frontend-agent work enters a fresh task Agent as a human delegation envelope because the provider model selected its wording. Only that task Agent receives `send_voice_message`; the voice provider receives no dsh business-tool schema.

#### Token effect

Delegation envelopes, ordinary task execution, and `send_voice_message` calls consume task-model tokens. Direct frontend conversation and observation speech stay outside the task-model request.

#### KV Cache effect

Each admitted delegation or update extends normal task-Agent history. The scoped tool schema and guidance are present only while the independent task is active; provider conversation state does not alter the task Agent's reusable history.

## Known Limitations and Deferred Work

- The first version supports one active task per Voice Session.
- Observation buffering survives a transport reconnect only inside the current process. Durable utterances and task links survive restart, but provider conversation reconstruction does not.
- Voice events are required-on-read. A DSH build without this plugin refuses to load a Session containing `voice/*` events; installing the plugin registers the types at load. A generic upstream registration surface would remove this coupling.
