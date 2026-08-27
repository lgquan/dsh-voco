# dsh-live

English | [中文](README.md)

Talk to your dsh coding Agent the way you talk to ChatGPT Advanced Voice — except it doesn't just chat, it actually gets the work done.

Say a request out loud and dsh answers conversationally in real time. Real work is delegated to one durable background Agent Session. The full report stays in the task UI, while voice speaks a purpose-written conversational result instead of reading the report.

## Interaction

- **Local real-time speech**: browser audio is handled by local VAD, FunASR, and MOSS-TTS-Nano, with interruption support.
- **Conversational delegation**: the frontend exposes exactly three orchestration tools — `realtime_delegation` (turn "check this for me" into a real background task), `send_task_message` (add or correct requirements), and `cancel_task`.
- **Continuous task context**: sequential delegations reuse one background Agent Session while retaining distinct delegation ids.
- **Asynchronous result backfill**: progress (STATUS) and a spoken result (COMPLETE) flow back into the voice conversation, with adaptive detail and no fixed character cap.
- **Recoverable conversation memory**: restarting voice or DSH restores recent completed user and assistant utterances from the source Session.
- **Uninterrupted flow**: switching browser tabs or reconnecting never stops the live voice session or the task behind it.

## Install

```powershell
pnpm install
pnpm build
pnpm run setup:voice-local
$repo = (Resolve-Path .).Path
dsh plugin --profile web add "$repo\packages\voice-app" "$repo\packages\voice" "$repo\packages\voice-local" "$repo\packages\voice-assistant" "$repo\packages\voice-web" "$repo\packages\ui-voice"
```

The repository is named `dsh-live`. The internal `@wayneyu430227/*` package names remain for compatibility with the existing DSH profile and user configuration.

The `dsh` command comes from `npm install -g @deepseek-ai/dsh`. Launch web (the voice surface loads with it):

```sh
dsh web
```

## Local speech environment

Run `pnpm run setup:voice-local` after installation. It creates `speech/.venv`, installs `speech/requirements.txt`, and pre-downloads FunASR and MOSS-TTS-Nano ONNX assets. Start `dsh web` only after setup completes; runtime then loads from the D: cache instead of downloading models. Worker caches are kept under `speech/.cache`.

## Limitations

- The browser microphone and playback surface targets the dsh Web UI: it is emitted by the copied dsh client tsdown preset and loads through the dsh web runtime's `window.__ModuleLoader__` contract, so it is not a framework-agnostic browser plugin.
- Voice Sessions record durable `voice/*` events that are required-on-read; a dsh build without this plugin refuses to load them.
