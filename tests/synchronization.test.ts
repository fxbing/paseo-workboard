import { afterEach, expect, it, vi } from "vitest";
import { BoardView, WATCH_TIMEOUT_MS } from "../server/board-view";
import { Workboard } from "../server/workboard";
import { settingsSchema } from "../shared/model";
import { fixture, workspace, agentEvidence } from "./fixtures";

afterEach(() => vi.useRealTimers());

it("waits for a full host read when Refresh joins an in-flight cache reconciliation", async () => {
  vi.useFakeTimers();
  const test = fixture();
  await test.board.start();
  try {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    test.host.currentInventory = async () => {
      await waiting;
      return structuredClone(test.inventory);
    };
    const fresh = vi.spyOn(test.host, "inventory");
    test.board.changed(undefined, false);
    await vi.advanceTimersByTimeAsync(300);
    const refreshing = test.board.refresh();
    release();
    await refreshing;
    expect(fresh).toHaveBeenCalledTimes(1);
  } finally {
    test.board.dispose();
  }
});

it("watches runtime changes without changing durable revision or rereading history", async () => {
  vi.useFakeTimers();
  const test = fixture();
  const native = workspace("task");
  test.inventory.workspaces.push(native);
  test.inventory.agents.push({
    id: "a",
    workspaceId: native.id,
    title: "Agent",
    activity: "running",
    updatedAt: "2026-09-22T00:00:00Z",
    lastUserMessageAt: null,
  });
  test.host.currentInventory = async () => structuredClone(test.inventory);
  const fresh = vi.spyOn(test.host, "inventory");
  const history = vi.spyOn(test.host, "conversation");
  await test.board.start();
  try {
    fresh.mockClear();
    history.mockClear();
    const before = test.board.snapshot();
    const waiting = test.board.watch({
      after: before.viewVersion,
      watcherId: "window",
    });
    native.githubRuntime = {
      error: { message: "Forge temporarily unavailable" },
    };
    test.board.changed(native.id, false);
    await vi.advanceTimersByTimeAsync(300);
    const result = await waiting;
    expect(result.status).toBe("changed");
    if (result.status !== "changed") throw new Error("Expected a new board");
    expect(result.board.revision).toBe(before.revision);
    expect(result.board.viewVersion.revision).toBeGreaterThan(
      before.viewVersion.revision,
    );
    expect(result.board.cards[0].changeRequestUnavailable).toBe(true);
    expect(fresh).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
  } finally {
    test.board.dispose();
  }
});

it("keeps idle heartbeats small and releases replaced or disposed watchers", async () => {
  vi.useFakeTimers();
  const test = fixture();
  await test.board.start();
  try {
    const current = test.board.snapshot();
    const first = test.board.watch({
      after: current.viewVersion,
      watcherId: "window",
    });
    const second = test.board.watch({
      after: current.viewVersion,
      watcherId: "window",
    });
    await expect(first).resolves.toEqual({
      status: "unchanged",
      viewVersion: current.viewVersion,
    });
    await vi.advanceTimersByTimeAsync(WATCH_TIMEOUT_MS);
    await expect(second).resolves.toEqual({
      status: "unchanged",
      viewVersion: current.viewVersion,
    });
    const disposed = test.board.watch({
      after: current.viewVersion,
      watcherId: "window",
    });
    test.board.dispose();
    await expect(disposed).resolves.toEqual({
      status: "unchanged",
      viewVersion: current.viewVersion,
    });
    await expect(
      test.board.watch({ after: current.viewVersion, watcherId: "window" }),
    ).rejects.toThrow("stopped");
  } finally {
    test.board.dispose();
  }
});

it("lets a mutation finish while watch waits and distinguishes restarted instances", async () => {
  const test = fixture();
  await test.board.start();
  try {
    const before = test.board.snapshot();
    const waiting = test.board.watch({
      after: before.viewVersion,
      watcherId: "window",
    });
    const changed = await test.board.mutate({
      action: "create",
      title: "Draft",
      description: "",
      projectId: null,
    });
    await expect(waiting).resolves.toMatchObject({
      status: "changed",
      board: { viewVersion: changed.viewVersion },
    });
    const restarted = new BoardView();
    restarted.publish(changed);
    expect(restarted.snapshot().viewVersion.instanceId).not.toBe(
      changed.viewVersion.instanceId,
    );
    await expect(
      restarted.watch({ after: changed.viewVersion, watcherId: "window" }),
    ).resolves.toMatchObject({ status: "changed" });
    restarted.dispose();
  } finally {
    test.board.dispose();
  }
});

