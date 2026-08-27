# dsh-live

English | [中文](README.md)

Talk to your dsh coding Agent the way you talk to ChatGPT Advanced Voice — except it doesn't just chat, it actually gets the work done.

Say a request out loud and dsh answers conversationally in real time. Real work is delegated to one durable background Agent Session. The full report stays in the task UI, while voice speaks a purpose-written conversational result instead of reading the report.

## Interaction

- **Full-duplex, real-time**: ByteDance Duplex makes it feel like talking to a person — listen and speak at once, interrupt, or correct yourself mid-sentence.
- **Conversational delegation**: the frontend exposes exactly three orchestration tools — `realtime_delegation` (turn "check this for me" into a real background task), `send_task_message` (add or correct requirements), and `cancel_task`.
- **Continuous task context**: sequential delegations reuse one background Agent Session while retaining distinct delegation ids.
- **Asynchronous result backfill**: progress (STATUS) and a spoken result (COMPLETE) flow back into the voice conversation, with adaptive detail and no fixed character cap.
- **Recoverable conversation memory**: restarting voice or DSH restores recent completed user and assistant utterances from the source Session.
- **Uninterrupted flow**: switching browser tabs or reconnecting never stops the live voice session or the task behind it.

## Install

```powershell
pnpm install
pnpm build
$repo = (Resolve-Path .).Path
dsh plugin --profile web add "$repo\packages\voice-app" "$repo\packages\voice" "$repo\packages\voice-duplex" "$repo\packages\voice-assistant" "$repo\packages\voice-web" "$repo\packages\ui-voice"
```

The repository is named `dsh-live`. The internal `@wayneyu430227/*` package names remain for compatibility with the existing DSH profile and user configuration.

The `dsh` command comes from `npm install -g @deepseek-ai/dsh`. Launch web (the voice surface loads with it):

```sh
dsh web
```

## Credentials

The Duplex provider reads two credential references from the environment:

- `DUPLEX_API_KEY` — ByteDance Volcengine access key.
- `DUPLEX_APP_KEY` — the matching app key.

Set both before starting a voice conversation; the provider session fails the handshake without them.

## Limitations

- The browser microphone and playback surface targets the dsh Web UI: it is emitted by the copied dsh client tsdown preset and loads through the dsh web runtime's `window.__ModuleLoader__` contract, so it is not a framework-agnostic browser plugin.
- Voice Sessions record durable `voice/*` events that are required-on-read; a dsh build without this plugin refuses to load them.
