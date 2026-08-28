# dsh-voco

English | [中文](README.md)

Talk to your dsh coding Agent the way you talk to ChatGPT Advanced Voice — except it doesn't just chat, it actually gets the work done.

Say a request out loud and dsh answers conversationally in real time. Real work is delegated to one durable background Agent Session. The full report stays in the task UI, while voice speaks a purpose-written conversational result instead of reading the report.

## Interaction

- **Cloud speech recognition**: browser audio uses only lightweight local level detection. After 1.5 seconds of silence, the utterance is wrapped as WAV and transcribed by SiliconFlow `XingChenAGI/XingChenASR-V3.2-Ultra`. Replies use Edge TTS's Chinese Xiaoxiao voice with interruption support.
- **On-demand delegation**: after cloud ASR returns text, a lightweight frontend model routes the intent. Greetings and questions requiring no tools are answered directly; only workspace inspection or modification, commands, and similar work enter the fixed background Agent through `realtime_delegation`.
- **Continuous task context**: sequential delegations reuse one background Agent Session while retaining distinct delegation ids.
- **Independent conversational results**: the background Agent reports `progress | result | warning | error | question` events with complete facts in the sole `detail` field. The Voice layer rewrites detail against the original request and submits the coherent reply as one UI message and one TTS response. Edge TTS may synthesize sentences internally without creating separate chat bubbles.
- **Recoverable two-session memory**: restarting voice or DSH restores recent source-Session conversation and its fixed background Agent Session binding. An interrupted task reports its last spoken progress but is never replayed automatically.
- **Uninterrupted flow**: switching browser tabs or reconnecting never stops the live voice session or the task behind it.

## Install

```powershell
pnpm install
pnpm build
$repo = (Resolve-Path .).Path
dsh plugin --profile web add "$repo\packages\voice-app"
```

The public installation entry is `@lgquan/dsh-voco`, sourced from `packages/voice-app`. The remaining `@lgquan/*` packages are internal feature modules installed transitively, so they do not need to be added one by one.

The `dsh` command comes from `npm install -g @deepseek-ai/dsh`. Launch web (the voice surface loads with it):

```sh
dsh web
```

## Speech environment

Create `.env` in the repository root and configure the SiliconFlow API key:

```dotenv
SILICONFLOW_API_KEY=your-key
```

`.env` is ignored by Git. The default boundary is `1500ms` of continuous silence, with at least `250ms` of voiced audio required to confirm speech onset; tune `silenceDurationMs`, `speechThreshold`, `minSpeechDurationMs`, and `maxUtteranceMs` in `packages/voice-app/cordis.patch.yml`. No local ASR/VAD models, Python, pip, PyTorch, or ONNX runtime are required. Replies continue to use Edge TTS with `zh-CN-XiaoxiaoNeural`.

While Voice is connected, plain text submitted from that session's composer is treated as a Voice input: the same user message appears in the conversation, and the response continues through conversational rewriting and Edge TTS. Offline Voice sessions and submissions containing images retain the native Harness text path.

## Limitations

- The browser microphone and playback surface targets the dsh Web UI: it is emitted by the copied dsh client tsdown preset and loads through the dsh web runtime's `window.__ModuleLoader__` contract, so it is not a framework-agnostic browser plugin.
- Voice Sessions record durable `voice/*` events that are required-on-read; a dsh build without this plugin refuses to load them.
