# `@flowingspring/dsh-voco`

[![npm version](https://img.shields.io/npm/v/@flowingspring/dsh-voco.svg)](https://www.npmjs.com/package/@flowingspring/dsh-voco)
[![license](https://img.shields.io/npm/l/@flowingspring/dsh-voco.svg)](https://github.com/lgquan/dsh-voco/blob/master/LICENSE)

English | [中文](README.zh.md)

Recoverable, interruptible voice conversations for the DeepSeek Harness (DSH) Web UI. Voco uses SiliconFlow cloud speech recognition and Edge TTS, and delegates work that needs tools to a background Agent.

## Install

### npm (recommended)

Install the DSH CLI first:

```powershell
npm install -g @deepseek-ai/dsh
```

Add the plugin to the Web profile and start it:

```powershell
dsh plugin --profile web add @flowingspring/dsh-voco
dsh web
```

### GitHub source

The repository root is a workspace; the plugin source is `packages/voice-app`. Use this route to inspect or modify the source:

```powershell
git clone https://github.com/lgquan/dsh-voco.git
cd dsh-voco
npm install -g pnpm
pnpm install
pnpm build
$repo = (Resolve-Path .).Path
dsh plugin --profile web add "$repo\packages\voice-app"
dsh web
```

## Configure the API key

Speech recognition requires your own [SiliconFlow API key](https://siliconflow.cn/). The only configuration name is `SILICONFLOW_API_KEY`; Edge TTS does not require a key.

For a temporary setting, use the same PowerShell session that starts DSH:

```powershell
$env:SILICONFLOW_API_KEY = "sk-your-api-key"
dsh web
```

For a persistent setting, create `.env` in the DSH user directory: `%USERPROFILE%\.dsh\.env` on Windows, or `$DSH_HOME/.env` when `DSH_HOME` is set:

```dotenv
SILICONFLOW_API_KEY=sk-your-api-key
```

You may also put `.env` in the directory from which you run `dsh web`. Restart DSH after changing it. Never edit the npm installation directory or files under `node_modules`, and never commit a real key to GitHub.

## First use

1. Run `dsh web` and open the DSH Web UI.
2. Create or select a session, click the microphone, and grant browser permission.
3. Speak naturally. About 1.5 seconds of continuous silence submits an utterance.
4. Ordinary conversation is answered in the frontend; work that needs project tools is delegated to the background Agent.

Each Voice Session keeps its own background Agent Session binding. When the context rotation threshold is reached, later tasks automatically use a new child session that remains associated with the original Voice Session.

## Features

- SiliconFlow `XingChenAGI/XingChenASR-V3.2-Ultra` cloud speech recognition.
- Edge TTS `zh-CN-XiaoxiaoNeural` voice responses.
- Interruption, navigation, reconnects, and restored history.
- Immediate acknowledgement before delegation; full reports remain in the DSH task UI.
- Optional `@flowingspring/dsh-workspace-memory` integration.

## Troubleshooting

- **Missing API key**: verify that `SILICONFLOW_API_KEY` is visible to the DSH process; restart `dsh web` after changing `.env`.
- **Microphone unavailable**: check browser permission and the system input device, and make sure the page is served by `dsh web`.
- **Recognition fails or is slow**: check network access, key validity, SiliconFlow quota, and model/provider latency.

## Links

- [GitHub source and issues](https://github.com/lgquan/dsh-voco)
- [npm package](https://www.npmjs.com/package/@flowingspring/dsh-voco)

## License

[MIT](LICENSE)
