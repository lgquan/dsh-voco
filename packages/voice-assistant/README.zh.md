# `@flowingspring/dsh-voice-assistant`

[English](README.md) | 中文

把一个已连接语音传输绑定到当前持久 Session 的 consumer。在 `speech-shell` 模式下，没有活跃语音任务时，完整转写进入该 Session 的 `followup`；任务运行中则进入 `steer`。在 `frontend-agent` 模式下，`route_transcription` 会把最近的持久语音对话和当前转写交给所选前台模型，并返回 `chat | tool | delegate` 三类结构化决策。普通对话直接回答；当前日期、时间和星期由 `local_datetime` 读取本机系统时钟；复杂工作则在同一次路由调用中完成上下文消歧、任务重述和简短确认，不增加额外模型调用。任务活跃期间，后续转写会更新同一个任务。

`realtime_delegation` 分配权威 `VoiceTaskId` 并确保后台 Task Session 存在。随附 profile 使用 `continuous` 策略：一个来源 Voice Session 创建或恢复一个固定的普通 Task Agent Session；兼容的 `isolated` 策略才会为每次委派新建 Session。Task Agent 继承 Voice Session 的 workspace、工作目录、preset 组合、provider 与 model。经前台路由的后台窗口收到明确分隔的“当前任务 / 前置背景 / 用户原话”；当前任务是唯一执行指令，背景只用于理解和消歧，用户原话始终取真实转写而不信任模型生成值。直接 `realtime_delegation` 仍兼容自然语言任务正文和可选转写增量。内部任务 id 不进入消息正文或会话标题。Voice Session 仍记录带目标 `SessionId` 的 `voice/task-delegated` 供界面跳转。`send_task_message` 通过该 Task Agent 的 `steer` 发送自然语言补充要求，`cancel_task` 调用该 Agent 的 `cancel({kind:'user'})`。未知、已终止或正在取消的 id 会返回类型化拒绝且不修改 Agent；重复 provider call id 在这个 consumer 运行前由 `dsh-voice` 抑制。

插件只在活跃 Task Agent 的作用域内安装 `send_voice_message` 及其指引。桥接层已经创建准确目标，因此后台工具不提供 project 列举或选择。Agent 用 `progress | result | warning | error | question` 和唯一的完整事实字段 `detail` 发出结构化事件；工具不接受 Agent 直接编写的播报字段。阶段事件可在确有意义时重复，最终 `result` 只能接纳一次并保留到权威 turn 成功。对每个回报事件，语音层都会把用户原始请求（含已接受的补充要求）、事件类型和完整细节交给独立模型重写。阶段说明保持简洁，最终回复长度随请求自适应且没有固定短回复上限。每个重写事件只生成一条完整页面消息和一次 TTS 响应；Edge TTS 内部仍可按句合成，但不会显示成多个气泡。`question` 把任务置为 `waiting-user`，用户回复后在同一个 Task Agent Session 中开启下一 turn。失败或取消会丢弃已缓冲的 result；成功 turn 没有 result 时会改写最后一条 assistant 文本。缺少重写能力时使用安全的直接回退，完全没有可用输出时才使用 `completedAnnouncement`。

带标识的任务消息通过 `agent/inbox/claimed` 精确关联 turn，对应的持久 `turn/end` 是任务终止点。每条 `TaskObservation` 都先以 `voice/task-observation` 追加到来源 Session，再交付 provider。Provider 的 ASR 与输出文本生命周期成为持久 utterance start/end 事件；delta 只保留为浏览器实时状态。Provider 的外部文本投影使播报文本进入同一份持久 assistant 历史，并且只在浏览器播放完成后标记为 completed。这些插件拥有的记录按“读取时必需”处理：插件在加载时把这些类型注册进 `KNOWN_SESSION_EVENT_TYPES`，因为 DSH 核心暂时没有可跳过的未知插件事件注册面。Speech-shell 模式为 assistant 输出请求外部文本语音；frontend-agent 模式独立重写已报告的阶段事件和最终结果。终止映射为：`completed` → completed、`aborted` → cancelled，其余结束原因 → failed。语音断连只解除传输，在任务活跃期间保留 Task Agent 与作用域回报工具，继续完成已验证的 provider command，并为同一进程内的重连有界排队 observation。服务关闭时会把活跃任务持久标记为 `interrupted`；恢复时告知最后一次已播报进度，但绝不自动重放任务。

## 模型体验

### 语音任务观察

#### 模型看到什么

Speech-shell 转写作为人工消息进入 Voice Session Agent。Frontend-agent 路由模型看到最近对话和当前原话；`chat` 直接返回回复，`tool` 只能选择公开的轻量能力，`delegate` 则输出任务和背景。固定后台 Task Agent 收到由服务端按结构化字段组装的人工消息。只有该 Task Agent 收到 `send_voice_message`；工具在服务端自动绑定当前活动任务，模型不需要看到或提交内部任务 id，语音 Provider 也看不到任何 dsh 业务工具 schema。

#### Token 影响

每个新的前台话语会进行一次轻量路由调用；普通对话在这一次调用内直接完成，本机日期时间由确定性工具直接回答，两者都不创建后台 Agent 任务。委派工作还会消耗任务执行 token，并为每个已报告事件增加一次辅助改写调用。本地 ASR/TTS 和本机时间工具不消耗模型 token。

#### KV Cache 影响

每条接纳的委派或更新都扩展普通 Task Agent 历史。完整的 `voice/agent-binding-state` 记录让 `continuous` 策略在重启后恢复这段历史；provider 对话状态不改变 Task Agent 可复用的历史。

## 已知限制与后续工作

- 首版每个 Voice Session 只支持一个活跃任务。
- 观察缓冲只在当前进程内跨传输重连保留。持久 utterance、完整 Agent 绑定与中断任务位置可跨重启保留，但 provider 模型进程状态不会重建。
- Voice 事件按“读取时必需”处理。不带本插件的 DSH 构建加载含 `voice/*` 事件的 Session 会被拒绝；安装本插件即在加载时注册类型。上游提供通用插件事件注册面后此耦合即可消除。
