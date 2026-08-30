# dsh-voco 按住说话（PTT）实施方案

## 方案信息

- 编写日期：2026-08-31
- 适用版本：`@flowingspring/dsh-voco` 0.3.8 及后续版本
- 目标：在现有话筒按钮上增加鼠标/触摸长按的 Push-to-Talk（PTT，按住说话）操作
- 非目标：桌面级悬浮窗口、独立原生客户端、修改 DSH 原厂代码
- 发布策略：先使用本地源码链接验证，再发布 npm 版本

## 1. 背景与现状

当前语音链路已经完整存在：浏览器采集麦克风 PCM，经 `/voice` WebSocket 发送到 `voice-local`，完成 VAD、SiliconFlow ASR、语音助手路由和 Edge TTS 播报。

当前话筒按钮的行为是：

1. 未连接时单击，创建或连接当前 Voice Session。
2. 已连接时单击，在静音和持续监听之间切换。
3. 静音时客户端发送 `audio.commit`，服务端结束当前语音片段并触发识别。

相关实现位置：

- 按钮交互：[packages/ui-voice/src/client/VoiceControl.tsx](../packages/ui-voice/src/client/VoiceControl.tsx)
- 浏览器录音和 WebSocket：[packages/ui-voice/src/client/voice-controller.ts](../packages/ui-voice/src/client/voice-controller.ts)
- WebSocket 控制帧：[packages/voice-web/src/index.ts](../packages/voice-web/src/index.ts)
- VAD 和提交：[packages/voice-local/src/node-backend.ts](../packages/voice-local/src/node-backend.ts)

当前 `NodeSpeechBackend` 会在约 1.5 秒静音后自动结束语音片段。因此，仅在前端把 `pointerdown` 映射为解除静音、把 `pointerup` 映射为静音，不能严格保证“松开之前绝不发送”。

## 2. 用户可见行为

### 2.1 保留的单击行为

- 未连接时单击：仍然连接语音会话。
- 已连接时短按：仍然执行原有静音/解除静音。
- 结束按钮、播放打断、重连和文字输入行为不改变。

### 2.2 新增的长按行为

- 长按判定阈值：默认 400 ms，实际值通过测试调整到 350 至 500 ms 的舒适范围。
- 达到阈值后，按钮进入“按住说话”状态并显示按下视觉反馈。
- 达到长按阈值后进入独立的 PTT 片段；进入时清理免提模式中尚未提交的残留片段，避免两种模式的音频混在一起。
- 松开、触摸取消、窗口失焦或页面隐藏时，提交当前片段。
- `audio.commit` 发出后立即恢复输入目标状态；连接继续保留用于接收和播报本次回复，不能在松手时立即断开连接。
- 按住时间过短或没有达到最小有效语音时，不产生空语音消息。

### 2.3 各语音状态下的长按

长按在所有语音相关状态下都保持同一套用户语义；底层根据状态处理连接和收尾：

| 当前状态 | 长按行为 |
| --- | --- |
| 未连接 | 启动连接并记录 pending PTT；连接完成且仍在按住时开始采集，松手后提交并立即静音；连接保留用于接收回复。 |
| 正在连接 | 保持 pending PTT；连接尚未完成就松手时取消本次发送，不产生语音消息。 |
| 已连接、未静音 | 临时切入严格 PTT，松手提交后立即恢复未静音。 |
| 已连接、已静音 | 临时打开麦克风进入 PTT，松手提交后立即恢复静音。 |
| 正在播放回复 | 允许长按采集新语音；本次转写完成后沿用现有逻辑打断当前回复。 |
| 连接错误 | 长按触发重试并记录 pending PTT；重试成功后仍按住才采集，松手则取消。 |

未连接、正在连接和错误重试都需要由 `VoiceController` 持有 pending PTT，而不能只保存在 React 按钮实例中。连接完成后，如果指针仍被按住则发送 PTT 开始信号；如果已经松手则只完成连接，不提交空语音。未连接状态建立的临时连接不能在松手后立即关闭，否则无法接收本次助手的语音回复；应在提交后立即设置为静音并保持连接直到回复链路结束。

## 3. 推荐技术方案：临时严格 PTT 模式

本方案保留当前“连接后免提监听”的默认行为，长按只是临时切入严格 PTT 片段。它与“连接后全程静音、只有长按才采集”的全局 PTT 模式不同，后者会改变现有单击后的用户体验，不在本次范围内。未连接状态的长按通过 pending PTT 衔接到连接完成后的临时片段；连接成功时仍按原有规则进入免提，但这一条一次性 PTT 在提交后会立即把麦克风设为静音，避免回复生成期间继续后台收音。

