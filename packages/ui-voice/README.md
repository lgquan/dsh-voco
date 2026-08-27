# `@lgquan/dsh-client-ui-voice`

English | [中文](README.zh.md)

Browser conversation surface for the voice profile. The microphone button attaches Voice Mode to the current durable Session. That source Session is the recoverable Voice conversation window; only creating another ordinary Session creates another Voice conversation identity. A root-owned `/voice` WebSocket keeps capture and playback alive when the user visits a delegated task. Capture starts only after the server's `ready` frame confirms the provider session and audio settings. The package captures echo-cancelled audio, resamples it to 16 kHz PCM, schedules returned MP3 audio, and stops queued playback immediately when a new transcription starts. A provider error or terminal close releases the WebSocket, microphone tracks, playback sources, and audio contexts.

Durable ASR and TTS utterances render as chat messages with a Voice badge. Each live ASR update replaces the prior interim caption; the exact text sent to TTS is projected into an open assistant utterance, persisted as completed only after playback ends, and persisted as interrupted when playback is stopped. Each delegated task renders as a collapsed compact status card that can expand its summary, cancel an active task, or open the fixed background Agent Session for the full trace.

After a Voice transport opens successfully, the plugin records its source Session in a browser-local history index. The Voice history action at the sidebar foot lists those still present in the ordinary Session catalog, marks the active conversation, and opens a saved Session without adding Voice fields to Host projections or Workspace rows. The Session log remains the durable transcript; the index stores only Session ids and local recency.

## Model Experience

### Voice transcript and delegation controls

#### What the model sees

The browser package contributes zero model-visible text. It projects Host-authored `voice/utterance-*`, `voice/task-delegated`, and `voice/task-observation` events; the Voice assistant and task Agent own what enters their model contexts.

#### Token effect

The browser package adds zero tokens directly.

#### KV Cache effect

Browser controls do not modify or reorder model context. Switching to a delegated task changes only the selected UI Session; the active voice transport remains bound to its source Session.

## Known Limitations and Deferred Work

- Capture uses an `AudioWorkletNode`; browsers without AudioWorklet support cannot start voice mode.
- Live transcript updates are transient. Refresh reconstructs completed or interrupted utterances from the durable Session log.
- The Voice history index is local to one browser profile. Clearing site data or using another browser removes the filtered index but does not delete the underlying DSH Sessions.
- An unexpected socket loss enters the explicit retry state; retry within the Host reconnect grace resumes the same provider conversation, while Stop final-closes it.
- This package targets the dsh Web UI: its browser bundle externalizes the platform module table and loads through `window.__ModuleLoader__`, so it depends on the dsh web runtime rather than being a framework-agnostic client plugin.
