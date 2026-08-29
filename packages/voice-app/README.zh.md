# `@flowingspring/dsh-voco`

[![npm version](https://img.shields.io/npm/v/@flowingspring/dsh-voco.svg)](https://www.npmjs.com/package/@flowingspring/dsh-voco)
[![许可证](https://img.shields.io/npm/l/@flowingspring/dsh-voco.svg)](https://github.com/lgquan/dsh-voco/blob/master/LICENSE)

[English](README.md) | 中文

面向 DSH Web UI 的可恢复、可打断语音对话插件。你可以自然说出需求、立即获得口语回复，并把需要工具的工作委派给持续复用的后台 Agent Session，而不会丢失任务上下文。

## 安装

```sh
dsh plugin --profile web add @flowingspring/dsh-voco
dsh web
```

如果尚未安装 DSH 命令行：

```sh
npm install -g @deepseek-ai/dsh
```

## 配置语音识别

在 DSH 的运行环境中设置[硅基流动](https://siliconflow.cn/) API Key：

```dotenv
SILICONFLOW_API_KEY=你的密钥
```

插件使用 `XingChenAGI/XingChenASR-V3.2-Ultra` 完成云端语音识别，并通过 Edge TTS 的 `zh-CN-XiaoxiaoNeural` 音色输出语音。浏览器只在本地做轻量起音和静音检测，确认一句话结束后才上传音频。

## 主要功能

- 每个 Voice Session 持续绑定一个后台 Agent Session，重启 DSH 后也能恢复。
- 普通聊天直接回答，只有需要工具的工作才委派给后台 Agent。
- 委派任务启动前立即播报一句贴合当前请求的简短确认语。
- 完整任务报告保留在任务界面，语音只播报专门生成的简洁结果。
- 支持语音打断、页面切换、断线重连以及历史对话恢复。
- 纯语音会话会根据第一条有效语音请求生成简短标题；标题模型不可用时使用语音转写作为备用。
- 服务端和浏览器界面统一通过一个公开 npm 包发行。

## 配置项

默认以连续静音 1.5 秒作为一句话的边界。`silenceDurationMs`、`speechThreshold`、`minSpeechDurationMs` 和 `maxUtteranceMs` 等高级参数可在插件 profile 配置中调整。

## 要求与限制

- 麦克风和播放界面面向 DSH Web UI，并不是框架无关的浏览器插件。
- 云端语音识别需要网络连接及硅基流动 API Key。
- 语音回复目前默认使用 Edge TTS 的中文晓晓音色。

源码、开发说明和问题反馈请前往 [GitHub 仓库](https://github.com/lgquan/dsh-voco)。

## 许可证

[MIT](LICENSE)