### 3.1 状态模型

在 `VoiceController` 中增加 PTT 生命周期，不把它简单等同于普通静音：

```text
off / connecting / error
        |
        v
hands-free  <---->  muted
        |
        +---- pointerdown + threshold ----> push-to-talk
                                             |
                                             +---- pointerup/cancel ----> previous mode
```

建议增加以下内部状态：

- `pushToTalkActive`：是否正在长按采集。
- 长按阈值由 `VoiceControl` 的计时器统一控制；后端仍使用最小有效语音时长和空片段检查，避免为一次性手势增加额外时间戳状态。
- `pushToTalkPending`：连接或重试尚未完成时，是否仍有长按发送意图。
- `pushToTalkOrigin`：长按开始前的来源状态，取值为 `off`、`hands-free` 或 `muted`，用于决定提交后的立即恢复动作；`off` 来源提交后恢复为已连接但静音。

PTT 状态应由共享的 `VoiceController` 持有，而不是只存在某一个 React 按钮实例中，避免切换会话或页面局部重渲染时丢失释放动作。

### 3.2 前端手势层

在 `VoiceControl.tsx` 中使用 Pointer Events：

- `onPointerDown`：记录指针、启动长按计时器，并调用 `setPointerCapture`；未连接或错误状态下同时建立 pending PTT 意图。
- 计时器达到阈值：调用 `beginPushToTalk()`，阻止后续 click 被当作普通静音切换。
- `onPointerUp`：如果 PTT 已开始则调用 `endPushToTalk()`；如果仍在连接则清除 pending 意图；随后释放指针捕获并清理计时器。未连接来源的连接继续保留到回复播报完成，但输入在提交后立即静音。
- `onPointerCancel`、`onLostPointerCapture`：按释放处理，避免麦克风永久保持开启。
- `onClick`：只有未被判定为长按时，才执行现有的连接/静音切换。
- 增加 `touch-action` 配置，避免触摸长按被浏览器手势抢占。

React 组件只负责手势和视觉状态；音频提交、重复调用保护和连接竞态由 `VoiceController` 负责。

### 3.3 浏览器到服务端的控制协议

为了禁止 PTT 期间的 VAD 提前提交，增加两个可选控制帧：

```json
{ "type": "audio.push-to-talk.start" }
{ "type": "audio.commit" }
```

其中：

- `audio.push-to-talk.start`：服务端进入手动采集模式，并清理进入 PTT 前尚未完成的自动片段，避免免提模式残留音频混入本次 PTT。
- 二进制 PCM 帧：继续使用现有格式和采样率发送。
- `audio.commit`：沿用现有语义，结束 PTT 片段并进入 ASR。

未连接来源的 PTT 在 `audio.commit` 后不能立即调用 `session.close`。控制器应立即把输入设置为静音，同时保持连接接收回复；不能等待播放完成才静音，否则回复生成期间仍会继续收音。

现有 `setInputMuted(true)` 从非静音切到静音时会附带发送 `audio.commit`。PTT 结束流程需要提供不重复提交的内部路径（例如独立的 `commitAudio()` 与“只切换 track 状态”的 restore 方法），避免松手时发送两次 commit。

客户端和服务端必须同时来自同一 dsh-voco bundle。旧服务端遇到未知控制帧会明确关闭连接，因此不能把该帧视为天然兼容；如果未来需要新旧 bundle 混装，应先增加 `ready` capability 协商，再决定是否启用 PTT。

### 3.4 `voice-local` 后端

在 `NodeSpeechBackend` 增加手动采集状态：

- `beginManualUtterance()`：进入 PTT 模式，清理当前未提交的 active utterance 和 pre-roll。
- `appendAudio()`：PTT 模式下继续接收 PCM，但不根据静音时长调用 `finishUtterance()`。
- `commitAudio()`：PTT 模式下结束当前片段，执行现有最小时长、空片段和 ASR 队列检查，然后退出 PTT 模式。
- 仍保留最大语音时长上限，防止用户一直按住造成无限缓存。
- 连接关闭、异常和取消时，必须清理 PTT 状态。

`voice-web` 只负责校验控制帧并转发到 Voice provider；不复制 VAD 或 ASR 逻辑。

### 3.5 提前提交的影响

