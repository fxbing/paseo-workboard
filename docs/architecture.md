# Architecture

[中文](zh-CN/architecture.md) · [README](../README.md)

Workboard is a trusted Paseo plugin with separate client and server entries. The daemon owns task data and automation. Each client renders the selected host's board and keeps only its display preferences locally.

## Modules

| Location                                          | Responsibility                                                               |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| `index.client.tsx`                                | Sidebar, settings screen, Command Center entry and query provider            |
| `client/`                                         | Board, forms, filters, drag interactions, themes and translations            |
| `index.server.ts`                                 | Settings registration, RPC handlers and server lifecycle                     |
| `server/workboard.ts`                             | Reconciliation, serialized mutations, binding, pinning and archive decisions |
| `server/host.ts`                                  | Paseo inventory, subscriptions, history and workspace operations             |
| `server/paseo-compat.ts`                          | Access to host operations missing from the public SDK                        |
| `server/conversations.ts`, `server/git-safety.ts` | Conversation timestamps and pre-archive checks                               |
| `server/store.ts`, `shared/migrations.ts`         | Revision-checked persistence and data migration                              |
| `shared/model.ts`, `shared/rpc.ts`                | Zod models, settings and RPC contracts                                       |

## Identity and state

A task has a plugin-generated ID. An unbound draft has no `workspaceId`; a bound task is unique by host and workspace ID. Names, branches and paths do not establish identity. Multiple agents in one workspace remain one task.

The daemon imports every active workspace across all pages. A workspace without a managed group label enters the default Inbox group without a label write. Explicit managed labels select groups; multiple managed labels produce a visible conflict. Unrelated labels are preserved. Archived workspaces that Workboard never observed are not backfilled.

Groups have stable IDs, a name, a managed label, a semantic type and an optional color. Display order and color are independent of type. Types control draft destinations, in-progress sidebar pinning and terminal archive eligibility. At least one Inbox and one Todo group remain; a group must be empty before deletion.

Agent activity is a separate projection. A reply finishing never marks a task done. PR/MR information comes from Paseo's workspace data; Workboard does not poll forge services or implement a separate merge detector.

## Persistence and concurrency

Host settings store schema version 5, including tasks, groups, preferences, binding/archive intents and owned pin timestamps. Version 5 removes the former host-wide language preference. The store validates data and writes against the host settings revision. Migrations preserve existing records; unsupported or invalid data stops normal initialization instead of silently replacing it.

One server-side queue serializes mutations and reconciliation. Subscriptions coalesce affected workspace changes, and a 60-second refresh reconciles missed events. Polling clients do not own archive timers. The client uses optimistic stage changes, then confirms or rolls back using the server result.

Group edits and ordering use expected configuration values to reject stale writes. Task edits check `updatedAt`; status changes check the managed labels they were based on. Concurrent native edits can still occur after the final check because Paseo 0.9.1 does not provide a conditional atomic label/archive operation.

## Draft binding

Creating a draft writes only plugin data. A create request may select any Todo-type group; omitted groups use the default Todo target.

Starting work persists an operation ID and uses Paseo's idempotent workspace creation. It either creates a workspace without an agent or attaches an existing one. The workspace link is retained if label synchronization fails, so retrying does not create another workspace. Attaching an already imported workspace merges the draft into its existing card and preserves notes.

## Automation safeguards

Sidebar pinning is enabled by default and follows the `in-progress` group type. Workboard records the exact `pinnedAt` value returned by Paseo. It removes only a pin it still owns; an existing or manually replaced pin remains. A user removing an automatic pin suppresses repinning until the task leaves and re-enters that type.

Automatic archive is disabled by default. Eligibility requires a Done/Canceled-type group and strictly more than 30 days since the latest verified user or assistant message across the workspace's agents. Changing labels, editing notes or importing a workspace does not reset this clock. Drafts and workspaces without verified conversation time do not qualify.

The server rechecks labels, activity and workspace safety before calling native archive. Active agents, terminals, scripts, unavailable history or unsafe Git state defer the operation. Git checks do not repair the working tree or push changes. The persisted archive intent becomes uncertain after a timeout or interrupted operation; it is not blindly retried. Success requires a native success response and disappearance from a refreshed active workspace list.

Native archive may stop agents/terminals and remove a managed worktree. Workboard records archive status but does not guarantee directory cleanup or restoration. Paseo's independent archive-on-merge setting remains under Paseo's control.

## Compatibility boundary

The public SDK does not expose every required operation. The compatibility module uses the plugin's existing authenticated IPC session for labels, pins, settings writes, bootstrap and selected history/record queries. It does not create a second login, replace credentials or modify Paseo.

The manifest owns the minimum Paseo version. The bridge validates response shapes but does not pin a host version. Later versions may require a compatibility change; record tested hosts and remaining limits in [verification](verification.md) and the Cafe listing.

The runtime uses the fixed plugin ID `paseo-workboard`; install it without an `--id` override.

Client imports use Paseo-provided React, React Native, TanStack Query, Zod and plugin modules. The server uses the provided SDK/Zod and Node built-ins. The published package contains TypeScript sources; Paseo prepares them, so there is no build step or runtime npm dependency installation.

## Client preferences

Paseo 0.9.1 has no public plugin locale API. `client/paseo-language.ts` reads the Web/Electron app's `@paseo:app-settings` language, with its legacy key as a fallback, without writing host settings. It uses Paseo's system-locale selection rules and translates Chinese or English. While a surface is mounted, storage/focus events and a one-second check observe changes in the same window. Revalidate this private storage contract when upgrading Paseo. Clients without that storage, including native mobile, fall back to English.

Column widths, collapsed columns and filters are stored per host in browser `localStorage`, independently from daemon settings. Storage failures leave the current view usable. These preferences are not synchronized between clients. Native mobile persistence and touch behavior are outside the verified platform coverage.

See [verification](verification.md) for evidence and [contributing](../CONTRIBUTING.md) for changes to these boundaries.
