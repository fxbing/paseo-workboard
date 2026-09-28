# Contributing

中文：[中文](CONTRIBUTING.zh-CN.md)

Thank you for improving Workboard. `paseo-plugin.json` owns the minimum Paseo
version. Keep the three Paseo SDK development packages aligned with a tested
host version, and run isolated host integration tests when changing the bridge.

## Setup and checks

Use the project runtime through `mise`:

```sh
mise install
mise exec -- npm ci --ignore-scripts
mise exec -- npm run check
mise exec -- npm run format:check
```

`npm run check` runs TypeScript and the unit suite. Run the smallest relevant
test while iterating, then run the full check before opening a pull request.
Run `npm run check:package` before a release or a package-related change; it
verifies the publishable package without publishing anything.

## Change boundaries

- Keep ordinary unit tests deterministic. They must not require a daemon,
  browser, network service, model, or personal Paseo home.
- Run host integration tests only against a disposable, marked temporary Paseo
  home. See [the integration guide](tests/integration/README.md).
- Do not point integration variables at a normal Paseo home. The suite changes
  its fixture provider and creates test workspaces.
- Use the existing React Native primitives and `theme` colors. Preserve the
  36px minimum interactive target used by compact controls.
- Do not add dependencies for a small UI behavior when the public SDK and
  React Native API already cover it.

## Architecture and compatibility

Start with [the architecture guide](docs/architecture.md), then check
[verification](docs/verification.md) for current evidence and limits. The
server owns the durable board projection and native mutations; the client is a
theme-aware React Native surface. Version-sensitive integration lives in
`server/paseo-compat.ts` for host operations and `client/paseo-language.ts` for
the Web/Electron language setting.

Changes to that compatibility boundary must include tests for the supported
Paseo version and an update to the verification or release documentation when
the supported range or evidence changes. Do not infer compatibility from TypeScript
types alone.

For packaging and release work, follow [the release guide](docs/releasing.md).
