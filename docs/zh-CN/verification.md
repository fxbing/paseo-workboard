# 验证记录

English: [English](../verification.md)

本文记录 Workboard 当前可复现的验证证据，不代表已经覆盖全部 Paseo 平台、主题或宿主集成。

## 未验证分支

`read-inactive-agent-metadata-history` 分支（schema v9）通过了确定性测试：**410 个单元测试、28 个文件**，格式检查也通过；但其隔离宿主集成运行和真实 provider 验证尚未记录在本文中。该改动只询问已经处于运行状态的 agent，宿主侧行为仍需真实 provider 确认。

## 已验证基线

2026-10-13，在 macOS arm64 上通过 `mise` 使用 Node 22.22.2 检查了双视图源码，schema 仍为 v8。

```sh
mise exec -- npm run check
```

该命令通过，包含 **398 个单元测试、28 个文件**。确定性测试覆盖 v1–v7 到 v8 的迁移、列内排序持久化与重置、完整列 CAS、筛选下的拖动锚点、紧凑模式排序控件、乐观更新失败恢复、归档恢复与证据、设置安全、移动撤销竞态和独立的 Start work 默认组。双视图新增覆盖 host 隔离偏好、独立折叠、快速创建文本及错误保留、筛选后的列表锚点与滚动坐标、分组和任务移动、取消及延迟测量竞态、共享排序、任务行动作和最近一次移动过期。客户端 handler 测试替换 primitive 与宿主边界，不能证明实际 React 焦点、渲染或浏览器布局。

## 隔离真宿主集成

2026-10-13，双视图 worktree 源码在全新 marker home 的 Paseo **0.11.2** 上通过 **13/13 项隔离集成测试，30.69s**，随后停止临时 daemon。本次从源码目录安装，未验证已发布包或客户端渲染；客户端改动未新增 RPC 或 schema 迁移。

历史记录：2026-09-28，当时源码在 Paseo 0.10.0-beta.1 上通过 **12 个隔离集成测试**；已发布的 0.1.0 源码此前在 0.9.1 上通过同一套测试。当时覆盖自定义分组持久化和颜色、标签驱动状态、进行中置顶所有权、草稿创建和重载、未写标签的 Inbox 导入、草稿开始工作、受保护的归档行为，以及干净托管 worktree 的归档路径。

2026-10-08，最终 schema v8 源码在全新 marker home 中使用 Paseo **0.11.1**，通过 **13/13 项隔离集成测试，30.88s**。覆盖已归档父会话的 upper-bound 契约、新鲜 worktree ownership、真实排序 RPC、插件 reload、过期顺序拒绝与 reset 经宿主存储的行为。SDK 依赖仍为 0.10.0-beta.1；本次证明的是 0.11.1 上已测试的 fixture 行为，不代表完成 SDK 迁移。

另一次真实宿主 v7→v8 升级完整保留了 16 个 fixture 任务、原设置和其它数据。完整比对仅出现预期的存储及数据 schema 版本变化、新增空 `cardOrderByStage` 和 null `defaultStartWorkGroup`。两个临时 daemon 均已停止。

只能按[集成测试说明](../../tests/integration/README.zh-CN.md)中的临时 home 和 marker 流程复现。测试 fixture 是确定性 provider：它重放 fixture 历史，绝不发送模型请求。

## 界面检查

2026-10-13，在 Paseo **0.11.2** 上使用隔离 home
`/tmp/workboard-list-g8eWnC`，通过 Chrome 实际检查了新增列表视图。开启
`features.webUi.enabled` 后，daemon 根路径返回 HTTP 200 并加载插件。此前的
HTTP 404 是因为启动时未开启 Web UI；准备期间浏览器工具也曾返回
`net::ERR_BLOCKED_BY_CLIENT`，但该错误不代表最终 daemon 或 Chrome 的结果。

实际渲染检查通过的行为包括：列表连续组内任务拖动、向折叠分组（含空组）跨组拖动、八秒移动撤销、分组拖动后看板共享顺序、切换视图时保留快速创建文本、列表与看板分别记忆折叠状态、筛选计数与无匹配提示，以及 `Alt+Down` 排序。390px 布局分别检查了中文浅色主题和英文深色主题。

