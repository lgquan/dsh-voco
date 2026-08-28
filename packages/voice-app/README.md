# `@flowingspring/dsh-voco`

[![npm version](https://img.shields.io/npm/v/@flowingspring/dsh-voco.svg)](https://www.npmjs.com/package/@flowingspring/dsh-voco)
[![license](https://img.shields.io/npm/l/@flowingspring/dsh-voco.svg)](https://github.com/lgquan/dsh-voco/blob/master/LICENSE)

English | [中文](README.zh.md)

Persistent, interruptible voice conversations for the DSH Web UI. Speak naturally, get an immediate conversational response, and delegate workspace tasks to a durable background Agent Session without losing context.

## Install

```sh
dsh plugin --profile web add @flowingspring/dsh-voco
dsh web
```

Install the DSH CLI first if needed:

```sh
npm install -g @deepseek-ai/dsh
```

## Configure speech recognition

Set a [SiliconFlow](https://siliconflow.cn/) API key in the DSH environment:

```dotenv
SILICONFLOW_API_KEY=your-key
```

The plugin uses `XingChenAGI/XingChenASR-V3.2-Ultra` for cloud speech recognition and Edge TTS with `zh-CN-XiaoxiaoNeural` for speech output. Browser audio is uploaded only after lightweight local speech and silence detection.

## Highlights

- Keeps one background Agent Session bound to each Voice Session, including after DSH restarts.
- Answers ordinary conversation directly and delegates only work that needs tools.
- Speaks a short contextual acknowledgement before starting delegated Agent work.
- Keeps full task reports in the task UI while speaking a concise, purpose-written result.
- Supports interruption, browser navigation, reconnects, and restored conversation history.
- Ships the server and browser surfaces as one public npm package.

## Configuration

The default utterance boundary is 1.5 seconds of continuous silence. Advanced settings such as `silenceDurationMs`, `speechThreshold`, `minSpeechDurationMs`, and `maxUtteranceMs` are available in the plugin profile configuration.

## Requirements and limitations

- The microphone and playback surface targets the DSH Web UI and is not a framework-independent browser plugin.
- Speech recognition requires network access and a SiliconFlow API key.
- Voice responses currently use the Chinese Xiaoxiao Edge TTS voice by default.

Source, development instructions, and issue tracking are available in the [GitHub repository](https://github.com/lgquan/dsh-voco).

## License

[MIT](LICENSE)
