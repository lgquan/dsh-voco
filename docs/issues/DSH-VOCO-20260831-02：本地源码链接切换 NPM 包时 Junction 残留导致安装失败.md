# DSH-VOCO-20260831-02：本地源码链接切换 NPM 包时 Junction 残留导致安装失败

## 问题信息

- 发现日期：2026-08-31
- 发现会话或复现方式：本地 `link:` 验收完成后，在 Windows Web profile 中执行 NPM 包重装
- 相关模块或代码：`C:\Users\QUAN\.dsh\profiles\web\node_modules\@flowingspring\dsh-voco`，DSH profile 的 pnpm 安装流程
- 状态：已解决
- 验证情况：移除残留 Junction 后，`@flowingspring/dsh-voco@0.3.7` 安装成功并读取正确版本

## 问题描述

本地源码链接切换为已发布 NPM 包时，`dsh plugin remove` 更新了 profile 清单，但旧的 `node_modules\@flowingspring\dsh-voco` Junction 仍然存在。随后执行 `dsh plugin add @flowingspring/dsh-voco@0.3.7`，pnpm 在导入临时目录时尝试建立 workspace 依赖链接并返回 `ERR_PNPM_EPERM`。

## 证据与复现

第一次安装失败：

```text
[ERR_PNPM_EPERM] [importPackage C:\Users\QUAN\.dsh\profiles\web\node_modules\@flowingspring\dsh-voco]
EPERM: operation not permitted, symlink 'D:\QUAN\DevCode\Python\Project\dsh\dsh-voco\packages\ui-voice' ->
'C:\Users\QUAN\.dsh\profiles\web\node_modules\@flowingspring\dsh-voco_tmp_19432_11\node_modules\@flowingspring\dsh-client-ui-voice'
```

当时 Junction 目标仍是：

```text
D:\QUAN\DevCode\Python\Project\dsh\dsh-voco\packages\voice-app
```

## 影响

只影响同一个 Windows profile 从本地源码 `link:` 切换到 registry 包的开发验收流程。普通用户直接从 NPM 安装时不会有此前的本地 Junction。

## 原因判断

DSH 的 remove 操作移除了 profile 配置中的依赖，但在该异常状态下没有清理对应的旧 Junction；pnpm 随后无法原子替换这个 reparse point，并将已发布包中的 workspace 开发依赖解析为本地链接。

## 解决方案

核验 Junction 目标确实是本仓库的 `packages/voice-app` 后，仅删除该 Junction，确认仓库目标目录仍存在，再执行：

```powershell
dsh plugin --profile web add @flowingspring/dsh-voco@0.3.7 --config.minimum-release-age=0
```

## 处理记录

- 先停止使用本地源码的 DSH 进程。
- 用 `dsh plugin remove` 清理 profile 配置；该命令成功但遗留 Junction。
- 核验 Junction 的完整目标路径后删除链接本身，没有删除仓库目录。
- 重新执行 NPM 安装，profile 依赖变为 `0.3.7`，`node_modules` 下为实体包目录。

## 验证结果

- `npm view @flowingspring/dsh-voco version` 返回 `0.3.7`，`latest` 指向 `0.3.7`。
- Web profile 安装命令成功完成。
- `C:\Users\QUAN\.dsh\profiles\web\node_modules\@flowingspring\dsh-voco\package.json` 报告版本 `0.3.7`。
- 使用该 NPM 包重新启动 DSH 后，真实 Web 页面仍显示 Voco 设置卡、API Key 密码框及硅基流动模型说明；无继承环境变量时输入框可编辑且初始为空。

## 后续低优先级优化

- DSH/pnpm 可考虑在本地链接与 registry 包切换时显式清理旧 Junction，并在 Windows 上增加该场景的安装回归测试。
