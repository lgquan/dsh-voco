# `@flowingspring/dsh-voice`

[English](README.md) | 中文

与供应商无关的实时语音能力。`ctx.voice` 选择一个 provider，为持久 Agent `SessionId` 打开临时语音传输、转发 PCM 音频，并提供显式的 `appendTaskObservation(event)` 与 `requestResponse(policy)` 响应边界。Provider 的 ASR 与输出文本事件携带稳定 `VoiceUtteranceId`；生成响应还携带 `VoiceResponseId`，使打断只影响匹配响应。Consumer 记录持久 `voice/utterance-start` 与 `voice/utterance-end` 事件，通过 `voice/task-delegated` 把每个已接受前台委派关联到它的后台 Agent Session，并在交付前把每条 provider 可见观察记录为 `voice/task-observation`；consumer 可以在多次委派之间复用该 Agent Session。浏览器意外断开时，准确的 provider 对话会在可配置的 `reconnectGraceMs` 内保留；provider 任务 command 仍可交付，观察则排队等待重新挂接。显式关闭、provider 关闭或宽限期到期后才会释放。两种生命周期都不会销毁任一 Session 的 Agent。

## 模型体验

### 转写后的 Agent 输入

#### 模型看到什么

在 speech-shell 模式下，任务模型把转写看作普通的带标识用户消息。在 frontend-agent 模式下，provider 可以发出 `route_transcription`，由 consumer 直接回答普通对话，或把需要工具的工作接纳为委派。绑定的后台 Task Agent 只看到已接受且与 `VoiceTaskId` 关联的 `realtime_delegation` 信封与准确 id 更新；只有 Task Agent 拥有作用域内的后台回报工具。

#### Token 影响

只有任务 Agent 接纳的文本、正常执行以及后台回报工具调用消耗任务模型 token。

#### KV Cache 影响

接纳的文本像键入输入一样扩展历史；provider 语音和前台 schema 不增加任务模型请求前缀。

## 已知限制与后续工作

- 首版协议只支持一种自动响应策略和 PCM 16 位有符号小端音频。
- 随附 profile 使用本地 provider。已完成或打断的文本持久保存，但原始音频与本地模型进程状态不会在进程重启后重建。
