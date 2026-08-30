# dsh-voco 架构说明

本文说明本仓库各个 package 的职责边界和运行关系，供维护者和贡献者使用。用户安装、配置和故障排查请以根目录的 README 为准。

## 项目目标

`dsh-voco` 在不替换 DSH 原有 Session 模型的前提下，增加一个持久化的实时语音界面。语音对话使用普通 DSH Session 保存，并通过 `voice/*` 事件扩展。复杂请求交给另一个持久化 Agent Session 执行，再把结果关联回语音会话。

## Package 边界

| Package | 职责 |
| --- | --- |
| `packages/voice` | 与 Provider 无关的语音能力：会话事件、传输接口和生命周期语义。 |
| `packages/voice-web` | 浏览器与 Host 语音服务之间的 WebSocket 通道。 |
| `packages/voice-local` | SiliconFlow 语音识别和 Edge TTS 语音合成 Provider。 |
| `packages/voice-assistant` | 语音前台路由、带上下文的任务重述、后台 Agent 绑定和口语化结果改写。 |
| `packages/ui-voice` | 浏览器控制器、会话消息/任务卡片、静音状态、语音历史、文字桥接和侧栏标识。 |
| `packages/voice-app` | 发布包入口，把服务端插件和浏览器客户端组合为 `@flowingspring/dsh-voco`。 |

用户只安装 `packages/voice-app`。其他 package 都是 workspace 内部模块，会在构建时打包进公开入口。

## 运行拓扑

```text
浏览器 UI
  |
  | WebSocket（携带 Voice Session ID）
  v
voice-web 通道
  |
  v
voice 能力层 ---- voice-local ---- SiliconFlow ASR / Edge TTS
  |
  +--> voice/* 事件写入来源 DSH Session
  |
  +--> voice-assistant
          |
          +--> 聊天/轻工具：在来源 Session 中直接回答
          |
          +--> 复杂任务：创建或恢复独立 Agent Session
                                      |
                                      +--> 进度/结果事件
                                      |
                                      +--> 口语化改写 + TTS
```

来源 Voice Session 和后台 Agent Session 使用不同的 ID。所有语音委派的 Agent Session 都通过宿主 `parentSession`/`origin: 'subagent'` 作为来源会话的子会话收纳；普通手动文字会话不设置这些字段。后台 Agent 继承来源会话的工作目录，但它本身不是语音会话。

## 输入与路由流程

1. `VoiceControl` 为当前选中的来源 Session 启动语音控制器。第一次点击麦克风进入语音，之后点击同一个按钮切换静音。
2. 浏览器只做轻量音量检测，把语音片段封装为 WAV，通过 `voice-web` 发送。
3. `voice-local` 完成转写。有效文本会作为持久化 Voice utterance 写入来源 Session；纯静音和空转写不会中断正在播放的回复。
4. `voice-assistant` 将语音文本与最近对话、可选 Workspace 记忆组合，选择直接聊天、确定性的轻工具或后台委派。
5. 委派前，前台把省略指代重写成自包含的“当前任务”，并将前置背景和用户原话分开传给后台，避免“你帮我看呀”这类短句失去上下文。
6. 后台结果被改写为一条自然的语音回复并交给 Edge TTS；完整的 Agent 进度和技术细节留在任务界面。

## 会话与任务身份

来源 Session 是用户的主要对话历史。`isolated` 策略为每次委派创建一个子会话；`continuous` 策略在模型一致且上下文压力未知或未达软高水位时复用当前子会话。压力达到 `taskSessionRotationRatio` 或为下一任务保留的 token 预算不足时，在任务边界创建新的空 successor，并注入有限的工作状态交接；不会使用 `SessionStore.fork()` 复制旧历史。每次请求仍拥有独立的 delegation id。绑定关系通过 `voice/task-session-bound` 和 `voice/agent-binding-state` 事件记录，并在重连或重启后恢复最新子会话；旧子会话保留为可导航的历史项。

侧栏语音标识是客户端维护的来源 Session ID 索引。语音成功连接后记录该 ID，因此文字先输入、语音后使用的混合会话仍显示波形图标。后台 Agent Session ID 不会写入来源索引，也不会显示语音图标。委派任务同时持久化 child 到 Voice parent 的轻量关联；当浏览器本地来源索引因刷新或历史重建暂时缺失时，侧栏可据此恢复对应父会话的语音标识和子会话展开入口。没有来源索引或 child 关联的普通 Host 子代理不会被误标为语音会话。

## UI 集成

`packages/ui-voice/src/client/index.ts` 注册以下 DSH UI slots：

- `conversation.input.right`：麦克风按钮和静音切换；AI 播放时额外显示打断播放按钮。
- `shell.overlay`：活动语音状态/控制，以及侧栏语音父会话标识和可折叠子会话装饰器。
- `conversation.chat.node`：语音 utterance 和委派任务卡片。

当前 DSH workspace package 没有提供单条侧栏会话行的扩展 slot，且当前版本将 `origin: 'subagent'` 子会话从顶层列表过滤掉。因此 `VoiceSessionMarkers` 观察 Host 所有的会话行，并通过 React 行 key 精确找到语音父会话，在已有状态区域绘制 Voice 标识和展开按钮；展开后在父行下方绘制缩进的 child rows。child 行保留宿主父子地址导航，并提供转发到 runtime/registry 的重命名、分叉、归档、删除菜单，同时阻断宿主 HoverCard 事件。它不接管普通会话的打开、菜单或排序。

## 持久化与恢复

- DSH Session 历史是 `voice/*` 事件和任务绑定关系的权威来源。
- `VoiceHistoryStore` 只保存一个轻量的浏览器本地索引，用于让客户端识别侧栏中的语音会话。
- 语音控制器支持重连和重试，不会因为网络波动创建新的来源 Session。
- 语音连接期间从输入框提交的纯文字也走语音处理链路；离线文字和带图片的提交继续走 DSH 原生路径。
- 停止语音只释放浏览器传输，不删除来源 Session，也不删除后台 Agent 绑定。

## 配置与运行

发布包随 `dsh web` 加载，不应作为单独的后台服务运行。ASR 密钥配置项是 `SILICONFLOW_API_KEY`，静音和音量阈值在 `packages/voice-app/cordis.patch.yml` 中调整。

仓库根目录常用检查命令：

```powershell
pnpm typecheck
pnpm test
pnpm build
```

## 修改原则

- Provider 相关实现必须留在 `voice` 合约之后，UI 组件不要直接依赖 SiliconFlow 或 Edge TTS 细节。
- 始终把来源 Voice Session 和后台 Agent Session 当作两个独立的身份轴处理。
- 必须跨设备或清除浏览器存储后仍保留的状态，应通过事件或 projection 持久化，而不是只放在浏览器本地。
- README 只记录用户需要的安装和使用信息；package 边界、事件契约或生命周期改变时同步更新本文档。
