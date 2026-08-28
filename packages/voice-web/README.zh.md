# `@flowingspring/dsh-voice-web`

[English](README.md) | 中文

专用 `/voice` WebSocket carrier。客户端二进制帧是 16 kHz PCM 麦克风分块；服务端二进制帧是 24 kHz PCM 语音。JSON 帧承载 ready、有标识的 ASR 与输出文本、任务观察、语音生命周期、音频 commit、按响应隔离的打断、播放完成和显式 `session.close`。Socket 意外断开时只解除浏览器挂接；同一个持久 Voice Session 在 `reconnectGraceMs` 内重连会复用准确的 provider 对话，显式停止或格式错误／超限的帧则最终关闭。Provider 终止会关闭浏览器传输，不让 UI 继续挂在已失效对话上。该路由复用浏览器 Host／Origin 信任栅栏，不与普通 RPC downlink 共用线路。

## 模型体验

### 浏览器语音传输

#### 模型看到什么

本包不贡献模型可见文本；`/voice` 只传输 PCM 和已经产生的语音生命周期事件。

#### Token 影响

本包直接增加零 token；拥有转写与任务观察的插件决定任何模型用量。

#### KV Cache 影响

WebSocket 帧不会改变模型请求或其可复用前缀。

## 已知限制与后续工作

- 认证仍由部署负责；`trustedHosts` 是 DNS rebinding 和同源栅栏，不是认证。
