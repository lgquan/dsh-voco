# dsh-voco 输入框语音与发送按钮交互实施方案

## 方案信息

- 编写日期：2026-08-31
- 适用项目：`dsh-voco` 与 DeepSeek harness Web Composer
- 状态：暂不处理，归档保留
- 本文性质：实施方案与可行性评估
- 实施状态：暂时初期先不做，后面再定吧；尚未修改功能代码，尚未修改或发布 DSH 原厂包

> **暂缓说明：暂时初期先不做，后面再定吧。** 当前继续保持语音入口与 DSH 原厂发送键隔离，不实施本方案中的共享主按钮改造。后续重新评估时，也优先考虑独立语音按钮方案，避免为此修改 DSH 原厂代码。

## 1. 需求边界

本方案只处理浏览器输入框右侧的主操作按钮，不处理桌面悬浮窗，也不改变已经完成的严格 Push-to-Talk（PTT）服务端协议。

截图仅作为视觉参考：

- 空输入时使用声波式语音图标（`codex-clipboard-5c4f16c5-e3d5-4dd7-8511-c704b030182d.png`）。
- 有输入时继续使用 DSH 原厂向上箭头发送图标（`codex-clipboard-fc2e6332-e48b-4d66-9728-d7a93746cf7d.png`）。

目标交互为：

1. 草稿为空时，主按钮是语音按钮。
2. 空草稿单击：沿用现有语音逻辑，未连接则连接，已连接则静音/解除静音。
3. 空草稿长按：沿用现有严格 PTT，按住采集，松手提交；没有识别到有效文字时不生成消息、不触发回复。
4. 草稿有文字时，主按钮只能发送文字；长按、语音连接和语音静音手势全部禁用。
5. 草稿带图片等附件时，按 DSH 原厂“可发送”语义处理，继续显示原厂发送按钮，不显示语音按钮。

## 2. 现状与代码证据

### 2.1 dsh-voco 当前语音控制

- [`packages/ui-voice/src/client/VoiceControl.tsx`](../packages/ui-voice/src/client/VoiceControl.tsx) 目前注册在 `conversation.input.right`，是一个额外的 28px 话筒按钮。
- 单击当前执行“未连接则连接，已连接则静音/解除静音”。
- 400 ms 长按调用 `beginPushToTalk()`，松手调用 `endPushToTalk()`。
- [`packages/ui-voice/src/client/voice-controller.ts`](../packages/ui-voice/src/client/voice-controller.ts) 已包含严格 PTT 的 pending、来源状态恢复、`audio.push-to-talk.start` 与 `audio.commit`。
- 从未连接状态进入 PTT 时，控制器会先建立连接并以静音状态等待，松手提交后保持连接但恢复静音，以便收到语音回复且不进入后台监听。

这些能力应直接复用，不应为新按钮重新实现录音、VAD、ASR 或 TTS 链路。

### 2.2 DSH 原厂输入框边界

当前安装的 `@deepseek-ai/dsh-client-ui-conversation` 中：

- `conversation.input.right` 是 list slot，定义为“主发送按钮之前的小型附加控件位”，不能替换主发送按钮。
- `InputBar` 在 `lib/client.js` 中内联渲染主按钮；按钮根据运行状态显示停止或发送图标。
- 原厂主按钮将 `draft.trim() === ''` 且没有附件视为空，并据此禁用发送。
- 当前没有 `conversation.input.primary` 或等价的主按钮替换/解析接口。
- `@deepseek-ai/dsh-client-ui-primitives` 已提供 `IconSendOutline16/14`、`IconStopFill16` 等原厂图标，但当前没有声波/话筒图标。

因此，只修改 dsh-voco 的 `conversation.input.right` 无法满足“与发送键共用同一个按钮”。用 CSS 隐藏原按钮、通过 DOM 覆盖它，或复制整个 `InputBar` 都不属于可接受的长期实现。

### 2.3 当前文字提交的冲突

[`packages/ui-voice/src/client/voice-text-submit.ts`](../packages/ui-voice/src/client/voice-text-submit.ts) 当前会在语音连接活动时改写 `input.submit()`，把普通文字发送成 Voice `text.submit`，从而进入语音回复链路。

新需求明确“有字时只能发送，不能发起语音通话”。推荐方案需要取消这种全局改写，或至少让原厂主按钮在文字草稿路径绕过该 bridge，恢复 DSH 原生文字提交。否则视觉上虽然是向上箭头，实际仍可能被路由为语音消息。

## 3. 依赖与问题空间

这项需求横跨三个边界：

