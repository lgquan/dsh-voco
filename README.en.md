# dsh-voco

English | [中文](README.md)

Talk to your dsh coding Agent the way you talk to ChatGPT Advanced Voice — except it doesn't just chat, it actually gets the work done.

Say a request out loud and dsh answers conversationally in real time. Real work is delegated to one durable background Agent Session. The full report stays in the task UI, while voice speaks a purpose-written conversational result instead of reading the report.

## Interaction

- **Real-time voice conversation**: browser audio uses local Silero VAD and streaming Paraformer ONNX, while replies use Edge TTS's Chinese Xiaoxiao voice with interruption support.
- **On-demand delegation**: after local ASR, a lightweight frontend model routes the intent. Greetings and questions requiring no tools are answered directly; only workspace inspection or modification, commands, and similar work enter the fixed background Agent through `realtime_delegation`.
- **Continuous task context**: sequential delegations reuse one background Agent Session while retaining distinct delegation ids.
- **Independent conversational results**: the background Agent reports `progress | result | warning | error | question` events with complete facts in the sole `detail` field. The Voice layer rewrites detail against the original request and submits the coherent reply as one UI message and one TTS response. Edge TTS may synthesize sentences internally without creating separate chat bubbles.
- **Recoverable two-session memory**: restarting voice or DSH restores recent source-Session conversation and its fixed background Agent Session binding. An interrupted task reports its last spoken progress but is never replayed automatically.
- **Uninterrupted flow**: switching browser tabs or reconnecting never stops the live voice session or the task behind it.

## Install

```powershell
pnpm install
pnpm build
$repo = (Resolve-Path .).Path
dsh plugin --profile web add "$repo\packages\voice-app" "$repo\packages\voice" "$repo\packages\voice-local" "$repo\packages\voice-assistant" "$repo\packages\voice-web" "$repo\packages\ui-voice"
```

The project is named `dsh-voco`, and all internal packages use the `@lgquan/*` namespace.

The `dsh` command comes from `npm install -g @deepseek-ai/dsh`. Launch web (the voice surface loads with it):

```sh
dsh web
```

## Local speech environment

`pnpm install` automatically runs the cross-platform model installer. Silero VAD and bilingual streaming Paraformer assets are stored under `speech/models`; replies use Edge TTS voice `zh-CN-XiaoxiaoNeural`. The installer is idempotent and can be rerun with `pnpm run setup:voice-local`.

The speech runtime uses TypeScript/Node and prebuilt ONNX native packages only. Python, pip, virtual environments, and PyTorch are not required. Windows x64, macOS Intel, and macOS Apple Silicon are supported.

## Limitations

- The browser microphone and playback surface targets the dsh Web UI: it is emitted by the copied dsh client tsdown preset and loads through the dsh web runtime's `window.__ModuleLoader__` contract, so it is not a framework-agnostic browser plugin.
- Voice Sessions record durable `voice/*` events that are required-on-read; a dsh build without this plugin refuses to load them.