it("does not publish no-op calibrations or allow callers to mutate the cached board", async () => {
  vi.useFakeTimers();
  const test = fixture();
  await test.board.start();
  try {
    const before = test.board.snapshot();
    const waiting = test.board.watch({
      after: before.viewVersion,
      watcherId: "window",
    });
    await test.board.refresh();
    expect(test.board.snapshot().viewVersion).toEqual(before.viewVersion);
    before.settings.pinInProgressWorkspaces =
      !before.settings.pinInProgressWorkspaces;
    expect(test.board.snapshot().settings).not.toEqual(before.settings);
    await vi.advanceTimersByTimeAsync(WATCH_TIMEOUT_MS);
    await expect(waiting).resolves.toMatchObject({ status: "unchanged" });
  } finally {
    test.board.dispose();
  }
});

it("runs local minute checks without full reads and calibrates after five minutes", async () => {
  vi.useFakeTimers();
  const test = fixture();
  test.host.currentInventory = async () => structuredClone(test.inventory);
  const fresh = vi.spyOn(test.host, "inventory");
  const writes = vi.spyOn(test.backing, "write");
  await test.board.start();
  try {
    fresh.mockClear();
    writes.mockClear();
    const before = test.board.snapshot().viewVersion;
    await vi.advanceTimersByTimeAsync(240_000);
    expect(fresh).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(test.board.snapshot().viewVersion).toEqual(before);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fresh).toHaveBeenCalledOnce();
    expect(writes).not.toHaveBeenCalled();
    expect(test.board.snapshot().viewVersion).toEqual(before);
  } finally {
    test.board.dispose();
  }
});

