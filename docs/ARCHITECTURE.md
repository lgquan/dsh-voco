# dsh-voco Architecture

This document describes the stable boundaries between the packages in this repository. It is for maintainers and contributors; user installation and configuration remain in the root README.

## Purpose

`dsh-voco` adds a durable, realtime Voice surface to DSH without replacing the normal Session model. A Voice conversation is an ordinary DSH Session with additional `voice/*` events. Complex requests are executed by a separate, durable Agent Session and linked back to the Voice conversation.

## Package Boundaries

| Package | Responsibility |
| --- | --- |
| `packages/voice` | Provider-neutral Voice capability: session events, transport-facing contracts, and lifecycle semantics. |
| `packages/voice-web` | Browser WebSocket carrier between the UI and the Host Voice service. |
| `packages/voice-local` | SiliconFlow ASR and Edge TTS provider implementation. |
| `packages/voice-assistant` | Voice frontend routing, context-aware task rewriting, background Agent binding, and conversational result rewriting. |
| `packages/ui-voice` | Browser controls, transcript/task renderers, mute state, Voice history, text bridge, and sidebar marker. |
| `packages/voice-app` | Published bundle entry. It composes the server plugins and the browser client into `@flowingspring/dsh-voco`. |

Only `packages/voice-app` is installed by users. The other packages are workspace modules bundled into that public entry.

## Runtime Topology

```text
Browser UI
  |
  | WebSocket (voice session id)
  v
voice-web carrier
  |
  v
voice capability ---- voice-local ---- SiliconFlow ASR / Edge TTS
  |
  +--> voice/* events appended to the source DSH Session
  |
  +--> voice-assistant
          |
          +--> chat/tool: answer in the source Session
          |
          +--> delegate: create or resume a separate Agent Session
                              |
                              +--> progress/result events
                              |
                              +--> conversational rewrite + TTS
```

The source Voice Session and the delegated Agent Session have different IDs. The Agent Session inherits the source working directory, but it is not itself a Voice Session.

## Input and Routing Flow

1. `VoiceControl` starts or toggles the Voice controller for the selected source Session. The same microphone button enters Voice on the first click and toggles input mute afterward.
2. The browser performs lightweight level detection, packages an utterance as WAV, and sends it through `voice-web`.
3. `voice-local` transcribes the audio. Valid text becomes a durable Voice utterance in the source Session; silence and empty recognition results do not interrupt playback.
4. `voice-assistant` combines the utterance with recent conversation and optional Workspace memory. It chooses one of three paths: direct chat, a deterministic lightweight tool, or delegation.
5. Delegated requests are rewritten into a self-contained current task. Background context and the user's original wording are sent separately so short follow-ups such as “你帮我看呀” remain unambiguous.
6. The result is rendered as one conversational reply and sent to Edge TTS. Detailed Agent progress remains in the Agent task UI.

## Session and Task Identity

The source Session remains the user's conversational history. Each source Session can reuse one continuous background Agent Session; individual requests still have their own delegation id. The binding is recorded by the `voice/task-session-bound` event and restored from durable history after reconnect or restart.

The sidebar Voice marker is a client-side index of source Session IDs. It is recorded after Voice connects successfully and is deliberately not attached to Agent Session IDs. A session that contains both text and Voice remains marked as Voice-enabled.

## UI Integration

`packages/ui-voice/src/client/index.ts` registers these DSH UI slots:

- `conversation.input.right`: microphone control and mute toggle.
- `shell.overlay`: active Voice status/controls and the sidebar session marker decorator.
- `sidebar.footer.action`: persisted Voice history picker.
- `conversation.chat.node`: Voice utterances and delegation task cards.

The current DSH workspace package does not expose a row-level sidebar slot. `VoiceSessionMarkers` therefore observes the host-owned session rows and decorates the existing 16px status slot by session key. It does not own row navigation, renaming, archiving, or ordering.

## Persistence and Recovery

- DSH Session history is authoritative for `voice/*` events and task bindings.
- `VoiceHistoryStore` keeps a small browser-local index so the client can identify Voice-enabled sessions in the host-owned sidebar.
- The Voice controller can reconnect or retry without creating a new source Session.
- Text submitted while Voice is connected is routed through the same Voice pipeline; offline text and image submissions use the native DSH path.
- Stopping Voice tears down the browser transport but does not delete the source Session or its Agent binding.

## Configuration and Operations

The published plugin loads with `dsh web` and must not be run as a separate background service. The ASR credential is `SILICONFLOW_API_KEY`. Silence and level thresholds are patched in `packages/voice-app/cordis.patch.yml`.

Useful checks from the repository root:

```powershell
pnpm typecheck
pnpm test
pnpm build
```

## Change Guidelines

- Keep provider-specific code behind `voice` contracts; do not make UI components depend on SiliconFlow or Edge TTS details.
- Treat the source Session and delegated Agent Session as separate identity axes.
- Add durable behavior through events or projections rather than browser-only state when it must survive devices or storage clearing.
- Keep README content user-facing and update this document when package boundaries, event contracts, or lifecycle rules change.
