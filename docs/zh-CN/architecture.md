# 架构

[English](../architecture.md) · [README](../../README.zh-CN.md)

Workboard 是受信任的 Paseo 插件，客户端和服务端使用独立入口。daemon 负责保存任务数据和执行自动化；客户端展示所选 host 的看板，仅在本地保存显示偏好。

## 模块

| 位置                                              | 职责                                             |
| ------------------------------------------------- | ------------------------------------------------ |
| `index.client.tsx`                                | 侧栏、设置页、Command Center 入口和查询 provider |
| `client/`                                         | 看板、表单、筛选、拖拽、主题和翻译               |
| `index.server.ts`                                 | 注册设置、RPC handler 与服务端生命周期           |
| `server/workboard.ts`                             | 对账、串行变更、绑定、置顶和归档决策             |
| `server/host.ts`                                  | Paseo 清单、订阅、历史和 workspace 操作          |
| `server/paseo-compat.ts`                          | 桥接公开 SDK 尚未提供的宿主操作                  |
| `server/conversations.ts`、`server/git-safety.ts` | 对话时间与归档前检查                             |
| `server/store.ts`、`shared/migrations.ts`         | revision 校验保存与数据迁移                      |
| `shared/model.ts`、`shared/rpc.ts`                | Zod 模型、设置与 RPC 契约                        |

## 身份与状态

任务使用插件生成的 ID。未绑定草稿没有 `workspaceId`，绑定后的任务由 host 与 workspace ID 唯一确定。名称、分支和路径不用于确定身份；一个 workspace 内多个 Agent 仍只有一张卡片。

daemon 分页导入全部活跃 workspace。没有受管理分组标签的 workspace 进入默认待归类组，导入时不写标签；显式标签决定分组，同时存在多个分组标签时展示冲突。普通标签保留。安装前已归档且插件从未观察过的 workspace 不会补录。

每个分组有稳定 ID、名称、受管理标签、业务类型与可选颜色。显示顺序和颜色独立于类型；类型决定草稿落点、进行中侧栏置顶和终态归档资格。至少保留一个待归类组和一个待开始组；删除分组前必须移走任务。

Agent 活动单独展示，回复结束不会把任务标为完成。PR/MR 信息来自 Paseo workspace 数据；Workboard 不额外轮询 forge，也不实现另一套合并检测。

## 保存与并发

host settings 使用 schema version 5，保存任务、分组、偏好、绑定/归档意图和插件拥有的置顶时间戳。Version 5 移除旧的宿主共享语言偏好。Store 校验数据，并以宿主 settings revision 为基线保存。迁移保留既有记录；不支持或损坏的数据会阻止正常初始化，不会被静默替换。

服务端用同一队列串行处理变更和对账。订阅合并受影响 workspace 的变化，每 60 秒完整刷新补齐遗漏事件。客户端轮询不拥有归档定时器；状态变更先乐观展示，再按服务端结果确认或回退。

分组编辑和排序通过期望配置拒绝过时写入；任务编辑校验 `updatedAt`，状态转换校验请求所依据的受管理标签。Paseo 0.9.1 没有带条件的原子标签/归档操作，最终检查后仍可能发生原生界面并发修改。

## 草稿绑定

创建草稿只写插件数据。创建请求可指定任意待开始类型组；省略时使用默认待开始组。

开始工作会保存操作 ID，并使用 Paseo 幂等创建 workspace。可以创建不带 Agent 的 workspace，也可以关联已有 workspace。标签同步失败时保留绑定，重试不会再建 workspace；关联已导入 workspace 时合并到现有卡片并保留备注。

## 自动化保护

侧栏自动置顶默认开启，按 `in-progress` 分组类型判断。插件记录 Paseo 返回的精确 `pinnedAt`，仅取消仍归自己拥有的置顶；已有或被手动替换的置顶保留。用户手动取消自动置顶后，任务本次处于进行中期间不会被再次置顶，离开并重新进入后才恢复自动行为。

自动归档默认关闭。任务必须位于已完成/已废弃类型组，且距离 workspace 所有 Agent 中最后一条已核实的用户或助手消息严格超过 30 天。修改标签、编辑备注和导入 workspace 不重置时间。草稿及没有对话证据的 workspace 不具备资格。

每个 Agent 的对话存成两个互不替代的值：卡片展示用时间，和自动归档可用的门禁。展示证据可以是精确的用户/助手消息、下界（`≥`，来自 Paseo 记录的用户消息时间或部分回放窗口里较早的行），或上界（`≤`，Paseo 记录的活动时间）。门禁证据为精确时间，或以 Paseo 记录的活动时间作上界——它不会早于真实最后一条消息，因此只会推迟归档；下界永远不参与门禁。Paseo 会用回放时的水合时刻重打历史行的戳，因此比记录活动时间更新的行按水合戳剔除，而不是让整个 workspace 失败；已记录的观测值也永远只作下界，不作门禁。

调用原生归档前，服务端再次核对标签、活动和 workspace 安全状态。活跃 Agent、terminal、脚本、无法证明任何上界的历史或不安全 Git 状态会延期；Git 检查不会修补工作区或推送代码。超时或中断的归档意图记为结果未知，不盲目重试。成功必须同时有原生成功响应及刷新后退出活跃 workspace 清单的证据。

原生归档可能停止 Agent/terminal 并清理托管 worktree。插件记录归档结果，但不保证目录清理或完整恢复；Paseo 原生合并后归档开关仍由 Paseo 管理。

## 兼容边界

公开 SDK 尚未覆盖所有所需操作。兼容模块复用插件现有的已认证 IPC 会话，完成标签、置顶、settings 写入、启动初始化及部分历史/记录查询；不另建登录、不替换凭证、不修改 Paseo。

manifest 定义 Paseo 最低版本。桥接校验响应结构，但不固定宿主版本；后续版本可能需要适配。已测试的宿主与剩余边界记录在[验证说明](verification.md)和 Cafe 信息中。

运行时使用固定插件 ID `paseo-workboard`；安装时不要通过 `--id` 覆盖。

客户端使用 Paseo 提供的 React、React Native、TanStack Query、Zod 和插件模块；服务端使用宿主 SDK/Zod 与 Node 内置模块。发布包包含 TypeScript 源码，由 Paseo 处理，因此不需要构建步骤或安装运行时 npm 依赖。

## 客户端偏好

Paseo 0.9.1 没有公开插件语言 API。`client/paseo-language.ts` 只读 Web/Electron 的 `@paseo:app-settings` 语言，必要时回退旧 key，不写入宿主设置。它采用 Paseo 的系统语言选择规则，提供中文与英语文案。页面挂载期间通过 storage/focus 事件及每秒检查捕获同窗口语言变化。升级 Paseo 时须重新验证这一私有存储约定；没有该存储的客户端（包括原生移动端）回退到英语。

列宽、折叠和筛选按 host 存在浏览器 `localStorage` 中，与 daemon settings 分离。存储失败不影响本次使用，不同客户端之间不自动同步。原生手机端的持久化和触控尚不在已验证平台范围内。

证据见[验证说明](verification.md)，修改这些边界的要求见[贡献指南](../../CONTRIBUTING.zh-CN.md)。
