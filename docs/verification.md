# Verification

中文：[中文](zh-CN/verification.md)

This document records the current reproducible evidence for Workboard. It is
not a claim that every Paseo platform, theme, or host integration has been
tested.

## Verified baseline

On 2026-10-08, the final schema-v8 source was checked on macOS arm64 with
Node 22.22.2 through `mise`.

```sh
mise exec -- npm run check
```

This command passed with **356 unit tests in 26 files**. The deterministic suite
covers migrations from v1–v7 to v8, persistent column order and reset, complete
column compare-and-swap, filtered drag anchors, compact reorder controls,
optimistic failure recovery, archive recovery and evidence, settings safety,
stage undo races, and independent Start work defaults. Client handler tests use
primitive and host boundaries; they do not prove actual React focus, rendering,
or browser layout.

## Isolated host integration

Historically, on 2026-09-28, that source passed **12 isolated integration tests** against
Paseo 0.10.0-beta.1. The published 0.1.0 source had passed the same suite on
Paseo 0.9.1. That run covered custom-group persistence and colors, label-driven
stages, in-progress pin ownership, draft creation and restart, Inbox import
without writing a label, starting a draft, guarded archive behavior, and a
clean managed-worktree archive path.

On 2026-10-08, the final schema-v8 source passed **13/13 isolated integration
tests in 30.88s** against Paseo **0.11.1** in a fresh marked home. This includes
the archived-parent upper-bound contract, fresh worktree ownership, real
sorting RPCs, plugin reload, stale-order rejection, and reset through host
storage. The SDK dependencies remain at 0.10.0-beta.1; this run establishes
the tested fixture behavior on 0.11.1, not a complete SDK migration.

A separate real-host upgrade of existing v7 storage to v8 preserved all
16 fixture tasks and all previous settings and other data exactly. Only the
storage and data schema versions changed, with empty `cardOrderByStage` and
null `defaultStartWorkGroup` added. Both temporary daemons were stopped.

Reproduce it only with the marked temporary-home procedure in
[the integration guide](../tests/integration/README.md). The test fixture is a
deterministic provider: it replays fixture history and never sends a model
request.

## Visual checks

These are historical checks; they do not cover the current design fixes.
Those changes have deterministic handler and property checks only.

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

On 2026-10-08, the 0.2.0 candidate passed `check`, `format:check` and
`check:package`: 356 unit tests and 32 approved package files, 92,969 bytes.
All packaged files matched the reviewed source. The actual tarball was
unpacked without development dependencies and installed in a new marked
Paseo 0.11.1 home: all 13 integration tests passed in 29.22s, and the daemon
was stopped. Publication and registry installation require separate checks.

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
passed. The 0.1.0 package was later published to npm. These local checks do not establish the current npm or GitHub Actions status;
Cafe catalog promotion remains separate from npm publication.

## Unverified boundaries

- Native iOS and Android behavior has not been exercised.
- The Paseo 0.10.0-beta.1 client UI has not been manually checked.
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