严格禁止 PTT 期间的 VAD 自动提交是正确性要求，不只是分句体验问题。当前 `LocalSession` 在 `transcription.completed` 后会调用 `interruptResponse()`；如果长按中的停顿触发了 VAD 自动结束，可能会提前转写并打断正在播放的助手回复。PTT 模式必须覆盖该路径，确保只有松开产生的 `audio.commit` 才触发本次识别。

## 4. 备选方案：纯前端轻量版

如果产品可以接受长时间停顿时被 VAD 自动分成多段，可以不增加新的控制帧：

- 长按开始时解除静音。
- 松开时设置静音，复用已有 `audio.commit`。

这个版本改动最少，但它不是严格 PTT：用户在长按期间停顿超过当前 `silenceDurationMs` 仍可能提前识别。该限制必须在界面说明、测试记录和发布说明中明确，不能把它描述成“松开才发送”。

本方案推荐采用第 3 节的严格 PTT 版本作为正式实现，纯前端版本只适合快速交互验证。

## 5. 具体改动范围

### 必改文件

- `packages/ui-voice/src/client/VoiceControl.tsx`
  - Pointer Events、长按判定、click 抑制、释放兜底。
- `packages/ui-voice/src/client/voice-controller.ts`
  - PTT 状态、开始/结束方法、连接和 teardown 竞态处理。
- `packages/voice-web/src/index.ts`
  - 新增 PTT start 控制帧的校验和转发。
- `packages/voice-local/src/session.ts`
  - 向 `SpeechBackend` 暴露手动采集开始语义。
- `packages/voice-local/src/speech-backend.ts`
  - 扩展 provider/backend 合约。
- `packages/voice-local/src/node-backend.ts`
  - 实现手动采集模式并保持最大时长保护。
- `packages/ui-voice/src/client/locales.ts`
  - 增加“按住说话中”、错误和无效短片段等界面文案。
- `packages/ui-voice/src/client/VoiceControl.module.css`
  - 增加按住状态视觉反馈，不改变现有按钮尺寸和布局。

### 可能需要同步的文件

- `packages/voice/src/types.ts`：只有在把 PTT 语义提升为跨 provider 的公共 Voice 合约时才修改。
- `docs/ARCHITECTURE.md`：实现完成后补充 PTT 输入流程和控制帧说明。
- `README.md`、`README.en.md`：实现并验收后补充用户操作说明。

不修改：悬浮层 `VoiceOverlay`、设置页、API Key 存储、会话模型和 DSH 原厂包。

## 6. 实施阶段

### 阶段一：合约和状态设计

1. 明确所有语音状态下的严格 PTT 语义和短按兼容规则。
2. 扩展 `SpeechBackend`、`LocalSession` 和 `voice-web` 控制帧。
3. 设计 pending PTT 的连接、重试、松手和取消状态转换。
4. 先为后端手动采集模式写失败测试。

### 阶段二：后端实现

1. 实现 `beginManualUtterance()` 和 PTT 期间禁止静音自动提交。
2. 保留最小语音时长、最大语音时长、空片段和关闭清理逻辑。
3. 增加控制帧解析、未知帧拒绝和旧路径回归测试。

### 阶段三：前端手势实现

1. 增加长按计时器和 Pointer Capture。
2. 实现 click 与 long press 的互斥。
3. 接入 `VoiceController` 的 PTT 生命周期。
4. 增加按住、取消、失焦和异常状态视觉反馈。

### 阶段四：自动化验证

执行：

```powershell
pnpm typecheck
pnpm test
pnpm build
```

重点测试：

- 短按只触发原有逻辑，长按不额外触发 click。
- 未连接、连接中和错误重试时长按可以等待连接完成；提前松手不会产生空语音消息。
- 未连接长按连接完成瞬间产生的残留自动片段会被 PTT 开始信号清理，不进入最终语音消息。
- 长按期间停顿超过 1.5 秒不会提前提交，也不会打断正在播放的助手回复。
- 松开只提交一次，重复 `pointerup` 不重复发送。
- `pointercancel`、失焦、页面隐藏和 WebSocket 关闭都会结束 PTT。
- 空片段和小于最小时长的片段不会产生错误语音消息。
- 已连接且已静音时长按，整个片段没有有效语音，松手后不产生空语音消息。
- PTT 结束后恢复开始前的静音状态。
- 未连接来源的 PTT 在提交后立即保持连接但进入静音；不能因松手过早关闭连接而丢失 TTS 回复，也不能等到播报完成才停止收音。
- 现有免提监听、静音、重连、文字提交和播放打断测试全部通过。

