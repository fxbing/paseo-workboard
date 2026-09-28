# 发布

[English](../releasing.md) · [README](../../README.zh-CN.md)

已发布的 `paseo-workboard@0.1.0` 面向 Paseo **0.9.1**。当前 checkout 含尚未发布的兼容性改动；最低版本以 manifest 为准，已验证宿主见[验证说明](verification.md)。准备新候选版本不等于发布到 npm 或提交 Paseo Cafe。

## 发布包约定

Paseo 加载 TypeScript 客户端/服务端入口及相对模块，所有外部运行时依赖由 Paseo 或 Node 提供。开发依赖保留在 `devDependencies`，无需 manifest 构建命令或编译后的分发目录。参见 [Paseo 发布指南](https://paseo.sh/docs/plugins/publishing)。

npm 包包含 manifest、入口、`client/`、`server/`、`shared/`、中英文 README、更新日志和 MIT 许可证。测试、开发脚本、daemon 数据、日志、凭证与 `node_modules` 不进入发布包。

`npm run check:package` 检查包身份/版本、manifest 最低版本、Cafe 提取所需 README 标题以及完整文件清单。从 checkout 发布时，`prepublishOnly` 还运行 TypeScript、单元测试和格式检查。CI 执行这些检查并生成可下载 tarball，不自动发布 npm 或提交 Cafe。

## 验证发布候选

1. 同步更新 `package.json` 与 `package-lock.json`。每次发布变更都使用新的正式语义版本；同步更新两份更新日志与中英文文档。
2. `requirements.paseo` 应设置预期的最低版本；扩大范围前在当前目标宿主运行集成测试。内部桥接校验响应结构，但无法保证后续 Paseo 版本始终兼容。
3. 在干净 checkout 中运行：

   ```sh
   mise install
   mise exec -- npm ci
   mise exec -- npm run check
   mise exec -- npm run format:check
   mise exec -- npm run check:package
   WORKBOARD_RELEASE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/workboard-release.XXXXXX")"
   mise exec -- npm pack --pack-destination "$WORKBOARD_RELEASE_DIR"
   ```

4. 按[隔离集成测试指南](../../tests/integration/README.zh-CN.md)启动带标记的临时 Paseo home。将生成的包解压到另一个临时目录，并安装到隔离 daemon；不要给解压包安装开发依赖：

   ```sh
   WORKBOARD_PACKAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/workboard-package.XXXXXX")"
   tar -xzf "$WORKBOARD_RELEASE_DIR/paseo-workboard-0.1.0.tgz" -C "$WORKBOARD_PACKAGE_DIR"
   paseo plugin install "$WORKBOARD_PACKAGE_DIR/package" --home "$WORKBOARD_INTEGRATION_HOME"
   paseo plugin ls --home "$WORKBOARD_INTEGRATION_HOME" --json
   mise exec -- npm run test:integration
   ```

   文件名替换为本次版本。要求插件 `running`、看板已连接且集成测试通过；视觉行为仅用虚构任务检查。先停止隔离 daemon，再删除其 home 和解压包。

5. 审阅 tarball 与 Git diff，排除本机数据，并在[验证说明](verification.md)中记录实际平台和检查结果。本地通过不等于 GitHub Actions 已运行或 npm 安装已验证。

## 发布源码与 npm

发布需要目标 GitHub 仓库权限和 npm 包名发布权限。查到名称尚未使用不代表当前账号具备权限；真正发布时完成账号检查，仓库不保存发布凭证。

生成最终发布包前，核对 README 安装说明并为更新日志填写发布日期，再重复上述验证。将该源码放到公开 GitHub 仓库默认分支，并为同一版本创建 tag，例如 `v0.1.0`。Cafe 检查默认分支的包与 manifest，只有 tag 不能让未发布的功能分支成为目录来源。将已经验证的 tarball 发布到公开 npm registry：

```sh
npm publish "$WORKBOARD_RELEASE_DIR/paseo-workboard-0.1.0.tgz" --access public --registry https://registry.npmjs.org/
npm view paseo-workboard@0.1.0 version dist.integrity --registry https://registry.npmjs.org/
```

随后在隔离 daemon 验证 registry 安装：

```sh
paseo plugin install npm:paseo-workboard@0.1.0 --home "$WORKBOARD_INTEGRATION_HOME"
paseo plugin ls --home "$WORKBOARD_INTEGRATION_HOME" --json
mise exec -- npm run test:integration
```

不要复用已发布 npm 版本；发布说明更新也应保持 GitHub 与 npm 的版本及插件 ID 一致。

## 提交 Paseo Cafe

Cafe 是社区目录。当前[提交要求](https://paseo.cafe/submit/)包含公开 GitHub 仓库，以及插件 ID 和版本匹配的公开 npmjs 包；仅本地打包或建立 GitHub 仓库不够。

[paseo-cafe.json](../paseo-cafe.json)提供已准备的表单数据。它是提交候选，放在本仓库不会自动注册；初始平台声明为已验证宿主集成的 macOS，其它平台验证后再补充。

1. 打开提交页，填写 registry ID `paseo-workboard`、仓库 `fxbing/paseo-workboard`、npm 包 `paseo-workboard`，子路径留空。
2. 从 JSON 复制分类、平台及 caveats，检查表单生成的完整 GitHub Issue 与确认项后再提交。
3. Cafe bot 创建 registry PR，准入检查源码、manifest、npm 包和安全扫描；提交不保证收录。
4. 合并后检查生成的目录页和安装命令，后续更新继续遵循版本与打包验证流程。

Cafe 从英文 README 提取安装和限制内容，因此保留 `## Installation`、`## Limitations` 标题。`images/` 下的截图和演示视频为可选项；使用真实产品画面及公开或虚构数据。
