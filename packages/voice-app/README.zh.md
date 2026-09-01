# `@flowingspring/dsh-voco`

[![npm version](https://img.shields.io/npm/v/@flowingspring/dsh-voco.svg)](https://www.npmjs.com/package/@flowingspring/dsh-voco)
[![许可证](https://img.shields.io/npm/l/@flowingspring/dsh-voco.svg)](https://github.com/lgquan/dsh-voco/blob/master/LICENSE)

[English](README.md) | 中文

面向 DeepSeek Harness（DSH）Web UI 的可恢复、可打断语音对话插件。它使用硅基流动云端语音识别和 Edge TTS，并把需要工具的工作委派给后台 Agent。

## 安装

### npm 安装（推荐）

先安装 DSH CLI：

```powershell
npm install -g @deepseek-ai/dsh
```

将插件加入 Web profile 并启动：

```powershell
dsh plugin --profile web add @flowingspring/dsh-voco
dsh web
```

### GitHub Release 安装

GitHub Release 提供已经构建好的插件包，不需要下载源码或安装 pnpm：

```powershell
dsh plugin --profile web add https://github.com/lgquan/dsh-voco/releases/download/v0.3.12/flowingspring-dsh-voco-0.3.12.tgz
```

Release 页面：[v0.3.12](https://github.com/lgquan/dsh-voco/releases/tag/v0.3.12)

## 配置 API Key

语音识别需要你自己的[硅基流动 API Key](https://siliconflow.cn/)，配置名只有一个：`SILICONFLOW_API_KEY`。语音转文字使用硅基流动当前免费的 [`XingChenAGI/XingChenASR-V3.2-Ultra`](https://cloud.siliconflow.cn/models?target=XingChenAGI/XingChenASR-V3.2-Ultra)；免费状态和使用规则以模型页面为准。Edge TTS 不需要 API Key。

推荐在 DSH 中打开“设置 → 插件 → 插件配置”，展开“语音助手（Voco）”，填写 API Key 并保存。密钥保存在 DSH 凭据库中，不写入普通设置文件；保存后重新开启或重连语音即可生效。

环境变量和 `.env` 仍作为兼容与自动化配置方式保留。

在启动 DSH 的同一个 PowerShell 中临时设置：

```powershell
$env:SILICONFLOW_API_KEY = "sk-your-api-key"
dsh web
```

要持久保存，可创建 DSH 用户环境文件 `%USERPROFILE%\.dsh\.env`（设置了 `DSH_HOME` 时使用 `$DSH_HOME/.env`）：

```dotenv
SILICONFLOW_API_KEY=sk-your-api-key
```

也可在运行 `dsh web` 的当前目录放置 `.env`。修改后重启 DSH；不要修改 npm 安装目录或 `node_modules` 中的文件，也不要把真实密钥提交到 GitHub。

## 首次使用

1. 运行 `dsh web` 并打开 DSH Web UI。
2. 新建或选择会话，点击麦克风并允许浏览器权限。
3. 直接说话，连续静音约 1.5 秒后提交一句话；也可以长按麦克风约 400 毫秒按住说话，松手后提交这一段。
4. 普通聊天由前台回答，需要项目工具的工作会委派给后台 Agent。

每个语音会话持续绑定自己的后台 Agent Session。上下文达到轮换阈值后，后续任务会自动进入新的子会话，但仍与原语音会话绑定。

## 更新

```powershell
dsh plugin --profile web add @flowingspring/dsh-voco
```

也可以安装指定的 GitHub Release。更新后重启 `dsh web`。

## 卸载

```powershell
dsh plugin --profile web remove @flowingspring/dsh-voco
```

卸载不会自动删除 DSH 会话或语音历史。

卸载也不会删除已经保存的 API Key。需要彻底清除时，从 `%USERPROFILE%\.dsh\.credentials.yaml`（设置了 `DSH_HOME` 时为 `$DSH_HOME/.credentials.yaml`）的 `refs` 下删除 `SILICONFLOW_API_KEY`，并同时清理系统环境变量或 `.env` 中的同名配置。

## 功能

- SiliconFlow 免费模型 [`XingChenAGI/XingChenASR-V3.2-Ultra`](https://cloud.siliconflow.cn/models?target=XingChenAGI/XingChenASR-V3.2-Ultra) 云端语音转文字。
- Edge TTS `zh-CN-XiaoxiaoNeural` 语音回复。
- 语音打断、页面切换、断线重连和历史恢复。
- 委派前即时确认，完整报告保留在 DSH 任务界面。
- 可选接入 `@flowingspring/dsh-workspace-memory`，让语音主会话和每个完成的委派子任务共享同一 Workspace 长期记忆范围。

## 排查

- **缺少 API Key**：确认 `SILICONFLOW_API_KEY` 在启动 DSH 的进程中可见；修改 `.env` 后重启 `dsh web`。
- **无法录音**：检查浏览器麦克风权限和系统输入设备，并确认页面来自 `dsh web`。
- **识别失败或较慢**：检查网络、Key 有效期、硅基流动账户额度及模型/Provider 延迟。

## 链接

- [GitHub 源码与问题反馈](https://github.com/lgquan/dsh-voco)
- [npm 包](https://www.npmjs.com/package/@flowingspring/dsh-voco)

## 许可证

[MIT](LICENSE)
