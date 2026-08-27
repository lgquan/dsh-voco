# `@lgquan/dsh-voice-assistant`

[English](README.md) | 中文

把一个已连接语音传输绑定到当前持久 Session 的 consumer。在 `speech-shell` 模式下，没有活跃语音任务时，完整转写进入该 Session 的 `followup`；任务运行中则进入 `steer`。在 `frontend-agent` 模式下，转写留在 provider 对话内，只有通过验证的 `TaskCommandCall` 事件会创建或控制文本 Task Agent。

`realtime_delegation` 分配权威 `VoiceTaskId` 和全新的普通 Task Session，再在线路上以 `delegation_id` 返回该 id。Task Agent 继承 Voice Session 的 workspace、工作目录、preset 组合、provider 与 model。它的第一条用户消息是 `<realtime_delegation>` 信封，包含 id、自包含输入与可选转写增量；Voice Session 记录带目标 `SessionId` 的 `voice/task-delegated` 供界面跳转。`send_task_message` 通过该 Task Agent 的 `steer` 发送带准确 id 的 `<realtime_delegation_update>`，`cancel_task` 调用该 Agent 的 `cancel({kind:'user'})`。未知、已终止或正在取消的 id 会返回类型化拒绝且不修改 Agent；重复 provider call id 在这个 consumer 运行前由 `dsh-voice` 抑制。

插件只在活跃 Task Agent 的作用域内安装 `send_voice_message` 及其指引。桥接层已经创建准确目标，因此后台工具不提供 project 列举或选择。`STATUS` 消息可以重复，会写入记录并交付 provider，但不请求语音。`COMPLETE` 只能接纳一次，并保留到权威 turn 成功；completed、failed 与 cancelled observation 会使用准确的后台文本请求 provider 语音。失败或取消会丢弃已缓冲的 COMPLETE。成功 turn 没有调用 `COMPLETE` 时，桥接层依次回退到最后一条 assistant 文本与 `completedAnnouncement`。

带标识的任务消息通过 `agent/inbox/claimed` 精确关联 turn，对应的持久 `turn/end` 是任务终止点。每条 `TaskObservation` 都先以 `voice/task-observation` 追加到来源 Session，再交付 provider。Provider 的 ASR 与输出文本生命周期成为持久 utterance start/end 事件；delta 只保留为浏览器实时状态。Duplex 的外部文本投影使终态语音文本进入同一份持久 assistant 历史。这些插件拥有的记录按“读取时必需”处理：插件在加载时把这些类型注册进 `KNOWN_SESSION_EVENT_TYPES`，因为 DSH 核心暂时没有可跳过的未知插件事件注册面。Speech-shell 模式为 assistant 输出请求外部文本语音，frontend-agent 模式只为终态 observation 请求准确的 provider 语音。终止映射为：`completed` → completed、`aborted` → cancelled，其余结束原因 → failed。语音断连只解除传输，在任务活跃期间保留 Task Agent 与作用域回报工具，继续完成已验证的 provider command，并为同一进程内的重连有界排队 observation；只积累 STATUS 时重连仍保持静默。

## 模型体验

### 语音任务观察

#### 模型看到什么

Speech-shell 转写作为人工消息进入 Voice Session Agent。Frontend-agent 工作以人工委派信封进入全新 Task Agent，因为其措辞由 provider 模型选择。只有该 Task Agent 收到 `send_voice_message`；Duplex Agent 仍看不到任何 dsh 业务工具 schema。

#### Token 影响

委派信封、普通任务执行与 `send_voice_message` 调用消耗任务模型 token。前台直接对话与观察播报都在任务模型请求之外。

#### KV Cache 影响

每条接纳的委派或更新都扩展普通 Task Agent 历史。作用域工具 schema 与指引只在独立任务活跃时存在；provider 对话状态不改变 Task Agent 可复用的历史。

## 已知限制与后续工作

- 首版每个 Voice Session 只支持一个活跃任务。
- 观察缓冲只在当前进程内跨传输重连保留。持久 utterance 与任务链接可跨重启保留，但 provider 对话不会重建。
- Voice 事件按“读取时必需”处理。不带本插件的 DSH 构建加载含 `voice/*` 事件的 Session 会被拒绝；安装本插件即在加载时注册类型。上游提供通用插件事件注册面后此耦合即可消除。