| 边界 | 所有者 | 需要解决的内容 |
| --- | --- | --- |
| Composer 状态、附件、停止态、发送图标与布局 | DSH 原厂 `ui-conversation` / `ui-primitives` | 提供正式的主按钮扩展位，并保持原厂按钮外壳和优先级 |
| 语音连接、严格 PTT、静音恢复 | dsh-voco `ui-voice` / `voice-*` | 在主按钮被选中时复用现有 VoiceController |
| ASR 结果是否进入会话/草稿 | Voice session 与 Voice assistant | 共享语音对话和“仅转写”不能误用同一个 `audio.commit` 语义 |

推荐把第一种共享按钮方案的新增 seam 放在 Composer 主按钮处；不要把 seam 放在 DOM/CSS 层，也不要让语音组件复制输入框全部业务。

## 4. 方案比较

### 方案 A：共享原厂主按钮，空草稿由 dsh-voco 接管（推荐）

先由 DSH 原厂新增一个正式的 `conversation.input.primary` 主按钮扩展 seam。推荐使用 chain slot：原厂默认按钮作为 fallback，插件只在满足空草稿且主操作不是停止时选中自己的语音项。更稳妥的实现是让 selector 返回“动作描述”（图标、label、点击/长按处理），由原厂继续渲染统一的按钮外壳；如果 slot 最终采用组件渲染，也必须复用原厂公开的主按钮组件，不能在插件内复制 CSS。

原厂仍负责：

- 主按钮固定尺寸、圆角、颜色、禁用态、Tooltip、焦点和屏幕阅读器语义。
- `draft`、附件、队列、运行态、停止态和 composer takeover 的判断。
- 非空草稿和附件的原厂发送行为。

dsh-voco 只负责：

- 空草稿的声波图标与语音按钮状态。
- 单击连接/静音/解除静音。
- 400 ms 长按严格 PTT 和取消兜底。
- 语音状态的 label、`aria-pressed`、录音中视觉反馈。

状态优先级如下：

| 条件 | 显示/行为 | 优先级 |
| --- | --- | --- |
| Composer 被锁定、审批接管或不可用 | 原厂禁用/接管行为 | 最高 |
| 主操作是运行中的 Stop | 原厂停止按钮；不被语音覆盖 | 高 |
| 有文字草稿，或有附件 | 原厂向上箭头发送；只允许文字/附件提交 | 高 |
| 无文字、无附件，Voice 未连接 | 声波按钮；单击连接，长按 PTT | 普通 |
| 无文字、无附件，Voice 已连接 | 声波按钮；单击静音切换，长按 PTT | 普通 |

这里的“空”必须按原厂定义计算：`draft.trim() === '' && imageIds.length === 0`。只有空白字符不能让语音按钮误变成发送按钮；附件存在时仍属于原厂可发送状态。

### 方案 B：保留独立话筒，点击开始/再次点击停止，仅转写进草稿

该方案继续使用现有 `conversation.input.right`，不需要主按钮扩展位：

1. 空输入时旁边显示话筒按钮。
2. 第一次点击开始采集，第二次点击停止。
3. ASR 结果插入当前草稿，可按光标位置追加或替换选区。
4. 用户编辑后点击原厂向上箭头发送。

它的交互比长按更容易被键盘和触摸设备使用，但当前 Voice 链路不能直接复用：`audio.commit` 会产生 `transcription.completed`，随后进入 Voice assistant 路由、打断/生成语音回复。要实现“只转写、不持久化 Voice utterance、不触发 assistant/TTS”，需要新增独立的 dictation 语义（控制帧或独立 endpoint）、服务端模式分流、客户端 ASR-only 状态、草稿/光标合并、错误和麦克风互斥处理。

此外，它会保留第二个按钮，不能满足“发送键和语音通话共用同一个按钮”的核心目标。因此它适合作为后续独立听写功能，不作为本次主实现。

### 方案 C：只在 dsh-voco 内覆盖或复制原厂 InputBar（不推荐）

可以通过 CSS/DOM 隐藏原厂主按钮，或接管 `conversation.composer.bar` 并复制输入栏。这样不需要等待 DSH 原厂增加 seam，但会复制键盘提交、附件、命令菜单、队列、模型选择、停止态、锁定态和无障碍逻辑。

该方案的 seam 落在宿主内部实现细节，原厂升级、审批 takeover、附件变化或运行态切换都可能产生回归。它也会制造两个按钮树和焦点竞争，不能作为正式实现；最多只能用于一次性原型验证。

### 比较结论

| 维度 | 方案 A：正式主按钮 seam | 方案 B：独立听写 | 方案 C：覆盖/复制 InputBar |
| --- | --- | --- | --- |
| 视觉与原厂一致性 | 高 | 中 | 低至中 |
| 对现有 PTT 的复用 | 高 | 低 | 中 |
| 新增后端复杂度 | 低 | 高 | 低 |
| 对原厂升级的稳定性 | 高 | 高 | 低 |
| 是否真正共用发送按钮 | 是 | 否 | 表面上是 |
| 实现范围 | DSH seam + ui-voice | ui-voice + voice-web/local/assistant + 草稿桥接 | 复制整个 Composer |
| 推荐程度 | 推荐 | 后续能力 | 不推荐 |

