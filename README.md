# dsh-live

[English](README.en.md) | 中文

像 ChatGPT 高级语音那样，用自然的语音和你的 dsh 编码 Agent 对话——而且不止是聊天，它能真正把活干完。

你开口说一句需求，dsh 立刻用自然口语回应。当你要的是一份「任务」（查代码、跑构建、改文件……），语音前端会把它派给持续复用的后台 Agent Session；完整报告留在任务界面，语音只说专门生成的口语版结果，不朗读报告。

## 交互

- **全双工实时对话**：基于 ByteDance Duplex，像和人说话一样自然，边说边听、随时打断、随时插话纠正。
- **对话式派活**：前端只暴露三个编排工具——`realtime_delegation`（把「帮我查一下 xxx」变成真正的后台任务）、`send_task_message`（补充要求 / 纠正方向）、`cancel_task`（取消）。
- **连续任务上下文**：同一语音会话的多次委派复用一个后台 Agent Session，每次任务仍有独立 delegation id。
- **异步结果回灌**：进度（STATUS）和口语结果（COMPLETE）会回灌进语音对话；回复按问题复杂度自适应详略，不设固定字数上限。
- **可恢复的对话记忆**：停止再启动语音或重启 DSH 后，从源 Session 恢复最近完成的用户与助手话语。
- **不中断的体验**：浏览器切走、断线重连，正在跑的语音会话和后台任务都不会停。

## 安装

```powershell
pnpm install
pnpm build
$repo = (Resolve-Path .).Path
dsh plugin --profile web add "$repo\packages\voice-app" "$repo\packages\voice" "$repo\packages\voice-duplex" "$repo\packages\voice-assistant" "$repo\packages\voice-web" "$repo\packages\ui-voice"
```

仓库名是 `dsh-live`；内部 `@wayneyu430227/*` 包名暂时保留，用来兼容并替换现有 DSH profile，无需迁移用户配置。

`dsh` 命令来自 `npm install -g @deepseek-ai/dsh`。启动 web（voice 界面随之加载）：

```sh
dsh web
```

## 凭据

Duplex provider 从环境读取两个凭据引用：

- `DUPLEX_API_KEY` —— ByteDance 火山引擎 access key。
- `DUPLEX_APP_KEY` —— 对应的 app key。

开始语音对话前需设置两者；缺少时 provider 会话握手失败。

## 限制

- 浏览器麦克风与播放界面面向 dsh Web UI：它由复制而来的 dsh client tsdown 预设构建，并通过 dsh web 运行时的 `window.__ModuleLoader__` 契约加载，因此不是框架无关的浏览器插件。
- Voice Session 记录按「读取时必需」处理的持久 `voice/*` 事件；不带本插件的 dsh 构建加载它们会被拒绝。
