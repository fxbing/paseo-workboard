# 贡献指南

English: [English](CONTRIBUTING.md)

感谢改进 Workboard。本仓库当前面向 Paseo 0.9.1；除非变更同时完成明确的兼容性更新，请保持 manifest 和三个 Paseo SDK 包使用已验证版本。

## 环境与检查

通过 `mise` 使用项目运行时：

```sh
mise install
mise exec -- npm ci --ignore-scripts
mise exec -- npm run check
mise exec -- npm run format:check
```

`npm run check` 会运行 TypeScript 和单元测试。开发时先运行最小相关测试，提交 PR 前运行完整检查。请在发布或涉及打包的变更前运行 `npm run check:package`；它只检查待发布包，不会发布。

## 变更边界

- 常规单元测试必须确定性运行，不能依赖 daemon、浏览器、网络服务、模型或个人 Paseo home。
- 真宿主集成测试只能使用带 marker 的一次性临时 Paseo home，见[集成测试说明](tests/integration/README.zh-CN.md)。
- 不要把集成变量指向日常 Paseo home。该套件会修改自己的 fixture provider 并创建测试 workspace。
- 使用现有 React Native primitive 和 `theme` 颜色，紧凑控件保持现有的 36px 最小点击区。
- 公共 SDK 和 React Native API 已能完成的小型 UI 行为，不新增依赖。

## 架构与兼容性

先阅读[架构说明](docs/zh-CN/architecture.md)，再查看[验证记录](docs/zh-CN/verification.md)了解当前证据和边界。server 负责持久化看板投影和原生写入；client 是跟随主题的 React Native 界面。版本敏感集成集中在 `server/paseo-compat.ts`（宿主操作）和 `client/paseo-language.ts`（Web/Electron 语言设置）。

修改该兼容性边界时，必须补充已支持 Paseo 版本的测试；支持范围或证据变化时也要更新验证或发布文档。不能仅凭 TypeScript 类型推断兼容性。

打包和发布请遵循[发布说明](docs/zh-CN/releasing.md)。
