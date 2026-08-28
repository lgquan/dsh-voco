# dsh-voco

[English](README.en.md) | 中文

像 ChatGPT 高级语音那样，用自然的语音和你的 dsh 编码 Agent 对话——而且不止是聊天，它能真正把活干完。

你开口说一句需求，dsh 立刻用自然口语回应。当你要的是一份「任务」（查代码、跑构建、改文件……），语音前端会把它派给持续复用的后台 Agent Session；完整报告留在任务界面，语音只说专门生成的口语版结果，不朗读报告。

## 交互

- **云端语音识别**：浏览器采集音频，本地只做轻量音量检测；连续静音 3 秒后把当前语句封装为 WAV，交给硅基流动 `XingChenAGI/XingChenASR-V3.2-Ultra` 转写。回复使用 Edge TTS 的 Xiaoxiao 中文音色，支持边说边听和打断。
- **即时确认再派活**：云端 ASR 返回文字后，由轻量前台模型判断意图；寒暄和无需工具的问题直接回答，需要读取或修改项目、运行命令等工作时则先生成一句简短确认语立即播报，再通过 `realtime_delegation` 进入固定后台 Agent。
- **连续任务上下文**：同一语音会话的多次委派复用一个后台 Agent Session，每次任务仍有独立 delegation id。
- **独立口语化结果**：后台 Agent 用 `progress | result | warning | error | question` 事件和唯一的 `detail` 字段提交完整事实；语音层结合用户原话调用独立模型重写，并把整段回复作为一条页面消息和一次 TTS 响应。Edge TTS 内部仍按句合成，但不会拆成多个气泡。
- **可恢复的双会话记忆**：停止再启动语音或重启 DSH 后，会恢复来源 Session 的最近对话及其固定后台 Agent Session 绑定；中断任务会告知上次进度，但不会自动重放。
- **不中断的体验**：浏览器切走、断线重连，正在跑的语音会话和后台任务都不会停。

## 安装

```powershell
pnpm install
pnpm build
$repo = (Resolve-Path .).Path
dsh plugin --profile web add "$repo\packages\voice-app"
```

对外安装入口是 `@flowingspring/dsh-voco`，源码位于 `packages/voice-app`；其余 workspace 只是内部开发模块，其服务端入口和浏览器界面都会打包进 `@flowingspring/dsh-voco`，不会作为用户插件安装。

发布包只需要安装这一个包：

```powershell
dsh plugin --profile web add @flowingspring/dsh-voco
```

如果从源码开发，仍可使用上面的本地路径安装方式；这不会改变最终发行包的单包结构。

`dsh` 命令来自 `npm install -g @deepseek-ai/dsh`。启动 web（voice 界面随之加载）：

```sh
dsh web
```

## 语音环境

在项目根目录创建 `.env`，配置硅基流动 API Key：

```dotenv
SILICONFLOW_API_KEY=你的密钥
```

`.env` 已被 Git 忽略。默认连续静音 `1500ms` 后上传一句话，且需要至少 `250ms` 的有效音量才会确认起音；可在 `packages/voice-app/cordis.patch.yml` 中调整 `silenceDurationMs`、`speechThreshold`、`minSpeechDurationMs` 和 `maxUtteranceMs`。本地不再下载或加载 ASR/VAD 模型，也不要求 Python、pip、PyTorch 或 ONNX；语音回复继续使用 Edge TTS 和 `zh-CN-XiaoxiaoNeural` 音色。

语音连接在线时，从当前会话输入框手动提交的纯文本也会作为一次语音输入处理：页面显示同一条用户消息，回复继续进入口语化文本流并由 Edge TTS 播放。语音离线或消息带图片时仍使用 Harness 原生文字提交路径。

## 限制

- 浏览器麦克风与播放界面面向 dsh Web UI：它由复制而来的 dsh client tsdown 预设构建，并通过 dsh web 运行时的 `window.__ModuleLoader__` 契约加载，因此不是框架无关的浏览器插件。
- Voice Session 记录按「读取时必需」处理的持久 `voice/*` 事件；不带本插件的 dsh 构建加载它们会被拒绝。