按深度、局部性和 seam 位置衡量，方案 A 的业务深度集中在一个清晰的 Composer 主按钮边界，语音逻辑仍局部于 `ui-voice`；方案 B 的深度横跨 ASR、Voice session、assistant 路由和草稿编辑；方案 C 则把宿主私有实现泄漏到插件。

## 5. 推荐方案的接口草图

### 5.1 DSH 原厂新增主按钮 chain slot

建议在 `@deepseek-ai/dsh-client-ui-conversation` 声明：

```ts
interface ComposerPrimaryOwnerProps {
  readonly action: 'send' | 'stop'
  readonly empty: boolean
  readonly locked: boolean
  readonly running: boolean
  readonly subagent: boolean
  readonly hasAttachments: boolean
  readonly onSend: () => void
  readonly onStop?: () => void
}
```

`conversation.input.primary` 使用 chain slot：

- selector 必须是 owner props 的纯函数。
- dsh-voco 只在 `action === 'send' && empty && !locked` 时返回匹配结果。
- 原厂在全部 selector 放弃时渲染现有发送/停止按钮 fallback。
- 主按钮位置、尺寸、Tooltip、按键聚焦和 `aria-*` 外壳由原厂统一保证。
- 如果原厂不希望插件渲染按钮本体，可把 owner 收窄为“主按钮内容 + press handlers”的正式 primary action renderer；不要通过非公开 DOM 约定传递。

同时在 `ui-primitives` 提供与现有图标一致的官方声波图标（例如 `IconVoiceWaveform16`）。当前 primitives 没有该图标，不能假设插件可以直接导入它；图标应来自原厂资源或由原厂 primitives 统一收录。

### 5.2 dsh-voco 主按钮组件

可将现有 [`VoiceControl.tsx`](../packages/ui-voice/src/client/VoiceControl.tsx) 拆成“语音状态/手势控制”和“主按钮渲染”两层，但不复制 InputBar：

- 读取原厂传入的 `empty`、`locked`、主操作状态。
- `empty === false` 时不挂载 PTT pointer handlers，不调用 VoiceController。
- `empty === true` 时复用当前 `toggle()`、`beginPushToTalk()`、`endPushToTalk()`。
- 使用官方 primary button 外壳与官方声波图标。
- 保留 pointer capture、400 ms 阈值、`pointercancel`、`lostpointercapture`、`blur`、`visibilitychange` 收口。
- 连接中、重试、PTT 激活、语音回复中分别提供明确的动态 label 和状态。

### 5.3 文字提交桥接调整

新需求下，原厂向上箭头必须真正走 DSH 原生文字提交。建议：

1. 移除 `VoiceTextSubmitBridge` 对普通 `input.submit()` 的全局改写；或
2. 保留 bridge 作为显式兼容开关，但默认主按钮文字路径绕过 `text.submit`，只在另一个明确的 Voice text command 入口使用。

验收时必须用“Voice 已连接 + 输入框有文字”验证：点击向上箭头只产生普通文字消息，不创建新的 Voice utterance，不触发语音 assistant/TTS。

## 6. 交互与边界规则

- 单击/长按必须互斥：长按达到阈值后抑制随后产生的 click，避免一次操作同时切换静音。
- 草稿或附件在 PTT 期间变为非空时，立即结束/取消 PTT，并把控制权交还原厂发送按钮，不能发送混合语义。
- 按钮移出、`pointercancel`、窗口失焦、页面隐藏、组件卸载都必须结束 PTT，避免麦克风卡在打开状态。
- 未连接状态长按建立连接时，松手提交后立即恢复静音；连接保留到语音回复可以传输，避免后台继续监听。
- 已连接免提状态长按后恢复免提；已连接静音状态长按后恢复静音。
- 空白语音或 ASR 返回空文本时，不生成用户消息、不触发 assistant、不打断已有回复；这与当前 `node-backend` 对无有效 utterance 的处理一致。
- Voice 正在播放时，长按按照严格 PTT 规则采集，不把普通点击误解释为停止或发送；原厂运行中的 Stop 仍有最高优先级。
- 触摸、鼠标和键盘都要有可访问的等价操作。若平台无法可靠表达键盘“按住”，至少应提供可预测的 Space/Enter click 行为、动态 `aria-label` 和录音状态播报，而不是只有视觉状态。
- 语音图标不得在有文字或附件时与向上箭头并存；按钮尺寸和位置在两种图标之间保持稳定，避免输入内容变化造成布局跳动。

## 7. 实施阶段

### 阶段一：确认并实现 DSH 原厂 seam

