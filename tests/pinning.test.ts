import { expect, it, vi } from "vitest";
import { Workboard } from "../server/workboard";
import { Store } from "../server/store";
import { DEFAULT_GROUPS, settingsSchema } from "../shared/model";
import { fixture, workspace } from "./fixtures";

async function enabled(board: Workboard, value: boolean) {
  const current = board.snapshot();
  await board.mutate({
    action: "settings",
    revision: current.revision,
    settings: { ...current.settings, pinInProgressWorkspaces: value },
  });
}

it("pins by native task group, persists ownership, and unpins after leaving the group", async () => {
  const { board, host, inventory, backing, now } = fixture();
  inventory.workspaces.push(
    workspace("in-progress", "Idle agent", ["task:in-progress"]),
    workspace("running"),
  );
  inventory.agents.push({
    id: "agent",
    workspaceId: "running",
    activity: "running",
    title: "Working",
    updatedAt: new Date(now()).toISOString(),
    lastUserMessageAt: null,
  });
  let reopened: Workboard | undefined;
  await board.start();
  try {
    expect(host.setPinned).toHaveBeenCalledExactlyOnceWith("in-progress", true);
    expect(inventory.workspaces[0].pinnedAt).toBeTruthy();
    board.dispose();
    reopened = new Workboard(host, new Store(backing), now);
    await reopened.start();
    expect(host.setPinned).toHaveBeenCalledTimes(1);
    inventory.workspaces[0].labels = ["task:review"];
    await reopened.refresh();
    expect(host.setPinned).toHaveBeenLastCalledWith("in-progress", false);
    expect(inventory.workspaces[0].pinnedAt).toBeNull();
  } finally {
    board.dispose();
    reopened?.dispose();
  }
});

it("keeps manual pins and respects a manual unpin until the task leaves and re-enters In progress", async () => {
  const { board, host, inventory, store } = fixture();
  const manual = {
    ...workspace("manual", "Manual", ["task:in-progress"]),
    pinnedAt: "2026-01-01T00:00:00Z",
  };
  const automatic = workspace("automatic", "Automatic", ["task:in-progress"]);
  inventory.workspaces.push(manual, automatic);
  await board.start();
  try {
    expect(host.setPinned).toHaveBeenCalledExactlyOnceWith("automatic", true);
    automatic.pinnedAt = null;
    await board.refresh();
    await board.refresh();
    expect(host.setPinned).toHaveBeenCalledTimes(1);
    manual.labels = [];
    automatic.labels = [];
    await board.refresh();
    expect(manual.pinnedAt).toBe("2026-01-01T00:00:00Z");
    expect(store.current.autoPins).toEqual({});
    automatic.labels = ["task:in-progress"];
    await board.refresh();
    expect(host.setPinned).toHaveBeenCalledTimes(2);
    automatic.pinnedAt = "2026-12-01T00:00:00Z";
    automatic.labels = [];
    await board.refresh();
    expect(automatic.pinnedAt).toBe("2026-12-01T00:00:00Z");
    expect(host.setPinned).toHaveBeenCalledTimes(2);
  } finally {
    board.dispose();
  }
});

it("supports custom In progress groups, releases owned pins on disable, and ignores conflicts", async () => {
  const { board, host, inventory } = fixture({
    settings: settingsSchema.parse({
      groups: [
        ...DEFAULT_GROUPS,
        {
          id: "building",
          kind: "in-progress",
          name: "Building",
          label: "work:building",
        },
      ],
    }),
  });
  inventory.workspaces.push(
    workspace("custom", "Custom", ["work:building"]),
    workspace("conflict", "Conflict", ["task:in-progress", "task:done"]),
  );
  await board.start();
  try {
    expect(host.setPinned).toHaveBeenCalledExactlyOnceWith("custom", true);
    await enabled(board, false);
    expect(inventory.workspaces[0].pinnedAt).toBeNull();
    await board.refresh();
    expect(host.setPinned).toHaveBeenCalledTimes(2);
    await enabled(board, true);
    expect(host.setPinned).toHaveBeenCalledTimes(3);
    inventory.workspaces[0].labels.push("task:done");
    await board.refresh();
    expect(inventory.workspaces[0].pinnedAt).toBeNull();
  } finally {
    board.dispose();
  }
});

it("rechecks labels before a native write and retries a failed unpin without touching replacement pins", async () => {
  const { board, host, inventory } = fixture();
  const w = workspace("w", "Task", ["task:in-progress"]);
  inventory.workspaces.push(w);
  const read = host.workspace;
  host.workspace = vi.fn(async (id) => {
    w.labels = [];
    return read(id);
  });
  await board.start();
  try {
    expect(host.setPinned).not.toHaveBeenCalled();
    host.workspace = read;
    w.labels = ["task:in-progress"];
    await board.refresh();
    w.labels = [];
    const write = host.setPinned;
    host.setPinned = vi.fn(async () => {
      throw new Error("temporarily unavailable");
    });
    await expect(board.refresh()).rejects.toThrow("temporarily unavailable");
    host.setPinned = write;
    await board.refresh();
    expect(w.pinnedAt).toBeNull();
  } finally {
    board.dispose();
  }
});

it("does not claim an uncertain native pin after a lost receipt and restart", async () => {
  const { board, host, inventory, backing, now } = fixture();
  const w = workspace("w", "Task", ["task:in-progress"]);
  inventory.workspaces.push(w);
  const write = host.setPinned;
  host.setPinned = vi.fn(async (id, pinned) => {
    await write(id, pinned);
    throw new Error("lost receipt");
  });
  let reopened: Workboard | undefined;
  try {
    await expect(board.start()).rejects.toThrow("lost receipt");
    const nativePin = w.pinnedAt;
    expect(nativePin).toBeTruthy();
    board.dispose();
    host.setPinned = write;
    w.labels = [];
    reopened = new Workboard(host, new Store(backing), now);
    await reopened.start();
    expect(w.pinnedAt).toBe(nativePin);
    expect(write).toHaveBeenCalledExactlyOnceWith("w", true);
  } finally {
    board.dispose();
    reopened?.dispose();
  }
});

it("skips a pin when a workspace changes while its fresh read is in flight", async () => {
  const { board, host, inventory } = fixture();
  const w = workspace("w", "Task", ["task:in-progress"]);
  inventory.workspaces.push(w);
  const read = host.workspace;
  host.workspace = vi.fn(async (id) => {
    const prior = await read(id);
    w.labels = [];
    board.changed(id);
    return prior;
  });
  try {
    await board.start();
    expect(host.setPinned).not.toHaveBeenCalled();
  } finally {
    board.dispose();
  }
});
