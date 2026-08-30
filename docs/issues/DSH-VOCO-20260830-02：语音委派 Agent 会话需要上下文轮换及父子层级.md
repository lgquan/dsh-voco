# DSH-VOCO-20260830-02：语音委派 Agent 会话需要上下文轮换及父子层级

## 问题信息
- 发现日期：2026-08-30
- 发现会话或复现方式：继续评估语音会话与后台 Agent 委派会话的绑定和上下文窗口策略
- 相关模块或代码：`packages/voice-assistant`、`packages/voice`、`packages/ui-voice`、`docs/ARCHITECTURE.md`
- 状态：已解决
- 验证情况：`pnpm typecheck`、全量 `pnpm test -- --run`（13 个测试文件、125 个测试）和 `pnpm build` 已通过；真实宿主侧栏已验证展开按钮和子项渲染，用户已确认新建委派会话可以在语音父会话下展开查看

## 问题描述
一个语音会话可能连续委派多个任务。这里有两个独立需求：所有委派会话都归入语音会话之下，以及 `continuous` 模式中的单个 Agent 接近上下文上限时进行换代。前者在 `isolated` 模式下也成立，后者只对持续复用模式有意义。若持续模式等宿主自动压缩再继续，语音任务的长期上下文和可解释性会变差。另一个表现层问题是，当前宿主 workspace sidebar 会把 `origin: 'subagent'` 从顶层列表过滤掉，但未提供子会话树渲染，导致用户只能从“查看后台详情”进入委派会话。

## 证据与复现
- `packages/voice-assistant/src/index.ts:45-66` 同时提供 `isolated` 与 `continuous` 两种任务会话策略，配置默认值为 `isolated`。
- `docs/ARCHITECTURE.md:60` 描述同一来源 Session 持续复用一个后台 Agent Session，与当前默认值不一致。
- 初始实现的 `packages/voice-assistant/src/index.ts:1064-1100` 创建后台 Agent Session 时只设置 `cwd` 和 `agentPreset`，没有设置宿主支持的 `parentSession` 与 `origin: 'subagent'`；该缺陷已在本次处理中修复。
- 宿主 `@deepseek-ai/dsh-session` 的 `SessionHeader` 支持 `parentSession`、`origin` 和 `delegationDepth`；客户端 `SessionSummary`/`SessionListState` 已支持 `parentId`、`subagentsByParent` 及父子地址导航。
- 宿主 `@deepseek-ai/dsh-token-meter` 提供 `measure(session)`，并结合最新 `request/context.contextWindow` 计算当前上下文压力；容量未公布时无法可靠计算百分比。
- `packages/ui-voice/src/client/index.ts` 当前把委派详情绑定到普通 `sessions.open(id)`，而原生子会话契约提供 `openSubagent(address)`，二者的可寻址性不同。
- `packages/ui-voice/src/client/VoiceNodeViews.tsx:75` 以 `sessions.ids.includes(taskSessionId)` 判断任务会话是否可导航；子会话被宿主从顶层 `ids` 移出后，该判断会错误地禁用打开按钮。
- 宿主 `@deepseek-ai/dsh-client-ui-workspace@0.0.1-rc.1` 的 `sessionVisible()` 明确过滤 `origin === 'subagent'`，workspace browser 只遍历顶层 `list.ids`；runtime catalog 虽能返回子会话，侧栏仍不会显示子项或展开控件。

## 影响
- 持续任务达到上下文压力后，可能依赖宿主压缩或直接遇到上下文溢出，后续语音追问的上下文连续性不可控。
- 未写入父子 Session 元数据时，后台会话可能以顶层会话散落在侧栏，无法表达“由哪个语音会话派生”；写入后若仍使用顶层 `ids` 判断导航，任务卡片的打开按钮会失效。
- 若不先统一 `isolated`/`continuous` 语义，轮换策略的触发范围和用户预期会不一致。

