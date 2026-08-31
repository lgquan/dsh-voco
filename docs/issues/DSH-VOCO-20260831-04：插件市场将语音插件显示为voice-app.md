# DSH-VOCO-20260831-04：插件市场将语音插件显示为 voice-app

## 问题信息

- 发现日期：2026-08-31
- 复现方式：在 dsh-market 搜索 `dsh-voco`
- 相关模块或代码：`awesome-dsh-plugin/data/plugins/lgquan__dsh-voco--packages-voice-app.yml`
- 状态：处理中
- 验证情况：仓库根入口已实施并通过自动化、打包安装和真实 Web 启动验证；等待市场更正 PR 合并后完成最终验证

## 问题描述

插件已经收录并能通过 `dsh-voco` 搜索到，但市场卡片标题显示为内部 monorepo 目录名 `voice-app`，而不是公开插件名 `dsh-voco`。卡片链接还错误地使用了不存在的 `main` 分支，打开后返回 404。

## 证据与复现

已合并的市场条目使用以下字段：

```yaml
url: https://github.com/lgquan/dsh-voco/tree/main/packages/voice-app
name: lgquan/dsh-voco#voice-app
```

`awesome-dsh-plugin` 发布的实时目录将其规范化为 `dsh-voco#voice-app`。dsh-market 的 `pluginName()` 对包含 `#` 的名称取井号后路径的最后一段作为卡片标题，因此最终显示 `voice-app`。仓库默认分支实际为 `master`；`https://github.com/lgquan/dsh-voco/tree/main/packages/voice-app` 返回 404，而对应的 `master` 子目录 URL 返回 200。

## 影响

- 用户看到的是内部目录名，无法直观对应仓库、NPM 包和设置中的 `dsh-voco` 名称。
- 点击卡片标题无法打开源码页面。
- 搜索和 Release tarball 安装仍然可用，插件功能不受影响。

## 原因判断

首次提交时把贡献指南中的 `owner/repo#subname` 示例机械映射成了物理目录名。对当前只有一个公开插件的 monorepo，这个内部目录名不适合作为面向用户的展示名称。

`dsh-workspace-memory` 与 `dsh-voco` 的表现不同，是因为两者的仓库入口结构不同：

- `dsh-workspace-memory` 的根 `package.json` 就是公开插件包，并声明了 `dsh.bundle`，所以市场可以同时把仓库主页作为展示链接和源码安装入口。
- `dsh-voco` 的根 `package.json` 是 `private: true` 的 pnpm 开发工作区，没有声明 `dsh.bundle`；真正的公开插件包和 bundle manifest 位于 `packages/voice-app`。因此当前市场条目只能按 monorepo 子包处理。

`awesome-dsh-plugin` 的 `url` 同时用于卡片链接和源码安装命令，没有独立的 `homepage` 字段。其提交校验明确拒绝“URL 指向仓库根，但根 `package.json` 没有 `dsh.bundle`”的条目，因为生成的 `dsh plugin --profile web add github:lgquan/dsh-voco` 命令不会激活任何插件。

## 解决方案

目标市场条目应改为：

```yaml
url: https://github.com/lgquan/dsh-voco
name: lgquan/dsh-voco
```

保持分类、描述和 Release tarball 不变。这样市场卡片显示 `dsh-voco`，点击后进入完整项目主页，而不是内部子包目录。

在提交市场更正前，先把 `dsh-voco` 仓库根目录补成真实可用的安装入口：

1. 根 `package.json` 声明 `dsh.bundle`，版本与当前公开插件版本一致，并依赖已发布的 `@flowingspring/dsh-voco`。
2. 根目录提供与公开包一致的 `cordis.patch.yml`，负责组合语音插件的各个运行模块；增加自动检查，避免根入口配置与 `packages/voice-app/cordis.patch.yml` 漂移。
3. 用 Git 源码安装和打包安装分别验证根入口，确认服务端模块、Web 客户端和设置入口均可加载。
4. 将市场数据文件从子包命名改为仓库根命名，再提交更正 PR。

