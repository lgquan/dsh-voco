# dsh-voco

English | [中文](README.md)

Talk to your dsh coding Agent the way you talk to ChatGPT Advanced Voice — except it doesn't just chat, it actually gets the work done.

Say a request out loud and dsh answers conversationally in real time. Real work is delegated to one durable background Agent Session. The full report stays in the task UI, while voice speaks a purpose-written conversational result instead of reading the report.

Maintainer architecture notes are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Interaction

- **Cloud speech recognition**: browser audio uses only lightweight local level detection. After 1.5 seconds of silence, the utterance is wrapped as WAV and transcribed by SiliconFlow `XingChenAGI/XingChenASR-V3.2-Ultra`. Ambient noise or an empty transcription does not interrupt a reply in progress; playback stops only after valid text is recognized. Replies use Edge TTS's Chinese Xiaoxiao voice with interruption support.
- **One-button microphone control**: the first press starts Voice; later presses toggle a red, slashed microphone mute state. Muting stops the microphone track and PCM upload while typed turns, background work, and Edge TTS replies remain active. The global overlay retains the separate End action.
- **Chat, lightweight tools, and task routing**: after cloud ASR returns text, a lightweight frontend model interprets the request against recent conversation. Greetings and stable knowledge are answered directly. The current date, time, and weekday come from the host clock instead of model guesses. Only work requiring the project, shell, or other complex capabilities enters the background Agent.
- **Context-resolved task rewriting**: before delegation, the frontend turns elliptical speech into a self-contained current task and sends background context separately from the authoritative original utterance. The backend treats the current task as the instruction and the background only as disambiguation, so a phrase such as “take a look” does not become an unrelated repository inspection.
- **Acknowledge, then delegate**: delegated work gets an immediate one-sentence acknowledgement before entering the fixed background Agent through `realtime_delegation`, with no extra model call.
- **Continuous task context**: sequential delegations reuse one background Agent Session while retaining distinct delegation ids.
- **Voice-session marker**: the sidebar waveform means that the session has successfully enabled Voice. Mixed sessions keep the marker whether text or voice came first; background Agent Sessions do not receive it.
- **Independent conversational results**: the background Agent reports `progress | result | warning | error | question` events with complete facts in the sole `detail` field. The Voice layer rewrites detail against the original request and submits the coherent reply as one UI message and one TTS response. Edge TTS may synthesize sentences internally without creating separate chat bubbles.
- **Recoverable two-session memory**: restarting voice or DSH restores recent source-Session conversation and its fixed background Agent Session binding. An interrupted task reports its last spoken progress but is never replayed automatically.
- **Optional Workspace long-term memory**: with `@flowingspring/dsh-workspace-memory` installed, the voice frontend recalls the current Workspace summary and relevant facts before routing or direct chat, then submits completed utterances for stage-based consolidation. Without it, Voco behaves exactly as before. The background Agent inherits the same `cwd`, so both Sessions share one durable memory scope.
- **Uninterrupted flow**: switching browser tabs or reconnecting never stops the live voice session or the task behind it.

## Install

```powershell
pnpm install
pnpm build
$repo = (Resolve-Path .).Path
dsh plugin --profile web add "$repo\packages\voice-app"
```

The public installation entry is `@flowingspring/dsh-voco`, sourced from `packages/voice-app`. The remaining workspaces are development-only internal modules; their server entries and browser UI are bundled into `@flowingspring/dsh-voco` rather than installed as user-facing plugins.

For a published installation, install the single package directly:

```sh
dsh plugin --profile web add @flowingspring/dsh-voco
```

Long-term memory is optional rather than a Voco dependency. Install the sibling
`dsh-workspace-memory` project separately when needed; either plugin runs on its own.

The local path command above remains useful when developing this repository.

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