## 原因判断
当前绑定状态模型只保存一个活动的 `agentSessionId`，`voice/task-session-bound` 也只记录一个会话标识；实现假定持续模式下可以长期复用同一 Agent。语音委派尚未接入宿主原生的 Session lineage 和 Token Meter seam。

## 解决方案
1. 将每个语音委派 Agent Session 创建为来源 Voice Session 的 durable child：设置 `parentSession` 为来源 Session、`origin: 'subagent'`，并保留合理的 `delegationDepth`。普通手动文字 Session 不设置这些字段，继续保持顶层。
2. 将“收纳”与“轮换”解耦：`isolated` 下每个任务天然新开一个子会话，只需要保证父子元数据；上下文轮换只在 `continuous` 下启用。
3. 在持续模式的委派前按任务粒度检查 `ctx.tokenMeter.measure(child)` 与 `child.requestContext()?.contextWindow`。不要把 95% 当作绝对硬门控；容量未知时按显式累计预算或宿主 context-overflow/失败路径兜底。
4. 只在 Agent 空闲、任务完成或等待用户输入的边界切换，不在活动 turn 中硬切。创建 successor child 后注入有明确预算的工作状态交接摘要；旧 child 保留持久历史和侧栏子项。
5. 通过 durable binding/rotation 记录恢复最新活动 child，同时让每条 `voice/task-delegated` 保留实际 `taskSessionId`。UI 使用父子地址打开，不再用顶层 `sessions.ids` 判断子会话可导航性；在宿主 workspace 尚未渲染子会话树时，由语音 overlay 提供轻量的父行展开按钮和缩进 child rows，并调用宿主 catalog refresh/open 接口。
6. 统一文档与默认策略：明确 `isolated` 是否仍为默认；若产品目标是连续语音委派，应把连续模式及轮换阈值写成显式配置和用户可理解的行为。