### 阶段五：真实 DSH 验收

先通过本地源码链接安装到 DSH web profile，重启 `dsh web` 后验证：

1. 单击连接仍然正常。
2. 短按静音和解除静音仍然正常。
3. 鼠标长按说话，松开后才出现一条语音消息并自动语音回复。
4. 长按中间停顿 2 至 3 秒，不会提前回复。
5. 未连接状态长按发送后，麦克风立即进入静音，同时能够完整听到语音回复；播报完成后连接仍按既定生命周期处理。
6. 手指长按、移出按钮、取消触摸和窗口切换不会卡住麦克风。
7. 语音回复、任务委派、侧栏语音标识和历史恢复不受影响。

验收通过后再执行版本号、Git 提交、npm 发布、GitHub Release 和实体 npm 包重新安装。

## 7. 风险与处理

| 风险 | 处理方式 |
| --- | --- |
| 短按和长按同时触发 | 使用计时器标记和 click 抑制；增加边界测试。 |
| 用户松手但未收到 `pointerup` | 使用 pointer capture、`pointercancel`、`lostpointercapture`、`blur` 和 `visibilitychange` 多重兜底。 |
| 长按无限持续 | 保留 `maxUtteranceMs` 强制提交或终止保护，并在 UI 中显示异常状态。 |
| 浏览器麦克风权限延迟 | 使用 pending PTT；授权或连接未完成前松手时取消本次发送，不产生空语音消息。 |
| 新客户端连接旧服务端 | 新增控制帧只随同一 bundle 发布；如需混装，先增加 capability/ready 协商并在未获支持时退回原路径。 |
| 移动浏览器后台限制 | 接受浏览器权限和页面生命周期限制，不承诺后台录音。 |
| 旧免提用户行为改变 | 默认单击语义保持不变，PTT 作为临时手势，不修改现有设置项。 |
| VAD 提前提交打断回复 | PTT 模式关闭静音自动结束；增加“长按停顿期间不产生 `transcription.completed`/`interruptResponse`”的回归测试。 |

## 8. 完成标准

- 现有单击连接、静音、解除静音行为无回归。
- 长按在未连接、连接中、已连接、播放中和错误重试状态下都能得到明确结果；在 Windows/macOS 主流 Chromium 浏览器和移动 Safari/Chrome 上可以开始并结束一次语音提交。
- 严格 PTT 模式下，松开之前不会因静音自动提交。
- 松开、取消、失焦和断线都不会遗留麦克风开启状态。
- 自动化测试、类型检查、生产构建和真实 DSH 页面验收全部通过。
- README 和架构文档已同步，发布包中不包含开发密钥。

## 9. 回滚方案

若真实验收发现手势误触或移动端兼容性问题：

1. 保留后端的 PTT 合约，但通过前端移除 PTT 入口恢复原有单击逻辑。
2. 不删除原有 `audio.commit` 和 VAD 路径。
3. 在修复前继续使用上一版 npm/GitHub Release 包。

## 10. 实施记录

- 2026-08-31：完成严格 PTT 后端链路。新增 `beginManualUtterance()` 公共 Voice 合约和 `audio.push-to-talk.start` 控制帧；`voice-local` 在 PTT 期间暂停静音自动提交，仅由 `audio.commit` 结束片段，并保留最大时长、最小时长和空片段保护。
- 2026-08-31：完成 `VoiceController` pending PTT、来源状态恢复和重复提交保护。未连接来源在提交后立即静音并保持连接接收回复；已连接免提/静音来源分别恢复原输入状态。
- 2026-08-31：完成话筒 Pointer Events 长按交互、Pointer Capture、click 抑制、窗口失焦和页面隐藏释放，以及按住状态视觉反馈。
- 2026-08-31：自动化验证通过：`pnpm typecheck`、`pnpm test -- --run`（15 个测试文件，146 项测试）和 `pnpm build`。构建过程仍会显示上游 `dsh-client-ui-primitives` 缺少 source map 的 Vite 警告，不影响构建或测试结果。
- 2026-08-31：`@flowingspring/dsh-voco@0.3.8` 已发布到 npm，`latest` 已指向 0.3.8；Web profile 已从 npm 实体包 0.3.7 升级到 0.3.8，并重启 `dsh web`。
- 当前状态：代码实现、自动化验证、Git 远程备份、npm 发布和 Web profile 重装已完成；仍需在真实页面完成鼠标/触摸 PTT 验收。
