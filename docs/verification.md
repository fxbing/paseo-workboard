# Verification

中文：[中文](zh-CN/verification.md)

This document records the current reproducible evidence for Workboard. It is
not a claim that every Paseo platform, theme, or host integration has been
tested.

## Verified baseline

The latest recorded baseline used macOS arm64, Node 22.22.2 through `mise`, and
Paseo app and daemon 0.9.1.

```sh
mise exec -- npm run check
```

This command passed with **123 unit tests in 16 files**. The suite exercises
the board model, persistence and migrations, native-label projection,
workspace and draft flows, archive and pin ownership safeguards, filters, and
client layout preferences, Paseo language resolution and subscriptions, and
removal of the legacy language preference. It is deterministic and does not require a daemon
or a model.

## Isolated host integration

The latest recorded host run passed **12 isolated integration tests** against
Paseo 0.9.1. It covered custom-group persistence and colors, label-driven
stages, in-progress pin ownership, draft creation and restart, Inbox import
without writing a label, starting a draft, guarded archive behavior, and a
clean managed-worktree archive path.

Reproduce it only with the marked temporary-home procedure in
[the integration guide](../tests/integration/README.md). The test fixture is a
deterministic provider: it replays fixture history and never sends a model
request.

## Visual checks

The desktop client was manually checked in light and dark themes. A separate
390px narrow-screen check covered the responsive board, group navigation and
collapse, combined filters, quick Todo creation, settings feedback, contextual
hints, and compact keyboard controls.

The language change was checked in a separate Paseo 0.9.1 Web client on
2026-09-24. System Chinese, explicit English, and explicit Simplified Chinese
produced the expected board text. An already-open archive page changed its
labels and dates after the host language changed in another tab, without a
reload. The plugin settings page had no language control, and custom group
names and task titles were preserved.

## Release package checks

On 2026-09-24, the `0.1.0` npm tarball contained 31 approved runtime and public
documentation files. The unpacked package was installed without `node_modules`
into a new marked, loopback-only Paseo 0.9.1 daemon. The plugin reached
`running`, and all 12 integration tests passed against that installed package.
The temporary daemon was stopped after the run.

A preseeded v4 settings file also migrated to v5 through that real plugin
installation. Its legacy language field was removed while the fixture task,
custom group, and remaining preferences were preserved.

`npm run check:package` passed for the release candidate. Separate disposable
copies confirmed that it rejects an omitted runtime module and an unexpected
file added to the package. Formatting and local documentation links also
passed. The CI workflow is configured but has not been run on GitHub; npm
publication, npm-source installation and Cafe admission remain separate,
unexecuted release steps.

## Unverified boundaries

- Native iOS and Android behavior has not been exercised.
- A real remote PR/MR merge triggering Paseo's native archive has not been
  exercised.
- The checks do not establish behavior for every custom Paseo theme, future
  SDK versions, or all remote MR/PR state transitions.
- Unit and fixture integration coverage do not replace an end-to-end test with
  a real external model or forge service.

Before changing the compatibility bridge, repeat the supported-version checks
and add evidence for the affected host behavior. For package validation, run
`mise exec -- npm run check:package`; it validates package contents without
publishing.
