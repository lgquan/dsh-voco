# dsh-voco

[English](README.en.md) | 中文

`dsh-voco` 是面向 DeepSeek Harness（DSH）Web UI 的语音对话插件。它让你用自然语言说出需求，并将需要项目工具的工作委派给后台 Agent；完整任务报告仍保留在 DSH 会话中，语音只播报简洁结果。

插件使用硅基流动云端语音识别和 Edge TTS。它不是独立的浏览器扩展，也不需要单独运行一个后台服务。

## 安装前准备

- Node.js 22.19 或更高版本（安装 DSH CLI 时使用）。
- 一个已经可以运行的 DSH Web profile。
- 一个硅基流动 API Key。插件使用当前免费的语音转文字模型 [`XingChenAGI/XingChenASR-V3.2-Ultra`](https://cloud.siliconflow.cn/models?target=XingChenAGI/XingChenASR-V3.2-Ultra)，但仍需用户自行申请 Key；免费状态和使用规则以硅基流动模型页面为准。
- 支持麦克风的现代浏览器。

如果还没有 DSH CLI，先安装：

```powershell
npm install -g @deepseek-ai/dsh
```

## 方式一：从 npm 安装（推荐）

这是普通用户最简单的安装方式。只安装公开的单一插件包，不需要下载或修改本仓库源码：

```powershell
dsh plugin --profile web add @flowingspring/dsh-voco
```

安装完成后启动 DSH Web：

```powershell
dsh web
```

打开终端显示的本地地址，在会话中点击麦克风并允许浏览器使用麦克风即可。

## 方式二：通过 GitHub Release 安装

GitHub Release 提供和 npm 相同的预构建插件包，不需要 clone 源码或准备 pnpm 开发环境：

```powershell
dsh plugin --profile web add https://github.com/lgquan/dsh-voco/releases/download/v0.3.6/flowingspring-dsh-voco-0.3.6.tgz
```

Release 页面：[v0.3.6](https://github.com/lgquan/dsh-voco/releases/tag/v0.3.6)

无论选择哪种安装方式，最后都通过 DSH 启动 Web UI：

```powershell
dsh web
```

## 配置硅基流动 API Key

插件只需要一个密钥：`SILICONFLOW_API_KEY`。请先在[硅基流动控制台](https://siliconflow.cn/)申请自己的 API Key。语音转文字使用硅基流动当前免费的 [`XingChenAGI/XingChenASR-V3.2-Ultra`](https://cloud.siliconflow.cn/models?target=XingChenAGI/XingChenASR-V3.2-Ultra)；免费状态和使用规则以后续模型页面为准。不要把真实密钥写进源码、提交到 GitHub，或发送给其他人。

### 推荐配置：DSH 设置页面

启动 DSH 后打开“设置 → 插件 → 插件配置”，展开“语音助手（Voco）”，填写 API Key 并保存。密钥写入 DSH 的凭据库，不会写进普通设置文件，界面也不会读回密钥明文。保存后重新开启或重连语音即可生效。

下面的环境变量和 `.env` 方式继续保留，适合自动化或已有部署。

### 临时配置：当前 PowerShell 会话

在启动 DSH 的同一个终端中设置：

```powershell
$env:SILICONFLOW_API_KEY = "sk-your-api-key"
dsh web
```

关闭该终端后，变量会失效。

### 持久配置：DSH 用户环境文件

可以创建 DSH 用户目录下的 `.env`。默认位置是 Windows 的 `%USERPROFILE%\.dsh\.env`（如果设置了 `DSH_HOME`，则使用 `$DSH_HOME/.env`）：

```dotenv
SILICONFLOW_API_KEY=sk-your-api-key
```

也可以在执行 `dsh web` 的当前目录创建 `.env`。DSH 凭据服务会读取这些环境层，插件在每次新建语音连接时通过凭据服务解析 `SILICONFLOW_API_KEY`。无需进入 npm 安装目录，也不要修改 `node_modules` 中的文件。

如果同时设置了系统环境变量、DSH 凭据库和 `.env`，已经继承的环境变量优先，其次是 DSH 凭据库。修改 `.env` 后请重启 `dsh web`，因为环境在进程启动时读取一次。

## 安装后怎么使用

1. 运行 `dsh web` 并打开 DSH Web UI。
2. 新建或选择一个会话。
3. 点击麦克风按钮并允许浏览器权限。
4. 直接说话；连续静音约 1.5 秒后，当前语句会提交给云端识别。也可以长按麦克风约 400 毫秒按住说话，松手后只提交这一段；未连接时长按会在提交后保持静音，以便接收语音回复。
5. 普通聊天由前台处理，需要读写项目或运行工具的工作会交给后台 Agent。

语音会话可以被打断、断线重连和恢复历史。每个语音会话会持续绑定自己的后台 Agent Session；上下文达到轮换阈值时，插件会为后续任务创建新的子会话，但仍归属于同一语音会话。

## 更新

使用 npm 更新到最新版本：

```powershell
dsh plugin --profile web add @flowingspring/dsh-voco
```

也可以改用指定的 GitHub Release `.tgz` 地址。更新后重启 `dsh web`。

## 卸载

```powershell
dsh plugin --profile web remove @flowingspring/dsh-voco
```

卸载插件不会自动删除已经保存的 API Key。需要彻底清除时，从 `%USERPROFILE%\.dsh\.credentials.yaml`（设置了 `DSH_HOME` 时为 `$DSH_HOME/.credentials.yaml`）的 `refs` 下删除 `SILICONFLOW_API_KEY`，并同时清理系统环境变量或 `.env` 中的同名配置。

卸载插件不会删除已经保存的 DSH 会话和语音历史；如需清理数据，请先确认对应数据目录后再手动处理。

## 主要能力

- SiliconFlow 免费模型 [`XingChenAGI/XingChenASR-V3.2-Ultra`](https://cloud.siliconflow.cn/models?target=XingChenAGI/XingChenASR-V3.2-Ultra) 云端语音转文字。
- Edge TTS `zh-CN-XiaoxiaoNeural` 中文语音回复。
- 语音、文字和后台 Agent 任务可以在同一 DSH 会话中协作。
- 委派前即时播报确认语，完整报告保留在任务界面。
- 页面切换、断线重连和 DSH 重启后恢复语音会话绑定。
- 可选接入 `@flowingspring/dsh-workspace-memory`；语音主会话和每个完成的委派子任务都会进入同一个 Workspace 长期记忆范围。

## 常见问题

### 点击麦克风提示缺少 API Key

确认启动 DSH 的进程能读到 `SILICONFLOW_API_KEY`。如果刚创建或修改了 `.env`，先停止旧的 DSH 进程，再重新运行 `dsh web`。

### 浏览器没有声音或无法录音

检查当前页面是否获得麦克风权限、系统输入设备是否正常，并确认使用的是 `dsh web` 提供的页面，而不是直接打开 HTML 文件。

### 识别失败或等待时间较长

语音识别需要访问硅基流动网络服务。请检查网络、API Key 有效期、账户额度，以及所选模型和 Provider 的响应延迟。

### 想调整静音和起音阈值

高级参数位于插件 profile 的 `cordis.patch.yml`，包括 `silenceDurationMs`、`speechThreshold`、`minSpeechDurationMs` 和 `maxUtteranceMs`。普通用户通常不需要修改这些参数。

## 可选 Workspace Memory

长期记忆不是 Voco 的必需依赖。需要时另外安装 `@flowingspring/dsh-workspace-memory`；只安装 Voco 也可以独立使用。安装 Memory 后，完成的委派任务会提交用户原始请求和最终可见结果，不会提交 reasoning、工具日志或注入上下文。Memory 插件的安装和配置请参阅其项目文档。

## 开发与反馈

- 源码与问题反馈：[GitHub](https://github.com/lgquan/dsh-voco)
- npm 包：[`@flowingspring/dsh-voco`](https://www.npmjs.com/package/@flowingspring/dsh-voco)
- 架构说明：[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

## 许可证

[MIT](LICENSE)
