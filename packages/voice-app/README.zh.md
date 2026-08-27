# `@wayneyu430227/dsh-voice-agent`

[English](README.md) | 中文

`dsh-live` 的 `voice` profile patch-layer bundle。它把 provider transport 直接挂到当前来源 Session，并从持久化的 `voice/utterance-end` 事件恢复最近对话。同一来源 Session 的委派持续复用一个普通 Task Agent Session；完整结果保留在任务界面，`COMPLETE` 只承载自适应详略的自然口语回复。root 持有的音频在跳转期间持续运行，浏览器历史索引从侧栏展示已保存的 Voice Session。

## 模型体验

### 语音 profile 组合

#### 模型看到什么

语音发起的工作只以已接受的 `realtime_delegation` 信封与准确 id 更新到达全新 Task Agent。只有该 Task Agent 收到作用域内的 `send_voice_message` 后台工具，用于发送 `STATUS` 与 `COMPLETE`；桥接层直接创建目标，因此不增加 project 列举工具。Duplex frontend Agent 拥有语音对话，只看到自身的三个编排工具。

#### Token 影响

已接受的委派文本、普通任务执行与后台回报调用都会消耗文本模型 token；Duplex 另行花费 provider token 处理语音对话和任务摘要。

#### KV Cache 影响

只有已接受的 command 扩展持续复用的 Task Agent 历史；Voice Session 的最近话语用于恢复新的 Duplex 对话连接。

## 已知限制与后续工作

- 随附的首个 provider 是 Duplex；service seam 与 provider 无关，因此后续可增加 Realtime／Live provider 而不修改 assistant consumer。
- 原始音频仍限于当前进程；新的 provider 连接会从已完成的持久 utterance 文本恢复有界上下文。
- 筛选后的语音历史索引只属于当前浏览器；清除站点数据不会删除底层 Session。
- 浏览器客户端界面面向 dsh Web UI：它由复制而来的 dsh client tsdown 预设构建，并通过 dsh web 运行时的 `window.__ModuleLoader__` 契约加载。服务端包与传输无关，但麦克风／播放 UI 不是独立浏览器插件。