## 处理记录
- 2026-08-30：完成现有语音绑定、宿主 Session lineage、子会话目录和 Token Meter 契约核对。
- 2026-08-30：确认父子侧栏能力可复用宿主现有模型，不需要新增一套客户端折叠协议。
- 2026-08-30：确认轮换不应在活动 Agent turn 中直接执行；需要以空闲/任务边界为切换点，并保留旧 child 的持久历史。
- 2026-08-30：复核后将“收纳”和“上下文轮换”拆为两个独立能力；确认 95% 只能作为参考阈值，轮换应按任务粒度和可用容量判断。
- 2026-08-30：确认 `VoiceNodeViews.tsx` 通过顶层 `sessions.ids` 判断可导航性；父子收纳后该判断会使任务卡片打开按钮失效，实施时必须改用父子地址。
- 2026-08-30：创建 Agent 时写入 `parentSession`、`origin: 'subagent'` 和递增 `delegationDepth`；`isolated` 与 `continuous` 两种策略均使用宿主父子 lineage。
- 2026-08-30：continuous 模式在任务边界读取 child 的 `requestContext().contextWindow` 和可选 `tokenMeter.measure()`；达到比例或 reserve 条件时创建空 successor，注入有界工作状态交接，保留旧 child，不使用 `SessionStore.fork()`。
- 2026-08-30：等待用户回复后的 `send_task_message` 也经过同一轮换检查；轮换创建期间先撤销旧 child 的作用域工具，创建失败时恢复旧工具，避免共享 prompt 注册冲突。
- 2026-08-30：UI 导航改为优先使用宿主 `subagentAddress`/`openSubagent`，并在子会话移出顶层列表时仍将任务卡片标记为可导航。
- 2026-08-30：新增 continuous rotation 行为测试，覆盖 lineage、空 successor、handoff 上限和 Token Meter 触发。
- 2026-08-30：新增 UI 测试覆盖 `subagentsByParent` 中的子会话可导航性，以及 `openSubagent` 优先、旧运行时 `open` 回退；自动化检查与生产构建均通过。
- 2026-08-30：根据真实侧栏表现复核宿主 workspace 包，确认其当前版本过滤所有 subagent 顶层行且没有子树 renderer；扩展 `VoiceSessionMarkers` 为语音父行提供可折叠、缩进的 child rows，点击 child 仍通过宿主父子地址导航，并主动刷新语音父会话 catalog。
- 2026-08-30：侧栏子树测试覆盖父行展开按钮、缩进 child row、活动状态点和 child 点击导航；按钮移动到宿主标题前，避免占用固定状态槽导致标题布局挤压。
- 2026-08-30：用户使用测试会话 `dsh-session-session-4dfb0ead-4e0b-4c7f-b71f-f6acd2e5ef9c`、`dsh-session-session-1c78abe9-d773-4bf3-89d0-d2d878ae5580` 复现“语音标识可见但没有展开按钮”。本地宿主真实 DOM 确认 session row class 为 `YDXeBa_sessionRow`，selector 可命中；根因是 catalog 首次请求尚未产生快照时 `VoiceSessionMarkers` 把按钮当作无子项移除。现改为所有已识别语音父会话稳定显示 disclosure 控件，展开时触发 catalog refresh，等待 catalog 更新后绘制 child rows；新增对应回归测试。
- 2026-08-30：用户使用 `dsh-session-session-2ded6f6e-30a8-4546-b32f-64413ad47d75` 复现箭头消失及展开后无会话。检查发现其子会话日志完整且压缩校验通过，但仅有 `parentSession` 元数据，没有宿主 `@deepseek-ai/dsh-subagent` 要求的 `subagent/descriptor` 事件，因此目录返回“会话记录损坏”。语音 Agent 创建路径现追加版本化 descriptor：隔离任务为 `one-shot`，连续任务为 `continuable`，同时保存 provider/model 和可读任务标签；注册该事件类型并加入 `@deepseek-ai/dsh-subagent` peer 依赖。现有旧子会话不会被改写，新委派会话将由宿主正常分类。
- 2026-08-30：用户完成真实语音委派验收，确认侧栏可以从语音父会话展开并看到新建的 Agent 子会话；问题状态更新为已解决。
- 2026-08-30：本地启动 web profile 验证宿主实际 session row 结构为 `[role="treeitem"].YDXeBa_sessionRow`；当前浏览器实例无语音历史，因此未进行真实语音父会话视觉验收。宿主需重载新构建 bundle 后再用上述测试会话验收。

## 后续低优先级优化
- 为每个 child 提供更明确的生成序号或可读标签，改善大量轮换后的识别。
- 在语音任务卡片中展示当前 child 的轮换次数和上下文压力，仅作为参考，不作为唯一门控依据。
- 将当前按字符上限截断的交接摘要升级为按 token 预算截断，并为来源字段提供稳定的结构化 schema；当前实现明确它表达工作状态而非完整对话记忆。

## 实施前置确认
- 宿主当前类型定义已确认 `origin` 的合法值就是 `'subagent'`，不是 `'child'` 或 `'agent'`；`dsh-session` 与 `dsh-agent` 的 `meta` 类型保持一致。
- `ensureContinuousTaskAgent` 是 continuous 模式创建/恢复 child 的唯一入口；轮换检查应放在该入口或其委派前调用链内，避免分散到 `realtime_delegation` 主流程。
- 上述“唯一入口”仅指 child 的创建/恢复。`send_task_message` 会绕过它直接对当前 Agent 执行 `followup/steer`；若轮换覆盖等待用户回复后的继续任务，必须让该路径也经过同一个委派前置检查，或者明确轮换只发生在新任务开始前。
- 重启恢复当前通过最后一个 `voice/agent-binding-state` / `voice/task-session-bound` 事件恢复单一 child。轮换后需恢复最新 active child，同时保留历史 child 的 durable lineage 和可导航性。
- `VoiceNodeViews.tsx:75` 的顶层 `sessions.ids` 判断已确认是收纳后的导航回归点：子会话移出顶层列表后，打开按钮会被错误禁用。
