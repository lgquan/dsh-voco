# dsh-voco

English | [中文](README.md)

`dsh-voco` is a voice conversation plugin for the DeepSeek Harness (DSH) Web UI. Speak a request naturally and work that needs project tools is delegated to a background Agent. The complete task report stays in the DSH task UI while Voice speaks a concise result.

The plugin uses SiliconFlow cloud speech recognition and Edge TTS. It is not a standalone browser extension and does not require a separate background service.

## Prerequisites

- Node.js 22.19 or newer (used by the DSH CLI).
- A DSH Web profile that can start successfully.
- A SiliconFlow API key. Voco uses the currently free [`XingChenAGI/XingChenASR-V3.2-Ultra`](https://cloud.siliconflow.cn/models?target=XingChenAGI/XingChenASR-V3.2-Ultra) speech-to-text model, but every user still needs their own key. Current availability and pricing are governed by the SiliconFlow model page.
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

## Option 2: Install from a GitHub Release

GitHub Releases provide the same prebuilt plugin package as npm. No source checkout or pnpm development environment is required:

```powershell
dsh plugin --profile web add https://github.com/lgquan/dsh-voco/releases/download/v0.3.6/flowingspring-dsh-voco-0.3.6.tgz
```

Release page: [v0.3.6](https://github.com/lgquan/dsh-voco/releases/tag/v0.3.6)

Whichever installation method you choose, start the Web UI through DSH:

```powershell
dsh web
```

## Configure the SiliconFlow API key

The only required secret is `SILICONFLOW_API_KEY`. Get your own key from the [SiliconFlow console](https://siliconflow.cn/). Speech-to-text uses SiliconFlow's currently free [`XingChenAGI/XingChenASR-V3.2-Ultra`](https://cloud.siliconflow.cn/models?target=XingChenAGI/XingChenASR-V3.2-Ultra) model; current availability and pricing are governed by the model page. Never put a real key in source code, commit it to GitHub, or share it with other users.

### Recommended: DSH settings

After starting DSH, open **Settings → Plugins → Plugin configuration**, expand **Voice Assistant (Voco)**, enter the API key, and save. The key is written to the DSH credentials store rather than the regular settings file, and the UI never reads the secret back. Start or reconnect Voice after saving.

Environment variables and `.env` remain supported for automation and existing deployments.

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

You may also create `.env` in the directory from which you run `dsh web`. The DSH credentials service reads these environment layers, and the plugin resolves `SILICONFLOW_API_KEY` through that service for each new voice connection. Do not enter the npm installation directory or edit files under `node_modules`.

An already inherited environment variable takes precedence, followed by the DSH credentials store and then `.env` fallbacks. Restart `dsh web` after changing `.env`, because the environment is loaded once per process.

## After installation

1. Run `dsh web` and open the DSH Web UI.
2. Create or select a session.
3. Click the microphone and grant browser permission.
4. Speak naturally. About 1.5 seconds of continuous silence ends an utterance and sends it to cloud recognition. You can also hold the microphone for about 400 ms to use push-to-talk; release it to submit only that utterance. A disconnected session stays muted after a push-to-talk submission so its spoken reply can arrive.
5. Ordinary conversation is handled in the frontend; work that needs project files, Shell, or other tools is delegated to the background Agent.

Voice sessions support interruption, reconnects, and history restoration. Each Voice Session keeps its own background Agent Session binding. When the context rotation threshold is reached, Voco creates a new child session for later tasks while keeping it under the same Voice Session.

## Update

Update from npm:

```powershell
dsh plugin --profile web add @flowingspring/dsh-voco
```

You can also install a specific GitHub Release `.tgz` URL. Restart `dsh web` after updating.

## Uninstall

```powershell
dsh plugin --profile web remove @flowingspring/dsh-voco
```

Uninstalling the plugin does not remove a saved API key. To remove it completely, delete `SILICONFLOW_API_KEY` from `refs` in `%USERPROFILE%\.dsh\.credentials.yaml` (or `$DSH_HOME/.credentials.yaml` when configured), and remove the same name from the process environment or any `.env` file.

Uninstalling the plugin does not delete existing DSH sessions or Voice history. Confirm the relevant data directory before removing any stored data manually.

## Highlights

- SiliconFlow's free [`XingChenAGI/XingChenASR-V3.2-Ultra`](https://cloud.siliconflow.cn/models?target=XingChenAGI/XingChenASR-V3.2-Ultra) cloud speech-to-text model.
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