真实界面检查发现，折叠或排序后浏览器的 `onLayout.y` 可能保留旧值。拖动几何现根据当前分组及任务顺序和实测高度重建位置。新增两项交互回归：使用旧实现时失败，修复后通过，分别覆盖折叠改变分组位置、排序改变任务行位置且未触发仅位置变化的 layout 事件。

其它隔离本地 home 可用以下命令开启 daemon 自带的 Web UI，并重启选中的 daemon：

```sh
paseo daemon config set features.webUi.enabled true --home /path/to/test-home
paseo daemon restart --home /path/to/test-home
```

若选中的 daemon 尚未运行，改用
`paseo daemon start --home /path/to/test-home`，然后在本机浏览器打开其配置的 HTTP 地址。新增列表视图尚未实际验收长时间边缘自动滚动、拖动途中的 `Escape` 或失焦、原生移动端客户端和 Electron。

以下检查早于列表视图，继续作为看板的历史证据保留。

桌面客户端已在浅色、深色主题下人工检查；另在 390px 窄屏宽度下检查响应式看板、分组定位与折叠、组合筛选、快速创建 Todo、设置反馈、上下文提示和紧凑控件的键盘操作。

2026-09-24 在独立 Paseo 0.9.1 Web 客户端检查了语言跟随：系统中文、明确选择英文和简体中文时，看板文案均符合预期。在另一标签页修改宿主语言后，已打开的归档页面无需刷新即可更新文案与日期。插件设置页已无语言选项，自定义分组名称和任务标题保持原文。

## 发布包检查

2026-10-13，**0.3.0** 候选通过 `check`、`format:check` 和 `check:package`：**398 项单测**、**37 个批准的包文件**、**105,807 bytes**。解压后的所有文件均与已审查源码逐字节一致。解压包不安装开发依赖，在全新 marker home 的 Paseo **0.11.2** 上通过 **13/13 项集成测试，31.89s**。生产依赖审计无漏洞；未改动的开发依赖仍有待处理的审计项。

已验证 tarball 的 SHA-256 为 `d0b29afd2f8ef3f8517622f75a816e727b3da9e2d12d5e8754efc8ead1a85425`。这些检查证明的是发布候选；npm 发布、registry 安装和 GitHub Actions 结果需要分别核验。

2026-10-08，0.2.0 候选通过 `check`、`format:check` 和 `check:package`：356 项单测、32 个批准的包文件、92,969 bytes。包内文件逐一匹配已审查源码。实际 tarball 解压后不安装开发依赖，在全新 marker home 的 Paseo 0.11.1 上通过 13 项集成测试（29.22s），随后停止 daemon。发布状态及 registry 安装需要单独核验。

2026-09-24 的 `0.1.0` npm tarball 包含 31 个批准的运行源码与公开文档文件。解压包不带 `node_modules`，已安装到全新、带标记且仅监听 loopback 的 Paseo 0.9.1 daemon。插件达到 `running`，针对该包的 12 个集成测试全部通过，测试后已停止临时 daemon。

同一次真实插件安装还将预置的 v4 配置迁移至 v5：移除了旧语言字段，保留了 fixture 任务、自定义分组和其它偏好。

`npm run check:package` 对当时的发布候选验证通过。另用一次性副本验证了漏装运行模块、额外文件混入包时均被拒绝。格式及本地文档链接检查通过。0.1.0 随后已发布到 npm。这些本地检查不证明当前 npm 或 GitHub Actions 状态；Cafe 目录更新与 npm 发布是独立状态。

## 未验证边界

- 尚未验证原生 iOS 和 Android。
- 尚未在 Electron 中检查新增列表视图。
- 尚未在真实渲染界面中检查长时间边缘自动滚动，以及拖动途中的 `Escape` 或失焦。
- 尚未人工检查 Paseo 0.10.0-beta.1 客户端界面。
- 尚未验证真实远端 PR/MR 合并触发 Paseo 原生归档的路径。
- 未证明全部自定义 Paseo 主题、未来 SDK 版本或所有远端 MR/PR 状态变化的行为。
- 单元测试和 fixture 集成测试不能代替真实外部模型或 forge 服务的端到端验证。

修改兼容性桥接前，应重新执行已支持版本的检查，并为受影响宿主行为补充证据。使用 `mise exec -- npm run check:package` 验证包内容；它不会发布。
