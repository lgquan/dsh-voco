# dsh-market 插件收录提交指南

## 结论

`dsh-market` 是插件市场客户端，不直接维护插件清单。市场中的插件数据来自社区索引仓库 [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)。申请收录时，应向该仓库提交 Pull Request（PR），为每个插件新增一份 `data/plugins/*.yml` 文件。

本次两个插件可以放在同一个 PR 中提交：

- `@flowingspring/dsh-voco@0.3.12`（待发布）
- `@flowingspring/dsh-workspace-memory@0.2.14`

中文介绍写在各自 YAML 的 `description.zh` 中。市场仓库的中英文 README 由脚本自动生成，不要手工修改。

## 官方规则

规则来源：

- [awesome-dsh-plugin 贡献指南](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)
- [awesome-dsh-plugin 仓库](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
- [dsh-market 仓库](https://github.com/dsh-market/dsh-market)

当前与本次提交直接相关的要求如下：

1. 每个插件新增一份 `data/plugins/*.yml`，不要直接编辑生成的 README。
2. 必填字段为 `url`、`name`、`category` 和 `description.en`；建议同时填写 `description.zh`。
3. 描述应准确说明功能，以句号结尾，不使用“最好”“最强”等营销性表述。
4. 插件的 `package.json` 必须声明 `dsh.bundle`，只有 `dsh.client` 不符合安装要求。
5. 仓库需创建满 1 天、至少有 10 次提交，并包含真实可运行代码。
6. GitHub 仓库必须添加 `dsh-plugin` topic。
7. 一个 PR 最多提交 3 个插件条目，本次两个插件可以放在同一个 PR 中。
8. CI 通过只是前置条件；维护者还会核对代码是否与描述一致、分类是否合理，以及源码是否存在明显风险。

## 提交前资格检查

| 检查项 | dsh-voco | dsh-workspace-memory |
| --- | --- | --- |
| GitHub 仓库 | `lgquan/dsh-voco` | `lgquan/dsh-workspace-memory` |
| 当前 NPM 版本 | `0.3.12`（待发布） | `0.2.14` |
| `dsh.bundle` | 根 `package.json` 已声明，`packages/voice-app` 为私有构建源 | 根 `package.json` 已声明 |
| 提交数 | 116，满足至少 10 次 | 21，满足至少 10 次 |
| 最早本地提交 | 2026-08-24 | 2026-08-29 |
| `dsh-plugin` topic | GitHub 页面可见 | 当前 GitHub 页面未发现，需要添加 |
| GitHub Release `.tgz` | 待发布 `v0.3.12` 资产 | 已有 `v0.2.14` 资产 |

仓库年龄最终以市场 CI 查询到的 GitHub 仓库创建时间为准。按当前日期和项目历史判断，两个仓库应已满足 1 天要求。

## 建议提交内容

### dsh-voco

`dsh-voco` 使用 monorepo 开发，但仓库根目录本身就是公开的 `@flowingspring/dsh-voco` NPM 包和 bundle 安装入口。内部 `packages/voice-app` 仅作为私有构建源，不应暴露为市场子目录。市场 URL 应指向完整项目主页，名称使用公开插件名 `lgquan/dsh-voco`。

文件名：

```text
data/plugins/lgquan__dsh-voco.yml
```

文件内容：

```yaml
url: https://github.com/lgquan/dsh-voco
name: lgquan/dsh-voco
category: voice
description:
  en: Continuous voice conversations for DSH with hands-free listening, push-to-talk, speech recognition, TTS replies, and background Agent delegation.
  zh: 为 DSH 提供持续语音对话，支持免提监听、按住说话、语音识别、TTS 语音回复和后台 Agent 任务委派。
```

这段介绍只说明插件能够实现的语音交互效果和主要技术能力，不绑定具体 ASR 平台或模型，后续更换服务时不需要因此更新市场描述。市场条目不填写固定版本的 `tarball`，安装统一跟随根目录公开 NPM 包的最新版本；GitHub Release 仅作为项目发布归档和人工下载渠道。

### dsh-workspace-memory

文件名：

```text
data/plugins/lgquan__dsh-workspace-memory.yml
```

文件内容：

```yaml
url: https://github.com/lgquan/dsh-workspace-memory
name: lgquan/dsh-workspace-memory
category: memory
description:
  en: Workspace-isolated durable memory for DSH, with searchable, auditable, correctable, and removable workspace memories plus controlled global memory.
  zh: 为 DSH 提供工作区隔离的持久化记忆，让每个工作区拥有可检索、可审计、可纠错和可删除的独立记忆，并支持受控的全局记忆。
tarball: https://github.com/lgquan/dsh-workspace-memory/releases/download/v0.2.14/flowingspring-dsh-workspace-memory-0.2.14.tgz
```

## 提交步骤

### 1. 补齐 GitHub topic

先处理 `dsh-workspace-memory`：

1. 打开 [lgquan/dsh-workspace-memory](https://github.com/lgquan/dsh-workspace-memory)。
2. 在仓库首页右侧 `About` 区域点击设置图标。
3. 在 `Topics` 中添加 `dsh-plugin`。
4. 保存并刷新页面确认 topic 已显示。

`dsh-voco` 页面当前已能看到 `dsh-plugin`，提交前再目视确认一次即可。

### 2. Fork 市场索引仓库

1. 打开 [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)。
2. 点击 `Fork`，在 `lgquan` 账号下创建副本。
3. 从 fork 的 `main` 新建分支，例如 `add-lgquan-plugins`。

### 3. 新增两个 YAML 文件

只新增本指南给出的两个文件，不修改其他插件条目，也不手工修改 `README.md` 或 `README.zh-CN.md`。

官方说明允许不在本地生成 README；PR 合并后会在 `main` 上自动生成。如需本地预览，可按贡献指南运行：

```sh
npm ci
node scripts/generate-readme.mjs
```

### 4. 提交 PR

建议 PR 标题：

```text
Add dsh-voco and dsh-workspace-memory
```

建议 PR 说明：

```markdown
Adds two DeepSeek Harness plugins maintained by lgquan:

- dsh-voco: persistent voice conversations with speech recognition, TTS replies, and Agent delegation.
- dsh-workspace-memory: workspace-scoped durable memory with retrieval and audit support.

Both repositories declare `dsh.bundle`, have published NPM packages, and provide prebuilt GitHub Release tarballs.
```

提交后等待 CI。若维护者要求调整描述或分类，只修改对应的 YAML 条目并继续推送到同一分支，PR 会自动更新。

## NPM、Release 与截图说明

- NPM 发布不是市场收录的硬性条件，但预构建包能减少安装时的构建授权步骤。两个插件已经发布到 NPM，不需要在当前 YAML 中额外填写 `npm` 字段。
- `tarball` 是可选字段。两个插件已有 GitHub Release 托管的 `.tgz`，本指南使用固定 tag URL，后续发布新版本不会使现有链接失效。
- 后续如果希望市场展示效果图，可以按官方贡献指南在插件 `package.json` 旁添加可选的 `screenshots.json`，使用 1 至 8 张由 GitHub 托管的图片。截图不是本次收录的必要条件。

## 提交前最终清单

- [ ] `dsh-workspace-memory` 已添加 `dsh-plugin` topic。
- [ ] `dsh-voco` 的 `dsh-plugin` topic 仍然存在。
- [ ] fork 已同步官方仓库最新 `main`。
- [ ] PR 只新增两个 `data/plugins/*.yml` 文件。
- [ ] 英文和中文描述均以句号结尾，且与当前代码能力一致。
- [ ] 两个 Release tarball URL 均可下载。
- [ ] CI 全部通过。
- [ ] 已根据维护者评论完成必要调整。
