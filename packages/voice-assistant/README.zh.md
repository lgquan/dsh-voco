# `@lgquan/dsh-voice-assistant`

[English](README.md) | 中文

把一个已连接语音传输绑定到当前持久 Session 的 consumer。在 `speech-shell` 模式下，没有活跃语音任务时，完整转写进入该 Session 的 `followup`；任务运行中则进入 `steer`。在 `frontend-agent` 模式下，转写留在 provider 对话内，只有通过验证的 `TaskCommandCall` 事件会创建或控制文本 Task Agent。

`realtime_delegation` 分配权威 `VoiceTaskId`、确保后台 Task Session 存在，再在线路上以 `delegation_id` 返回该 id。随附 profile 使用 `continuous` 策略：一个来源 Voice Session 创建或恢复一个固定的普通 Task Agent Session；兼容的 `isolated` 策略才会为每次委派新建 Session。Task Agent 继承 Voice Session 的 workspace、工作目录、preset 组合、provider 与 model。它收到的任务消息是 `<realtime_delegation>` 信封，包含 id、自包含输入与可选转写增量；Voice Session 记录带目标 `SessionId` 的 `voice/task-delegated` 供界面跳转。`send_task_message` 通过该 Task Agent 的 `steer` 发送带准确 id 的 `<realtime_delegation_update>`，`cancel_task` 调用该 Agent 的 `cancel({kind:'user'})`。未知、已终止或正在取消的 id 会返回类型化拒绝且不修改 Agent；重复 provider call id 在这个 consumer 运行前由 `dsh-voice` 抑制。

插件只在活跃 Task Agent 的作用域内安装 `send_voice_message` 及其指引。桥接层已经创建准确目标，因此后台工具不提供 project 列举或选择。Agent 用 `progress | result | warning | error | question` 和完整 `detail` 发出结构化事件。阶段事件可以重复；需要立即播报时可带口语化 `voice_hint`，只记录后台轨迹时则省略。最终 `result` 不带 `voice_hint`，只能接纳一次并保留到权威 turn 成功。随后语音层把用户原始请求（含已接受的补充要求）和完整结果交给独立模型重写；长度随请求自适应，不设置固定短回复上限，并按完整句把同一文本流送入语音窗口和 TTS。`question` 把任务置为 `waiting-user`，用户回复后在同一个 Task Agent Session 中开启下一 turn。失败或取消会丢弃已缓冲的 result；成功 turn 没有 result 时会改写最后一条 assistant 文本。缺少重写能力时使用清理后的直接回退，完全没有可用输出时才使用 `completedAnnouncement`。

带标识的任务消息通过 `agent/inbox/claimed` 精确关联 turn，对应的持久 `turn/end` 是任务终止点。每条 `TaskObservation` 都先以 `voice/task-observation` 追加到来源 Session，再交付 provider。Provider 的 ASR 与输出文本生命周期成为持久 utterance start/end 事件；delta 只保留为浏览器实时状态。Provider 的外部文本投影使播报文本进入同一份持久 assistant 历史，并且只在浏览器播放完成后标记为 completed。这些插件拥有的记录按“读取时必需”处理：插件在加载时把这些类型注册进 `KNOWN_SESSION_EVENT_TYPES`，因为 DSH 核心暂时没有可跳过的未知插件事件注册面。Speech-shell 模式为 assistant 输出请求外部文本语音；frontend-agent 模式即时播报可选的阶段提示，并独立重写最终结果。终止映射为：`completed` → completed、`aborted` → cancelled，其余结束原因 → failed。语音断连只解除传输，在任务活跃期间保留 Task Agent 与作用域回报工具，继续完成已验证的 provider command，并为同一进程内的重连有界排队 observation。服务关闭时会把活跃任务持久标记为 `interrupted`；恢复时告知最后一次已播报进度，但绝不自动重放任务。

## 模型体验

### 语音任务观察

#### 模型看到什么

Speech-shell 转写作为人工消息进入 Voice Session Agent。Frontend-agent 工作以人工委派信封进入固定后台 Task Agent，因为其措辞由 provider 模型选择。只有该 Task Agent 收到 `send_voice_message`；语音 Provider 看不到任何 dsh 业务工具 schema。

#### Token 影响

委派信封、普通任务执行与 `send_voice_message` 调用消耗任务模型 token。最终结果的独立口语化重写会额外调用一次当前默认模型；前台直接对话和本地 ASR/TTS 不进入任务模型请求。

#### KV Cache 影响

每条接纳的委派或更新都扩展普通 Task Agent 历史。完整的 `voice/agent-binding-state` 记录让 `continuous` 策略在重启后恢复这段历史；provider 对话状态不改变 Task Agent 可复用的历史。

## 已知限制与后续工作

- 首版每个 Voice Session 只支持一个活跃任务。
- 观察缓冲只在当前进程内跨传输重连保留。持久 utterance、完整 Agent 绑定与中断任务位置可跨重启保留，但 provider 模型进程状态不会重建。
- Voice 事件按“读取时必需”处理。不带本插件的 DSH 构建加载含 `voice/*` 事件的 Session 会被拒绝；安装本插件即在加载时注册类型。上游提供通用插件事件注册面后此耦合即可消除。
