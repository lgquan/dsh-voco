# DSH-VOCO-20261028-02：Edge TTS 旧协议返回 403 导致回复无法朗读

## 问题信息

- 发现日期：2026-10-28
- 发现会话或复现方式：正式 CLI `web` profile 使用 `@flowingspring/dsh-voco@0.3.14`；ASR、文字发送和 Agent 回复正常，但回复没有语音朗读
- 相关模块或代码：根 `package.json`、`packages/voice-local/src/edge-tts.ts`、`packages/voice-local/src/node-backend.ts`
- 状态：处理中
- 验证情况：线上依赖 `node-edge-tts@1.2.10` 的最小 TTS 探针稳定返回 WebSocket `403` 且产生 0 字节音频；升级到 `1.2.12` 后，从本仓库构建产物运行相同 `NodeSpeechBackend` 路径，事件完整到达 `tts.started -> tts.delta -> tts.done` 并生成 14,400 字节音频；待发布安装后由用户验收真实播放

## 问题描述

Voco `0.3.14` 的语音输入链路已经恢复：用户语音可以识别为文字、发送给 Agent，并正常得到文本回复。但服务端在为回复调用 Edge TTS 时，WebSocket 握手被上游以 HTTP `403` 拒绝，因而没有 `tts.delta` 音频下发到浏览器，用户无法听到朗读。

该故障发生在服务端音频生成之前，不是浏览器解码、自动播放策略、扬声器或音量问题。

## 证据与复现

最小反馈循环直接实例化与正式插件相同的 `NodeSpeechBackend`，调用：

```text
synthesize('diag-response', '这是语音合成诊断。')
finishSynthesis('diag-response')
```

`node-edge-tts@1.2.10` 的稳定结果：

```text
ready -> tts.started -> error -> closed
Edge TTS failed: Unexpected server response: 403
audioBytes: 0
```

把文本改为英文 `Hello.`、语速改为 `+0%` 后仍然得到相同 `403`，排除了中文文本和 `+20%` 语速配置。

NPM 显示项目使用的 `1.2.10` 发布于 2026-02-05；上游随后发布 `1.2.11` 和 2026-10-26 发布的 `1.2.12`。隔离安装 `1.2.12`、保持相同中文文本、音色和输出格式后：

```text
{"version":"1.2.12","status":"PASS","audioBytes":11520}
```

版本差异显示：

- `1.2.10` 连接 `wss://speech.platform.bing.com/...`，使用旧 `TrustedClientToken` 查询参数和 v1 `Sec-MS-GEC`。
- `1.2.12` 改为 `wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1`，使用 `Ocp-Apim-Subscription-Key` 和 v2 `Sec-MS-GEC` 算法。

## 影响

- Voco 能完成识别和 Agent 回复，但所有回复都无法朗读。
- TTS 错误会使语音会话进入错误或关闭路径，用户只能看到泛化失败状态。
- `0.3.14` 固定依赖 `node-edge-tts@1.2.10`，重新安装同版本不能解决。

## 原因判断

直接原因是 `node-edge-tts@1.2.10` 使用的旧 Edge TTS 接入地址和鉴权协议已被上游拒绝。`1.2.12` 在同一台电脑、同一网络、同一音色和文本下成功生成音频，排除了本机网络、浏览器播放和 Voco 文本配置，证明依赖升级可以恢复服务端 TTS。

## 解决方案

1. 将公开根包和内部源码包的 `node-edge-tts` 依赖从 `1.2.10` 升级并精确固定到 `1.2.12`，更新 `pnpm-lock.yaml`。
2. 新增或扩充分发/运行测试，确保 `NodeSpeechBackend` 能把 TTS 成功结果转换为 `tts.started`、非空 `tts.delta` 和 `tts.done`；网络真实探针作为发布前验收，不放入默认离线单元测试。
3. 运行全量测试、类型检查、peer 检查、构建和实际 TTS 探针。
4. 升级 Voco 补丁版本，发布 NPM 与 GitHub Release，重新安装到正式 `web` profile 后由用户完成真实朗读验收。

## 处理记录

- 2026-10-28：用户确认充值后 ASR、文字发送和 Agent 文本回复恢复，但没有语音朗读。
- 2026-10-28：最小化 `NodeSpeechBackend` 探针稳定复现 `node-edge-tts@1.2.10` WebSocket `403`，未生成任何音频。
- 2026-10-28：英文文本和默认语速仍然 `403`，排除文本和语速配置。
- 2026-10-28：在系统临时目录隔离安装 `node-edge-tts@1.2.12`，同一句中文成功生成 11,520 字节 MP3；确认上游已迁移到新的 Edge TTS 地址和 v2 鉴权。
- 2026-10-28：新增分发回归测试，要求公开根包、内部源码包和 `voice-local` 精确固定 `node-edge-tts@1.2.12`；测试在修复前对三个 `1.2.10` 依赖均稳定失败。
- 2026-10-28：三个依赖清单和 `pnpm-lock.yaml` 已精确升级到 `node-edge-tts@1.2.12`，分发回归测试通过。
- 2026-10-28：从仓库当前构建产物实例化 `NodeSpeechBackend`，真实访问 Edge TTS 后收到 `ready -> tts.started -> tts.delta -> tts.done`，生成 14,400 字节音频，原 `403` 未再出现。
- 2026-10-28：发布版本号升级为 `0.3.15`，README 和市场提交指南的当前版本及 Release 链接已同步；问题继续保持“处理中”，等待 NPM 重新安装和用户真实朗读验收。
- 2026-10-28：串行执行全量验证：15 个测试文件、141 项测试全部通过，类型检查、peer 依赖检查、完整构建和 `git diff --check` 通过。曾并行运行两个会触发 `prepare` 的命令，两个构建进程同时创建 `lib/types` 导致其中一个 `EEXIST`；改为串行后稳定通过，该并发干扰与 TTS 修复无关。
- 2026-10-28：`pnpm pack --json` 生成 `flowingspring-dsh-voco-0.3.15.tgz`，包内只包含根公开包的 `cordis.patch.yml`、`lib/`、包元数据、许可证和 README；包内版本为 `0.3.15`、`node-edge-tts` 为 `1.2.12`，SHA-256 为 `249a3bccc36c5e77f5894f2d193e6a7219d9b69419b1621fdf4a48883b7c8a63`。
- 2026-10-28：对最终打包构建产物再次执行真实 Edge TTS 探针，继续完整收到 `ready -> tts.started -> tts.delta -> tts.done` 并生成 14,400 字节音频。