it("checks newly due archives on the local tick using fresh preflight reads", async () => {
  vi.useFakeTimers();
  const test = fixture({
    settings: settingsSchema.parse({ archiveDoneEnabled: true }),
  });
  test.inventory.workspaces.push(workspace("old", "Old task", ["task:done"]));
  test.inventory.agents.push({
    id: "a",
    workspaceId: "old",
    title: null,
    activity: "idle",
    updatedAt: "2026-08-01T00:00:00Z",
    lastUserMessageAt: "2026-08-01T00:00:00Z",
  });
  test.host.conversation = agentEvidence("2026-08-01T00:00:00Z");
  test.host.currentInventory = async () => structuredClone(test.inventory);
  let now = Date.parse("2026-08-02T00:00:00Z");
  const board = new Workboard(test.host, test.store, () => now);
  const fresh = vi.spyOn(test.host, "inventory");
  await board.start();
  try {
    expect(test.host.archive).not.toHaveBeenCalled();
    fresh.mockClear();
    now = test.now();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(test.host.archive).toHaveBeenCalledOnce();
    expect(fresh.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(board.snapshot().cards[0].archived?.status).toBe("archived");
  } finally {
    board.dispose();
  }
});

it("publishes a binding intent while native workspace creation is still pending", async () => {
  const test = fixture();
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const originalCreate = test.host.create;
  test.host.create = async (...args) => {
    entered();
    await waiting;
    return originalCreate(...args);
  };
  await test.board.start();
  try {
    const before = await test.board.mutate({
      action: "create",
      title: "Draft",
      description: "",
      projectId: null,
    });
    const watching = test.board.watch({
      after: before.viewVersion,
      watcherId: "window",
    });
    const binding = test.board.mutate({
      action: "start",
      taskId: before.cards[0].id,
      target: { kind: "new", source: { kind: "directory", path: "/fixture" } },
    });
    await started;
    const intent = test.store.current.tasks[0].binding;
    expect(intent).not.toBeNull();
    expect(test.board.snapshot().cards[0].binding).toEqual(intent);
    await expect(watching).resolves.toMatchObject({
      status: "changed",
      board: { cards: [{ binding: intent }] },
    });
    release();
    const completed = await binding;
    expect(completed.cards[0].binding).toBeNull();
    expect(completed.cards[0].workspaceId).not.toBeNull();
  } finally {
    release();
    test.board.dispose();
  }
});

it("publishes the persisted archive intent while native archive is still pending", async () => {
  const test = fixture();
  test.inventory.workspaces.push(workspace("old", "Old task", ["task:done"]));
  test.inventory.agents.push({
    id: "a",
    workspaceId: "old",
    title: null,
    activity: "idle",
    updatedAt: "2026-08-01T00:00:00Z",
    lastUserMessageAt: "2026-08-01T00:00:00Z",
  });
  test.host.conversation = agentEvidence("2026-08-01T00:00:00Z");
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const originalArchive = test.host.archive;
  test.host.archive = async (id) => {
    entered();
    await waiting;
    return originalArchive(id);
  };
  await test.board.start();
  try {
    await test.store.update((data) => {
      data.settings.archiveDoneEnabled = true;
    });
    const before = test.board.snapshot();
    const watching = test.board.watch({
      after: before.viewVersion,
      watcherId: "window",
    });
    const archiving = test.board.refresh();
    await started;
    expect(test.store.current.tasks[0].archived?.status).toBe("pending");
    expect(test.board.snapshot().cards[0].archived?.status).toBe("pending");
    await expect(watching).resolves.toMatchObject({
      status: "changed",
      board: { cards: [{ archived: { status: "pending" } }] },
    });
    release();
    await archiving;
    expect(test.board.snapshot().cards[0].archived?.status).toBe("archived");
  } finally {
    release();
    test.board.dispose();
  }
});

it("coalesces notifications from multiple saves in one operation without rereading conversations", async () => {
  const test = fixture();
  for (let i = 0; i < 3; i++) {
    test.inventory.workspaces.push(
      workspace(`w${i}`, `Task ${i}`, ["task:in-progress"]),
    );
    test.inventory.agents.push({
      id: `a${i}`,
      workspaceId: `w${i}`,
      title: "Agent",
      activity: "running",
      updatedAt: "2026-09-22T00:00:00Z",
      lastUserMessageAt: null,
    });
  }
  const notifications: Promise<void>[] = [];
  const originalWrite = test.backing.write;
  const writes = vi
    .spyOn(test.backing, "write")
    .mockImplementation(async (...args) => {
      const result = await originalWrite(...args);
      if (result.revision)
        notifications.push(test.board.settingsChanged(result.revision));
      return result;
    });
  const reads = vi.spyOn(test.backing, "read");
  const history = vi.spyOn(test.host, "conversation");
  try {
    await test.board.start();
    await Promise.all(notifications);
    expect(writes.mock.calls.length).toBeGreaterThan(1);
    expect(test.host.setPinned).toHaveBeenCalledTimes(3);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(history).toHaveBeenCalledTimes(3);
    expect(test.board.snapshot().cards).toHaveLength(3);
  } finally {
    test.board.dispose();
  }
});

it("releases a queued settings notification when the board stops", async () => {
  const test = fixture();
  const queued = test.board.settingsChanged("external");
  test.board.dispose();
  await expect(queued).rejects.toThrow("Workboard stopped");
});

it("reloads external settings changes without turning its own writes into refresh loops", async () => {
  const test = fixture();
  await test.board.start();
  try {
    const fresh = vi.spyOn(test.host, "inventory");
    test.host.currentInventory = async () => structuredClone(test.inventory);
    const current = await test.backing.read();
    await test.board.settingsChanged(current.revision);
    expect(fresh).not.toHaveBeenCalled();
    const settings = {
      ...current.values.settings,
      pinInProgressWorkspaces: false,
    };
    const saved = await test.backing.write(current.revision, {
      ...current.values,
      settings,
      revision: current.values.revision + 1,
    });
    if (!saved.revision) throw new Error("Expected saved settings");
    await test.board.settingsChanged(saved.revision);
    expect(test.board.snapshot().settings.pinInProgressWorkspaces).toBe(false);
  } finally {
    test.board.dispose();
  }
});
