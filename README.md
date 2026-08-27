# dsh-voco

[English](README.en.md) | 中文

像 ChatGPT 高级语音那样，用自然的语音和你的 dsh 编码 Agent 对话——而且不止是聊天，它能真正把活干完。

你开口说一句需求，dsh 立刻用自然口语回应。当你要的是一份「任务」（查代码、跑构建、改文件……），语音前端会把它派给持续复用的后台 Agent Session；完整报告留在任务界面，语音只说专门生成的口语版结果，不朗读报告。

## 交互

- **实时语音对话**：浏览器采集音频，经本地 Silero VAD、流式 Paraformer ONNX 识别，回复使用 Edge TTS 的 Xiaoxiao 中文音色，支持边说边听和打断。
- **对话式派活**：前端只暴露三个编排工具——`realtime_delegation`（把「帮我查一下 xxx」变成真正的后台任务）、`send_task_message`（补充要求 / 纠正方向）、`cancel_task`（取消）。
- **连续任务上下文**：同一语音会话的多次委派复用一个后台 Agent Session，每次任务仍有独立 delegation id。
- **独立口语化结果**：后台 Agent 用 `progress | result | warning | error | question` 事件回报，并在最终 `result.detail` 中提交完整事实；语音层结合用户原话调用独立模型重写，按完整句流式送入页面与 TTS，不设置固定短回复上限。阶段事件仍可用可选 `voiceHint` 即时播报。
- **可恢复的双会话记忆**：停止再启动语音或重启 DSH 后，会恢复来源 Session 的最近对话及其固定后台 Agent Session 绑定；中断任务会告知上次进度，但不会自动重放。
- **不中断的体验**：浏览器切走、断线重连，正在跑的语音会话和后台任务都不会停。

## 安装

```powershell
pnpm install
pnpm build
$repo = (Resolve-Path .).Path
dsh plugin --profile web add "$repo\packages\voice-app" "$repo\packages\voice" "$repo\packages\voice-local" "$repo\packages\voice-assistant" "$repo\packages\voice-web" "$repo\packages\ui-voice"
```

项目名是 `dsh-voco`，内部包统一使用 `@lgquan/*` 命名空间。

`dsh` 命令来自 `npm install -g @deepseek-ai/dsh`。启动 web（voice 界面随之加载）：

```sh
dsh web
```

## 本地语音环境

`pnpm install` 会自动运行跨平台模型安装器，把 Silero VAD 和中文/英文流式 Paraformer 权重下载到 `speech/models`。语音回复使用 Edge TTS 网络服务和 `zh-CN-XiaoxiaoNeural` 音色；`dsh web` 启动时只加载本地 ASR/VAD 模型。安装器可重复执行：`pnpm run setup:voice-local`。

语音运行时完全使用 TypeScript/Node 与预编译 ONNX 原生包，不要求 Python、pip、虚拟环境或 PyTorch。支持 Windows x64，以及 macOS Intel 和 Apple Silicon。

## 限制

- 浏览器麦克风与播放界面面向 dsh Web UI：它由复制而来的 dsh client tsdown 预设构建，并通过 dsh web 运行时的 `window.__ModuleLoader__` 契约加载，因此不是框架无关的浏览器插件。
- Voice Session 记录按「读取时必需」处理的持久 `voice/*` 事件；不带本插件的 dsh 构建加载它们会被拒绝。
