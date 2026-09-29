# User guide

[中文](zh-CN/user-guide.md) · [README](../README.md)

## Task model

An active Paseo workspace is one Workboard task. Imported workspaces that do not have a managed status label go to **Inbox**; import itself does not add a label.

A draft is a task without a workspace. Create it with a title to capture work for later. By default, new drafts and workspaces with an explicit `task:todo` label use **To do**. A draft may move to Inbox without binding. Moving it into another work group asks you to create or attach a workspace.

Task status is a business decision. Agent states such as running, waiting for input, or error are shown separately. Ending an Agent session never marks a task done.

## Work with tasks

### Create and start

Create a draft from the board or the quick-create control in a To do group. A draft has no workspace, conversation, or Agent until you choose **Start work**.

Start work by creating a new workspace or attaching an existing one. A new workspace keeps the draft title and description. An attached workspace keeps its workspace name; the draft title and description are added to its notes, so it remains one task. Starting work does not create an Agent or send a message. The default start group is the first group with the In progress type; configure groups first if none exists.

### Change status

Each group has a managed workspace label. In the default mapping, those labels are:

| Type        | Default label      |
| ----------- | ------------------ |
| Inbox       | `task:inbox`       |
| To do       | `task:todo`        |
| In progress | `task:in-progress` |
| Review      | `task:review`      |
| Done        | `task:done`        |
| Canceled    | `task:canceled`    |

Use the status menu or drag a desktop card by its handle. Moving a bound task updates its managed label; changing that native label also updates the board. Regular labels are retained. If more than one managed status label is present, Workboard reports a conflict and lets you choose one status to resolve it.

Desktop dragging starts after 6px, shows a card preview, highlights a target, and autoscrolls near the horizontal edge. Press `Esc`, leave the window, or release outside the board to cancel. Each group is ordered by last activity: bound tasks use the last verified conversation, drafts use their last edit, and workspaces with no conversation stay last. Manual ordering within a group is not supported.

## Use the board

On desktop and Web, Workboard follows Paseo's language setting. Chinese and English are supported; other Paseo languages fall back to English. When Paseo follows the system language, Workboard follows the same locale selection. There is no separate plugin language setting. Built-in group names and dates change with the UI; custom group names, task titles and notes stay as entered.

### Read cards

Cards show task title, project, activity, and the latest conversation date. A `≥` or `≤` prefix means Paseo only supports a bound there: `≥` is the recorded last user message or the oldest rows of a partially replayed window, `≤` is Paseo's recorded activity. Workboard never shows Paseo's recorded activity as if it were the message time. Expand a card for labels, Agents, and a full PR/MR title. When Paseo supplies it, the card also shows PR/MR state, CI result, and review decision using native-style icons. Workboard does not query your forge directly. A merged or closed PR/MR does not change task status.

Needs attention covers waiting, error, and unread activity; label or synchronization conflicts; conversation, archive, Git, terminal, or directory problems that need verification; and an open or draft PR/MR with failed CI or requested changes. Merged, closed, and unavailable PR/MR data never trigger attention from an older CI result. Focus, hover, or tap an explanatory icon for its reason.

### Filter and adjust the view

Filter by project, text, attention, Agent activity, or PR/MR condition. Filters are local to the current client and Paseo host. Empty filtered results can clear the active filters or create a task.

On desktop, groups can be reordered, resized, collapsed, colored, and located. Column width and collapsed state are local client preferences scoped to the current host. Collapsing only changes the display. A successful card drop into a collapsed group expands it again.

The locate-groups button opens a group list. Selecting a desktop group expands it and scrolls to its column; on a narrow layout it selects that group. Narrow layouts use one group at a time. Arrow keys move between groups, and `Home` and `End` jump to the first or last group.

## Configure groups

Groups have a name, type, managed label, and display color. Color is purely visual: it does not change labels, task rules, pinning, or archival. Workboard uses the same group color in column headers, card accents, status choices, narrow tabs, and group settings. New groups recommend an unused color first, then the least-used color.

Keep at least one Inbox group and one To do group. Inbox receives unmanaged workspaces. To do receives drafts and, under the default mapping, explicit `task:todo` workspaces. Deleting a group requires moving its tasks first. Group changes take effect when the group dialog saves; general switches save immediately.

Reordering groups changes only their display order. It does not change the default draft destination or which In progress group Start work chooses.

## Archive workspaces

Automatic archival is off by default. The switch saves immediately; when tasks are already due, Workboard asks for confirmation before enabling it. Once enabled, Workboard considers only tasks in Done or Canceled groups whose last verified user or assistant conversation is more than 30 days old, measured against Paseo's recorded activity when the exact message time is unavailable. It does not use a label-change time, task edit time, tool call, or import time as conversation activity, and a displayed `≥` bound is never used to archive.

Before archiving, Workboard defers when no conversation bound can be proven or the workspace has active/waiting Agents, terminals, running scripts, or unsafe or unverified Git state. It never stashes, commits, pushes, or deletes files itself.

An automatic archive uses Paseo's native workspace archive. That can stop Agents and terminals and may remove a managed worktree. Success requires a native response with `error=null` and `archivedAt`, followed by a refresh in which the workspace leaves the native active list. Uncertain outcomes remain visible for manual review and are not blindly retried.

An unbound draft in a Canceled group can be manually archived from the board. It has no native workspace, does not wait 30 days, and cannot restore a worktree.

Paseo's native **Archive merged PR workspaces** setting is separate. It follows its own merge observations and safety checks, does not wait 30 days, and does not set a Workboard task to Done.

## Pin In progress workspaces

The sidebar-pin setting is enabled by default. It follows the group's **In progress** type, not Agent runtime state. Workboard adds a sidebar pin when a task enters an In progress group and removes only a pin that it can identify as its own when the task leaves.

Manual pins are preserved. If you manually remove an automatic pin while the task remains In progress, Workboard does not force it back during that stay; leaving and re-entering the group can apply it again. Disabling the setting removes Workboard-owned pins and retains manual pins.

The native pin API has no ownership or compare-and-set operation. When an operation is uncertain because of a crash or concurrent native change, Workboard keeps the pin rather than risk removing a manual one.

## Limits and support boundaries

- The plugin manifest sets the minimum Paseo version. Its internal label bridge may require changes later; see [verification](verification.md) for tested hosts.
- Local filters, column widths, and collapsed columns are stored per client and host; they are not shared task data.
- Workspace labels and native archive/pin operations can change outside Workboard. The plugin rechecks state where possible, but native APIs do not provide every atomic operation.
- Paseo 0.9.1 refuses the provider-subagent API for archived parents, and its pi provider replays history without per-row timestamps, so Workboard falls back to displayed bounds and defers only when no bound can be proven.
