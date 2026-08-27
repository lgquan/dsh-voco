# `@lgquan/dsh-voice-agent`

[English](README.md) | 中文

`dsh-voco` 的 `voice` profile patch-layer bundle。它把 provider transport 直接挂到当前来源 Session，并从持久化的 `voice/utterance-end` 事件恢复最近对话。轻量前台模型直接回答普通对话，只委派需要工具的工作。同一来源 Session 的委派持续复用并持久绑定一个普通 Task Agent Session；`voice/agent-binding-state` 保存语音会话、后台 Agent、工作区、最后任务、最近使用时间和状态，服务重启后优先从该记录恢复，并兼容旧的 `voice/task-session-bound`。完整结果和进度保留在任务界面；独立模型结合用户原话重写最终结果以及需要用户处理的问题或警告。进度只显示在折叠任务详情中，不会额外创建语音消息或 TTS 请求。后台 Agent 不能直接指定播报文本。root 持有的音频在跳转期间持续运行，浏览器历史索引从侧栏展示已保存的 Voice Session。

## 模型体验

### 语音 profile 组合

#### 模型看到什么

语音发起的工作只以已接受的 `realtime_delegation` 信封与准确 id 更新到达来源 Session 所绑定的固定后台 Task Agent。只有该 Task Agent 收到作用域内的 `send_voice_message` 后台工具，用于发送结构化的 `progress | result | warning | error | question` 事件；桥接层直接创建或恢复准确目标，因此不增加 project 列举工具。本地 provider 负责语音输入输出，桥接层只暴露任务编排工具。

#### Token 影响

每个新的前台话语会消耗一次轻量模型路由调用。被委派的工作还会消耗任务执行、后台回报和辅助事件改写的模型 token；本地 VAD、ASR、TTS 不产生按分钟的语音 API 费用。

#### KV Cache 影响

只有已接受的 command 扩展持续复用的 Task Agent 历史。持久绑定状态会在重启后恢复同一个 Agent Session；Voice Session 的最近话语用于恢复本地语音对话。

## 已知限制与后续工作

- 随附的 provider 是本地 CPU 语音；service seam 保证 assistant consumer 不依赖模型细节。
- 原始音频仍限于当前进程；新的 provider 连接会从已完成的持久 utterance 文本恢复有界上下文。
- 服务停止时，活跃任务会持久标记为 `interrupted`。恢复时只告知最后一次已播报进度，不会自动重放任务或任何有副作用的命令。
- 筛选后的语音历史索引只属于当前浏览器；清除站点数据不会删除底层 Session。
- 浏览器客户端界面面向 dsh Web UI：它由复制而来的 dsh client tsdown 预设构建，并通过 dsh web 运行时的 `window.__ModuleLoader__` 契约加载。服务端包与传输无关，但麦克风／播放 UI 不是独立浏览器插件。
