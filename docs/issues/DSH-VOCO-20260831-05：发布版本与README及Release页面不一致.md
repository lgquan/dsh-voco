# DSH-VOCO-20260831-05：发布版本与 README 及 Release 页面不一致

## 问题信息

- 发现日期：2026-08-31
- 复现方式：发布 `@flowingspring/dsh-voco@0.3.9` 后查看 GitHub README、GitHub Releases 和 NPM 包页面
- 相关模块或代码：根目录及 `packages/voice-app` 的中英文 README、包版本、GitHub Release 发布流程
- 状态：已解决
- 验证情况：NPM `latest`、GitHub README、NPM README、GitHub Latest Release 和公开 tarball 均已验证为 `0.3.10`

## 问题描述

`@flowingspring/dsh-voco@0.3.9` 已发布到 NPM，但发布时只更新了包清单和锁文件，没有同步更新四份公开 README 中的 GitHub Release 安装链接，也没有创建对应的新 GitHub Release。NPM 页面使用已发布包内的 README，因此同样显示旧的 `v0.3.8` Release 信息。

## 影响

- GitHub 项目主页和 NPM 包页面展示的安装版本落后于实际 `latest`。
- 用户按 README 中的 Release 命令会安装旧的 `0.3.8` 包。
- GitHub 最新 Release 与 NPM `latest` 无法互相对应，降低发布信息可信度。

## 原因判断

现有分发测试只约束仓库根入口版本、公开包版本、依赖版本和两份 `cordis.patch.yml` 一致，没有覆盖 README 中的版本化 Release URL。发布流程也没有把 NPM 发布、README 更新、Release tarball 和 GitHub Release 视为同一个原子发布单元。

## 解决方案

1. 统一升级到 `0.3.10`，同步根安装入口、公开 NPM 包、锁文件策略和市场指南。
2. 将根目录及公开包的四份中英文 README 全部改为 `v0.3.10` Release 页面和 tarball 地址。
3. 在分发测试中根据公开包版本动态检查四份 README 的 Release URL，防止再次漂移。
4. 发布 `@flowingspring/dsh-voco@0.3.10`，创建并推送 `v0.3.10` tag，上传与 NPM 内容一致的预构建 tarball并创建 GitHub Release。
5. 分别验证 NPM `latest`、GitHub Release 页面、Release 资产和 README 链接。

## 处理记录

- 2026-08-31：确认根 `README.md`、`README.en.md`、`packages/voice-app/README.md` 和 `packages/voice-app/README.zh.md` 均仍引用 `v0.3.8`。
- 2026-08-31：确定已发布的 NPM `0.3.9` 无法原地替换 README，采用 `0.3.10` 补丁版本统一修复所有公开发布面。
- 2026-08-31：四份 README、根安装入口、公开包版本、市场指南和锁文件均已更新为 `0.3.10`；新增分发测试，根据公开包版本动态校验 README 中的 Release 页面及 tarball URL。
- 2026-08-31：发布 `@flowingspring/dsh-voco@0.3.10`。NPM `latest` 已指向 `0.3.10`，远程 SHA-1 为 `bd1bf161045612ab180570cc39f1e4b4e67906d5`，与用于 GitHub Release 的本地 tarball 一致；NPM 远程 README 已确认显示 `v0.3.10` 安装链接。
- 2026-08-31：发布后 `pnpm install --frozen-lockfile`、148 项测试、TypeScript 类型检查和完整构建均通过。测试仍显示上游 `dsh-client-ui-primitives` 缺少 source map 的既有警告，不影响结果。
- 2026-08-31：提交 `c66c545` 和 `v0.3.10` tag 已推送；GitHub Release [dsh-voco v0.3.10](https://github.com/lgquan/dsh-voco/releases/tag/v0.3.10) 已发布并标记为 Latest，包含 `flowingspring-dsh-voco-0.3.10.tgz`。
- 2026-08-31：从公开 Release 地址重新下载资产验证。下载文件与本地发布文件的 SHA-1 均为 `bd1bf161045612ab180570cc39f1e4b4e67906d5`，SHA-256 均为 `5b80ece9a4fabd7705657d45537c5f252b841978efef5de583a5dedf62535404`。
