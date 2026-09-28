# 隔离 Paseo 集成测试

English: [English](README.md)

本套件独立于 `npm test`，只通过 `npm run test:integration` 运行 `*.integration.ts` 文件，并要求已有一个正在运行、隔离且版本满足 `paseo-plugin.json` 的 Paseo daemon。

## 准备临时 home

在系统临时目录下创建一次性 home，并写入只监听 loopback 的 daemon 配置。若 `6768` 已被占用，可改为另一个未占用的本地端口。

```sh
WORKBOARD_INTEGRATION_HOME="$(mktemp -d "${TMPDIR:-/tmp}/paseo-workboard.XXXXXX")"
export WORKBOARD_INTEGRATION_HOME
printf '%s\n' paseo-workboard-integration-v1 > "$WORKBOARD_INTEGRATION_HOME/.paseo-workboard-integration"
printf '%s\n' '{"daemon":{"listen":"127.0.0.1:6768"},"pluginsEnabled":true}' > "$WORKBOARD_INTEGRATION_HOME/config.json"
```

以该 home 设置 `PASEO_HOME` 后启动目标 Paseo 版本，在其中安装当前 checkout，并确认插件正在运行：

```sh
PASEO_HOME="$WORKBOARD_INTEGRATION_HOME" paseo daemon start --home "$WORKBOARD_INTEGRATION_HOME"
paseo plugin install --home "$WORKBOARD_INTEGRATION_HOME" .
paseo status --home "$WORKBOARD_INTEGRATION_HOME" --json
```

在仓库根目录运行：

```sh
mise exec -- npm run test:integration
```

harness 会拒绝系统临时目录外的 home、缺失或错误的 marker、非 loopback 监听、未报告版本的 daemon，以及未运行的 Workboard 插件。测试运行期间，它不会启动、停止或回退到其它 daemon。

准备阶段会只在这个带 marker 的 home 中安装 `fixture-provider`。该 provider 提供确定性的历史和响应，绝不请求模型。套件会创建测试 workspace 并修改 fixture-provider 状态，绝不能使用个人或共享 daemon home。

## 停止并删除临时 home

删除 home 前必须先停止隔离 daemon。停止命令失败时，应保留目录用于排查；daemon 仍可能使用目录时不要删除。

```sh
if paseo daemon stop --home "$WORKBOARD_INTEGRATION_HOME"; then
  rm -rf "$WORKBOARD_INTEGRATION_HOME"
fi
```
