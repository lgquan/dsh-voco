# dsh-voco

English | [中文](README.md)

`dsh-voco` is a voice conversation plugin for the DeepSeek Harness (DSH) Web UI. Speak a request naturally and work that needs project tools is delegated to a background Agent. The complete task report stays in the DSH task UI while Voice speaks a concise result.

The plugin uses SiliconFlow cloud speech recognition and Edge TTS. It is not a standalone browser extension and does not require a separate background service.

## Prerequisites

- Node.js 22.19 or newer (used by the DSH CLI).
- A DSH Web profile that can start successfully.
- A SiliconFlow API key. Speech recognition consumes SiliconFlow API usage; each user must obtain and fund their own key.
- A modern browser with microphone support.

Install the DSH CLI first if it is not already available:

```powershell
npm install -g @deepseek-ai/dsh
```

## Option 1: Install from npm (recommended)

This is the intended path for regular users. It installs the one public plugin package without downloading or editing this repository:

```powershell
dsh plugin --profile web add @flowingspring/dsh-voco
```

Start the DSH Web UI:

```powershell
dsh web
```

Open the local URL printed by DSH, click the microphone in a session, and allow microphone access in the browser.

## Option 2: Install from GitHub source

The GitHub repository is a pnpm workspace. The actual DSH plugin is `packages/voice-app`. Use this route when you want to inspect, debug, or modify the source:

```powershell
git clone https://github.com/lgquan/dsh-voco.git
cd dsh-voco
npm install -g pnpm
pnpm install
pnpm build
$repo = (Resolve-Path .).Path
dsh plugin --profile web add "$repo\packages\voice-app"
```

Start the Web UI through DSH as usual:

```powershell
dsh web
```

This source installation does not modify DeepSeek Harness source code. After changing or updating the plugin, run `pnpm install`, `pnpm build`, and the local-path install command again.

## Configure the SiliconFlow API key

The only required secret is `SILICONFLOW_API_KEY`. Get your own key from the [SiliconFlow console](https://siliconflow.cn/). Never put a real key in source code, commit it to GitHub, or share it with other users.

### Temporary: current PowerShell session

Set the variable in the same terminal that starts DSH:

```powershell
$env:SILICONFLOW_API_KEY = "sk-your-api-key"
dsh web
```

The value disappears when that terminal closes.

### Persistent: DSH user environment file

Create `.env` in the DSH user directory. On Windows the default path is `%USERPROFILE%\.dsh\.env` (or `$DSH_HOME/.env` when `DSH_HOME` is set):

```dotenv
SILICONFLOW_API_KEY=sk-your-api-key
```

You may also create `.env` in the directory from which you run `dsh web`. DSH reads these environment layers at startup, and the plugin then reads `process.env.SILICONFLOW_API_KEY`. Do not enter the npm installation directory or edit files under `node_modules`.

An already inherited environment variable takes precedence over values from `.env`. Restart `dsh web` after changing `.env`, because the environment is loaded once per process.

## First use

1. Run `dsh web` and open the DSH Web UI.
2. Create or select a session.
3. Click the microphone and grant browser permission.
4. Speak naturally. About 1.5 seconds of continuous silence ends an utterance and sends it to cloud recognition.
5. Ordinary conversation is handled in the frontend; work that needs project files, Shell, or other tools is delegated to the background Agent.

Voice sessions support interruption, reconnects, and history restoration. Each Voice Session keeps its own background Agent Session binding. When the context rotation threshold is reached, Voco creates a new child session for later tasks while keeping it under the same Voice Session.

## Highlights

- SiliconFlow `XingChenAGI/XingChenASR-V3.2-Ultra` cloud speech recognition.
- Edge TTS `zh-CN-XiaoxiaoNeural` voice output.
- Voice, typed messages, and background Agent tasks in one DSH session.
- Immediate acknowledgement before delegation; full reports remain in the task UI.
- Voice binding survives navigation, reconnects, and DSH restarts.
- Optional integration with `@flowingspring/dsh-workspace-memory` for Workspace memory.

## Troubleshooting

### Missing API key when clicking the microphone

Make sure the DSH process can read `SILICONFLOW_API_KEY`. After creating or changing `.env`, stop the old DSH process and run `dsh web` again.

### No microphone or audio output

Check browser microphone permission and the system input device. Use the page served by `dsh web`; do not open an HTML file directly.

### Recognition fails or takes a long time

Speech recognition needs network access to SiliconFlow. Check connectivity, key validity, account quota, and the latency of the selected model and provider.

### Tuning silence detection

Advanced settings live in the plugin profile's `cordis.patch.yml`, including `silenceDurationMs`, `speechThreshold`, `minSpeechDurationMs`, and `maxUtteranceMs`. Most users can keep the defaults.

## Optional Workspace Memory

Workspace Memory is not required by Voco. Install `@flowingspring/dsh-workspace-memory` separately when needed; Voco also works by itself. See that project's documentation for its own installation and configuration.

## Development and support

- Source and issues: [GitHub](https://github.com/lgquan/dsh-voco)
- npm package: [`@flowingspring/dsh-voco`](https://www.npmjs.com/package/@flowingspring/dsh-voco)
- Architecture notes: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

## License

[MIT](LICENSE)