这个根入口不是另一个对外插件，也不是把多份第三方插件聚合起来的空壳；它是同一 `dsh-voco` 项目的仓库级安装入口，实际行为仍由本项目发布的 `@flowingspring/dsh-voco` 包提供。

## 处理记录

- 2026-08-31：确认实时目录数据和 dsh-market 名称显示逻辑，确定问题由 `#voice-app` 引起。
- 2026-08-31：确认仓库默认分支为 `master`，原条目的 `main` 子目录链接返回 404。
- 2026-08-31：对比 `dsh-workspace-memory`，确认其根目录本身声明 `dsh.bundle`，而 `dsh-voco` 根目录只是未声明 bundle 的 monorepo 工作区，这是两个市场链接表现不同的直接原因。
- 2026-08-31：在独立 `DSH_HOME` 中验证当前 `dsh-voco` 根目录安装，DSH 提示 `declares no dsh.bundle`，安装后不会加入 profile bundle stack。
- 2026-08-31：完成最小仓库根入口原型。预构建包安装和 Git 源码安装均能把根入口加入 bundle stack、加载六个 Voco 配置项、启动独立 Web 服务，并发现 `@flowingspring/dsh-voco` 客户端；客户端脚本请求返回 HTTP 200。
- 2026-08-31：在根 `package.json` 中增加 `dsh.bundle`、固定版本的 `@flowingspring/dsh-voco` 依赖和最小打包文件列表，并增加根 `cordis.patch.yml`。
- 2026-08-31：扩展分发测试，要求仓库根版本、公开包版本、依赖版本和两份 patch 内容始终一致。
- 2026-08-31：`pnpm test` 通过，共 15 个测试文件、147 个测试；`pnpm typecheck` 和 `pnpm build` 通过。测试期间仍有上游 `dsh-client-ui-primitives` 缺少 source map 的既有 Vite 警告，不影响测试结果。
- 2026-08-31：将根入口打成最小 tarball 后安装到独立 `DSH_HOME`，确认 profile bundle stack 包含 `dsh-voco`，依赖树包含 `@flowingspring/dsh-voco@0.3.8`。使用独立端口启动 Web 后，首页模块图发现 Voco 客户端，`/plugins/@flowingspring/dsh-voco/client.js` 返回 HTTP 200。
- 2026-08-31：提交并推送仓库根入口，提交为 `e6e2ec3`。随后使用实际远程命令 `dsh plugin --profile web add github:lgquan/dsh-voco` 在独立 `DSH_HOME` 中复验通过，并再次确认 Web 客户端可发现、客户端脚本返回 HTTP 200。
- 2026-08-31：向 `awesome-dsh-plugin` 提交更正 PR [#3984](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/3984)，把条目文件改为 `data/plugins/lgquan__dsh-voco.yml`，并将 `url` 和 `name` 分别改为仓库主页和 `lgquan/dsh-voco`。官方 `Submission gate` 与常规 `check` 均已通过，等待维护者合并。
- 2026-08-31：发布 `@flowingspring/dsh-voco@0.3.9`，使仓库根安装入口依赖的公开 NPM 包版本与根项目版本保持一致。NPM 远程 `latest` 已指向 `0.3.9`，远程 tarball 的 SHA-1 `2c446f0fdc5acd80adedceadb21c5775d1e8f337` 与本地发布前打包结果一致。
- 2026-08-31：更新 `pnpm-lock.yaml` 后确认根依赖解析为 `@flowingspring/dsh-voco@0.3.9`；发布后再次执行测试、类型检查和构建验证。

## 后续低优先级优化

- 可向 `awesome-dsh-plugin` / `dsh-market` 建议把展示主页与源码安装子目录拆成两个字段，从数据模型上改善其他 monorepo 插件的展示体验；这不作为本次修正的前置条件。