- 在 `ui-conversation` 增加 `conversation.input.primary` chain slot 及 owner 类型。
- 将 InputBar 当前内联 primary button 提取为原厂可复用 fallback/组件。
- 将 `IconSend`、`IconStop` 和新的声波图标纳入原厂 primitives。
- 为 slot 编写空草稿、文字、附件、运行停止态和 fallback 测试。
- 发布或在 dsh-voco 本地源码链接中验证兼容版本。

### 阶段二：接入 dsh-voco

- 将 VoiceControl 从 `conversation.input.right` 迁移到 primary seam。
- 引入 composer 的 `empty`/附件/锁定状态，不从 DOM 读取输入框内容。
- 保留并复用现有 VoiceController 严格 PTT 状态机。
- 调整 `VoiceTextSubmitBridge`，让有文字时的箭头走原厂文字提交。
- 删除不再需要的旁路话筒按钮样式和 slot 注册。

### 阶段三：验证与发布

- 先使用 DSH 原厂和 dsh-voco 本地源码链接进行端到端测试。
- 通过后再分别构建、提交、发布和重新安装 NPM 包。
- 若 DSH 原厂 seam 暂时不能合入，本需求保持“待实现”，不得用 CSS 覆盖方案冒充完成。

## 8. 测试与验收矩阵

| 场景 | 预期结果 |
| --- | --- |
| 空草稿、未连接，单击 | 连接语音，恢复现有默认免提监听 |
| 空草稿、未连接，长按并说话 | 建立连接，松手提交一次 PTT，收到语音回复，之后输入恢复静音 |
| 空草稿、长按但没有说话 | 不产生用户消息，不触发 assistant/TTS，不显示空 Voice utterance |
| 空草稿、已连接免提，单击 | 静音 |
| 空草稿、已连接静音，单击 | 解除静音 |
| 空草稿、已连接任一状态，长按 | 严格 PTT；松手后恢复按下前状态 |
| 有文字草稿、Voice 未连接 | 显示原厂箭头；点击只发送普通文字 |
| 有文字草稿、Voice 已连接 | 仍只发送普通文字，不走 Voice `text.submit`、不触发语音回复 |
| 仅空白字符 | 按空草稿处理，显示语音按钮 |
| 无文字但有附件 | 显示原厂发送按钮，语音长按禁用 |
| Composer 锁定/审批接管 | 原厂锁定或 takeover 优先，Voice 不抢占 |
| Agent 正在运行 | 原厂 Stop 优先，不能被声波按钮覆盖 |
| 长按后移出、失焦、隐藏页面 | 可靠结束或取消 PTT，麦克风轨道恢复正确状态 |
| pointer 事件与 click 竞态 | 单击不被误判为长按，长按不额外触发静音切换 |
| 声波与箭头切换 | 按钮大小、位置、Tooltip 和焦点不跳动 |
| 旧 DSH 包未提供新 seam | 构建失败或明确降级，不静默使用 DOM/CSS 覆盖 |

## 9. 风险、回滚与后续事项

主要风险是 DSH 原厂 seam 尚未存在，以及现有文字 bridge 会改变原厂发送语义。两者都应在实现前解决并加测试。

回滚路径：

- DSH 原厂保留原 primary fallback；移除 dsh-voco 注册即可恢复原厂发送按钮。
- dsh-voco 可暂时恢复当前 `conversation.input.right` 话筒按钮，VoiceController 和服务端 PTT 协议不需要回滚。
- 不需要修改已发布的 Voice 事件或会话数据格式。

后续低优先级事项：

- 若用户确实需要“点击开始、再次点击停止、只把 ASR 写回草稿”的 ChatGPT 式听写，再单独立项实现 dictation mode。
- dictation mode 需要独立控制帧或 endpoint、ASR-only 服务端分流、草稿光标合并和与 Voice 通话/麦克风占用的互斥规则，不能把普通 `audio.commit` 直接改作听写。
- 可在原厂 primitives 有正式资源后再统一调整声波图标尺寸与主题色，避免 dsh-voco 自行维护一套图标资产。

## 10. 结论与保留意见

需求本身可行，现有严格 PTT 也能直接复用；但共享主按钮的真正工作量在于让 DSH 原厂公开一个可替换但有 fallback 的 Composer 主按钮 seam，并取消活动 Voice 对普通文字提交的隐式改写。

本方案暂不实施，作为保留意见归档。当前产品继续使用现有独立语音入口，不与原厂向上箭头发送键共用位置。后续如果重新启动，优先重新评估与原厂发送键隔离的独立语音按钮或独立听写入口；只有在确认值得修改 DSH 原厂并接受跨包维护成本后，才考虑方案 A 的共享主按钮 seam。方案 B 仍作为未来独立听写能力，方案 C 不实施。本文件完成的是评估和实施设计，当前不代表功能已经实现或已发布。
