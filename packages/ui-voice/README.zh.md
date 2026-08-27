# `@lgquan/dsh-client-ui-voice`

[English](README.md) | 中文

`voice` profile 的浏览器对话界面。麦克风按钮把 Voice Mode 挂接到当前持久 Session；这个来源 Session 就是可恢复的语音会话窗口，新建普通 Session 才会得到新的语音会话身份。root 持有的 `/voice` WebSocket 让用户跳转查看委派任务时仍能继续采集和播放。只有服务端 `ready` 帧确认 provider session 与音频配置后才开始采集。该包采集带回声消除的音频，将其重采样为 16 kHz PCM，调度返回的 MP3 音频，并在新转写开始时立即停止待播放音频。Provider 错误或终止关闭会释放 WebSocket、麦克风 track、播放 source 与音频 context。

持久 ASR 和 TTS utterance 以带 Voice 标识的聊天消息展示。每次实时 ASR update 会替换上一版中间字幕；送入 TTS 的同一份文本会实时投影到开放的 assistant utterance，播放完成后持久化为 completed，中途打断则持久化为 interrupted。每个委派任务显示为默认折叠的紧凑状态卡，可展开摘要、取消活跃任务，并跳转到固定后台 Agent Session 查看完整过程。

Voice transport 成功打开后，插件会把来源 Session 记录到浏览器本地历史索引。侧栏底部的语音历史入口列出仍存在于普通 Session 目录中的记录，标识当前通话，并可打开已保存的 Session；Host 投影与 Workspace 行无需增加 Voice 字段。Session log 仍是持久对话记录，索引只保存 Session id 和本地最近使用时间。

## 模型体验

### 语音文本与委派控制

#### 模型看到什么

浏览器包不贡献模型可见文本，只投影 Host 记录的 `voice/utterance-*`、`voice/task-delegated` 和 `voice/task-observation` 事件；进入模型上下文的内容由 Voice assistant 和 Task Agent 各自负责。

#### Token 影响

浏览器包直接增加零 token；只有 Host 接纳的转写和 Agent 回复消耗模型 token。

#### KV Cache 影响

浏览器控件不编辑或重排模型上下文。跳转到委派任务只改变当前 UI Session；活跃语音 transport 仍绑定来源 Session。

## 已知限制与后续工作

- 采集使用 `AudioWorkletNode`；不支持 AudioWorklet 的浏览器无法启动语音模式。
- 实时转写 update 是临时状态；刷新后从持久 Session log 重建已完成或已打断的 utterance。
- 语音历史索引只属于当前浏览器 profile。清除站点数据或使用其他浏览器会移除筛选索引，但不会删除底层 DSH Session。
- Socket 意外断开后进入显式重试状态；在 Host 重连宽限期内重试会恢复同一 provider 对话，停止则最终关闭。
- 本包面向 dsh Web UI：其浏览器 bundle 将平台模块表作为外部依赖，并通过 `window.__ModuleLoader__` 加载，因此依赖 dsh web 运行时，而非框架无关的客户端插件。
