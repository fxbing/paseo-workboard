import { afterEach, expect, it, vi } from "vitest";
import { childrenSkippedForIdle, mappingPreview } from "../client/board-utils";
import { newTask } from "../shared/model";
import { Workboard } from "../server/workboard";
import { agent, idleBoard, type FakeChild } from "./idle-host";

afterEach(() => vi.useRealTimers());

const OLD = "2026-08-01T00:00:00.000Z";
const none = { timelines: [], lists: [], childTimelines: [] };
const child = (
  updatedAt: string,
  status: FakeChild["status"] = "completed",
) => ({
  id: "child",
  title: "Worker",
  status,
  updatedAt,
});
const recordedTask = (lastObservedAt: string) => ({
  ...newTask("task", "Old task", "2026-08-01T00:00:00Z", "done"),
  workspaceId: "old",
  lastStage: "done" as const,
  conversationAgents: [
    { id: "parent/provider/child", lastObservedAt, seenWhileLive: true },
  ],
});

// Author requirement 1: a refresh does not wake an idle Agent.
it("sends no per-agent request for an idle agent during refresh", async () => {
  const test = idleBoard({
    agents: [agent("parent", "2026-09-22T00:00:00.000Z")],
    children: { parent: [child("2026-09-21T00:00:00.000Z")] },
    labels: ["task:in-progress"],
  });
  try {
    await test.board.start();
    await test.board.refresh();
    expect(test.calls()).toEqual(none);
    const card = test.board.snapshot().cards[0];
    expect(card.conversationGateEvidence).toBe("unknown");
    expect(card.conversationReason).toBe("child-enumeration-unavailable");
    expect(card.conversationDisplayEvidence).toBe("lower-bound");
  } finally {
    test.board.dispose();
  }
});

it("does not retry an idle parent's listing every minute, but still reads an active one", async () => {
  const test = idleBoard({
    agents: [
      agent("parent", "2026-09-22T00:00:00.000Z", { status: "running" }),
    ],
    history: { parent: ["2026-09-22T00:00:00.000Z"] },
    labels: ["task:in-progress"],
  });
  test.subagents.mockRejectedValue(new Error("provider unavailable"));
  vi.useFakeTimers();
  vi.setSystemTime(new Date(test.now()));
  // The host reads the real clock for its 60-second retry, so both clocks move together.
  const tick = (ms: number) => {
    test.advance(ms);
    vi.setSystemTime(new Date(Date.now() + ms));
  };
  try {
    await test.board.start();
    expect(test.calls().lists).toEqual(["parent"]);
    tick(60_000);
    await test.board.refresh();
    expect(test.calls().lists).toEqual(["parent", "parent"]);
    // The parent rests: the failed listing is not retried, because retrying would load it.
    test.agents[0].status = "idle";
    test.agents[0].updatedAt = "2026-09-22T01:00:00.000Z";
    test.clearCalls();
    for (let minute = 0; minute < 5; minute++) {
      tick(60_000);
      await test.board.refresh();
    }
    expect(test.calls()).toEqual(none);
    // It wakes again: it is listed and read as before.
    test.agents[0].status = "running";
    test.agents[0].updatedAt = "2026-09-22T02:00:00.000Z";
    await test.board.refresh();
    expect(test.calls().lists).toEqual(["parent"]);
    expect(test.calls().timelines).toEqual(["parent"]);
  } finally {
    test.board.dispose();
  }
});

// Author requirement 2: the recorded time schedules a recheck and never authorizes archive.
it("does not archive from an idle parent's updatedAt when a never-seen child is newer", async () => {
  const test = idleBoard({
    agents: [agent("parent", OLD)],
    children: { parent: [child("2026-09-01T00:00:00.000Z")] },
    history: { parent: [OLD], "parent/child": ["2026-09-01T00:00:00.000Z"] },
  });
  try {
    await test.board.start();
    expect(test.archive).not.toHaveBeenCalled();
    expect(test.calls()).toEqual({
      timelines: ["parent"],
      lists: ["parent"],
      childTimelines: ["parent/child"],
    });
  } finally {
    test.board.dispose();
  }
});

it("archives an idle workspace after the recheck lists its children fresh and reads them", async () => {
  const test = idleBoard({
    agents: [agent("parent", OLD)],
    children: { parent: [child(OLD)] },
    history: { parent: [OLD], "parent/child": [OLD] },
  });
  try {
    await test.board.start();
    expect(test.archive).toHaveBeenCalledExactlyOnceWith("old");
    expect(test.calls().lists).toEqual(["parent"]);
    expect(test.calls().childTimelines).toEqual(["parent/child"]);
  } finally {
    test.board.dispose();
  }
});

it("never archives from the recorded time alone when the listing fails, and backs off", async () => {
  const test = idleBoard({
    agents: [agent("parent", OLD)],
    history: { parent: [OLD] },
  });
  test.subagents.mockRejectedValue(new Error("provider unavailable"));
  try {
    await test.board.start();
    expect(test.archive).not.toHaveBeenCalled();
    expect(test.board.snapshot().cards[0].issue).toBe("conversation-unknown");
    test.clearCalls();
    test.advance(30_000);
    await test.board.refresh();
    expect(test.calls()).toEqual(none);
    test.advance(31_000);
    await test.board.refresh();
    expect(test.calls().lists).toEqual(["parent"]);
    expect(test.archive).not.toHaveBeenCalled();
    // The listing recovers: the next attempt, after a longer wait, archives.
    test.subagents.mockResolvedValue([]);
    test.advance(121_000);
    await test.board.refresh();
    expect(test.archive).toHaveBeenCalledExactlyOnceWith("old");
  } finally {
    test.board.dispose();
  }
});

it("defers when a listed child's history cannot be read", async () => {
  const test = idleBoard({
    agents: [agent("parent", OLD)],
    children: { parent: [child(OLD)] },
    history: { parent: [OLD] },
  });
  test.subagentTimeline.mockImplementation(() => async () => {
    throw new Error("provider unavailable");
  });
  try {
    await test.board.start();
    expect(test.archive).not.toHaveBeenCalled();
  } finally {
    test.board.dispose();
  }
});

it("judges a child's busy state from the fresh listing, not from a stale cache", async () => {
  const test = idleBoard({
    agents: [
      agent("parent", "2026-08-01T00:00:00.000Z", { status: "running" }),
    ],
    children: { parent: [child(OLD, "running")] },
    history: { parent: [OLD], "parent/child": [OLD] },
  });
  try {
    await test.board.start();
    // Cached as running while the parent was live; the parent then rests and the child ends.
    test.agents[0].status = "idle";
    test.children.parent = [child(OLD, "completed")];
    test.advance(60_000);
    await test.board.refresh();
    expect(test.archive).toHaveBeenCalledExactlyOnceWith("old");
  } finally {
    test.board.dispose();
  }
});

it("defers while the fresh listing shows a running child", async () => {
  const test = idleBoard({
    agents: [agent("parent", OLD)],
    children: { parent: [child(OLD, "running")] },
    history: { parent: [OLD], "parent/child": [OLD] },
  });
  try {
    await test.board.start();
    expect(test.archive).not.toHaveBeenCalled();
    expect(test.board.snapshot().cards[0].issue).toBe("agent-busy");
  } finally {
    test.board.dispose();
  }
});

// Author requirement 3 and 4: newer evidence postpones the next check, across refreshes and restarts.
it("keeps newer child evidence from repeating the same reads on every refresh", async () => {
  const test = idleBoard({
    agents: [agent("parent", OLD)],
    children: { parent: [child("2026-09-20T00:00:00.000Z")] },
    history: {
      parent: [OLD],
      "parent/child": ["2026-09-20T00:00:00.000Z"],
    },
  });
  try {
    await test.board.start();
    expect(test.archive).not.toHaveBeenCalled();
    expect(test.calls().childTimelines).toEqual(["parent/child"]);
    expect(test.store.current.tasks[0].conversationAgents).toEqual([
      expect.objectContaining({
        id: "parent/provider/child",
        lastObservedAt: "2026-09-20T00:00:00.000Z",
      }),
    ]);
    test.clearCalls();
    for (let minute = 0; minute < 5; minute++) {
      test.advance(60_000);
      await test.board.refresh();
    }
    expect(test.calls()).toEqual(none);
    expect(test.archive).not.toHaveBeenCalled();
  } finally {
    test.board.dispose();
  }
});

it("does not read again after a restart when the recorded child evidence is recent", async () => {
  const test = idleBoard({
    agents: [agent("parent", OLD)],
    data: { tasks: [recordedTask("2026-09-20T00:00:00.000Z")] },
  });
  try {
    await test.board.start();
    expect(test.calls()).toEqual(none);
    test.restart();
    await test.board.start();
    expect(test.calls()).toEqual(none);
    expect(test.archive).not.toHaveBeenCalled();
  } finally {
    test.board.dispose();
  }
});

it("still rechecks and archives after a restart when a recorded child exists and the parent stays idle", async () => {
  const test = idleBoard({
    agents: [agent("parent", OLD)],
    children: { parent: [child(OLD)] },
    history: { parent: [OLD], "parent/child": [OLD] },
    data: { tasks: [recordedTask(OLD)] },
  });
  try {
    // The restarted host has no child inventory; the recorded child is not a vanished one.
    await test.board.start();
    expect(test.archive).toHaveBeenCalledExactlyOnceWith("old");
    expect(test.calls().lists).toEqual(["parent"]);
    expect(test.calls().childTimelines).toEqual(["parent/child"]);
  } finally {
    test.board.dispose();
  }
});

it("retries a failed recheck once after a restart and then backs off again", async () => {
  const test = idleBoard({
    agents: [agent("parent", OLD)],
    history: { parent: [OLD] },
  });
  test.subagents.mockRejectedValue(new Error("provider unavailable"));
  try {
    await test.board.start();
    expect(test.calls().lists).toEqual(["parent"]);
    test.clearCalls();
    test.restart();
    await test.board.start();
    expect(test.calls().lists).toEqual(["parent"]);
    test.clearCalls();
    test.advance(30_000);
    await test.board.refresh();
    expect(test.calls()).toEqual(none);
    expect(test.archive).not.toHaveBeenCalled();
  } finally {
    test.board.dispose();
  }
});

it("treats a child that disappears from an active parent's complete listing as vanished", async () => {
  const test = idleBoard({
    agents: [agent("parent", OLD, { status: "running" })],
    children: { parent: [] },
    history: { parent: [OLD] },
    data: { tasks: [recordedTask(OLD)] },
  });
  try {
    await test.board.start();
    expect(test.board.snapshot().cards[0].conversationGateEvidence).toBe(
      "unknown",
    );
    expect(test.archive).not.toHaveBeenCalled();
  } finally {
    test.board.dispose();
  }
});

it("keeps archived parents out of the idle recheck", async () => {
  const test = idleBoard({
    agents: [agent("parent", OLD, { archivedAt: "2026-09-01T00:00:00.000Z" })],
    history: { parent: [OLD] },
  });
  try {
    await test.board.start();
    expect(test.calls().lists).toEqual([]);
    expect(test.archive).not.toHaveBeenCalled();
  } finally {
    test.board.dispose();
  }
});

const setDone = (test: ReturnType<typeof idleBoard>, enabled: boolean) => {
  const before = test.board.snapshot();
  return test.board.mutate({
    action: "settings",
    revision: before.revision,
    expectedSettings: before.settings,
    settings: { ...before.settings, archiveDoneEnabled: enabled },
  });
};

// Author review: the settings confirmation counts idle workspaces the server may recheck.
it("lists an old idle workspace in the confirmation before the rule is enabled, and the scan then archives it", async () => {
  const test = idleBoard({
    agents: [agent("parent", OLD)],
    history: { parent: [OLD] },
    archive: false,
  });
  try {
    await test.board.start();
    expect(test.calls()).toEqual(none);
    const board = test.board.snapshot();
    expect(board.cards[0].conversationGateEvidence).toBe("unknown");
    const preview = mappingPreview(
      board.cards,
      { ...board.settings, archiveDoneEnabled: true },
      test.now(),
    );
    expect(preview.dueDone).toBe(1);
    expect(preview.candidates[0].card.workspaceId).toBe("old");
    expect(test.archive).not.toHaveBeenCalled();
    await setDone(test, true);
    await test.board.refresh();
    expect(test.archive).toHaveBeenCalledExactlyOnceWith("old");
  } finally {
    test.board.dispose();
  }
});

it("does not list a recent idle workspace in the confirmation", async () => {
  const test = idleBoard({
    agents: [agent("parent", "2026-09-22T00:00:00.000Z")],
    archive: false,
  });
  try {
    await test.board.start();
    const board = test.board.snapshot();
    const preview = mappingPreview(
      board.cards,
      { ...board.settings, archiveDoneEnabled: true },
      test.now(),
    );
    expect(preview.due).toBe(0);
  } finally {
    test.board.dispose();
  }
});

// Author review: the skipped explanation comes from the evidence, not from every agent being idle.
it("explains skipped children only when skipping is the sole reason they are unavailable", async () => {
  const idleOnly = idleBoard({
    agents: [agent("parent", OLD)],
    labels: ["task:in-progress"],
  });
  const mixed = idleBoard({
    agents: [agent("other", OLD)],
    labels: ["task:in-progress"],
    // A child of a parent that no longer exists: nothing can bound its history.
    data: {
      tasks: [
        {
          ...recordedTask(OLD),
          lastStage: "in-progress" as const,
          conversationAgents: [
            {
              id: "gone/provider/child",
              lastObservedAt: OLD,
              seenWhileLive: true,
            },
          ],
        },
      ],
    },
  });
  try {
    await idleOnly.board.start();
    await mixed.board.start();
    const only = idleOnly.board.snapshot().cards[0];
    expect(only.recheckAt).not.toBeNull();
    expect(childrenSkippedForIdle(only)).toBe(true);
    const other = mixed.board.snapshot().cards[0];
    expect(other.conversationReason).toBe("child-enumeration-unavailable");
    expect(other.recheckAt).toBeNull();
    expect(childrenSkippedForIdle(other)).toBe(false);
  } finally {
    idleOnly.board.dispose();
    mixed.board.dispose();
  }
});

// Author review: a deferral on an idle candidate is cleared once the candidate is no longer due.
it("clears an idle candidate's warning when a longer period makes it not due", async () => {
  const test = idleBoard({
    agents: [agent("parent", OLD)],
    history: { parent: [OLD] },
  });
  test.host.safety = async () => "git-dirty";
  try {
    await test.board.start();
    expect(test.archive).not.toHaveBeenCalled();
    expect(test.board.snapshot().cards[0].issue).toBe("git-dirty");
    const before = test.board.snapshot();
    const saved = await test.board.mutate({
      action: "settings",
      revision: before.revision,
      expectedSettings: before.settings,
      settings: { ...before.settings, archiveDoneAfterDays: 100 },
    });
    expect(saved.cards[0].issue).toBe(null);
    test.advance(10 * 60_000);
    await test.board.refresh();
    expect(test.board.snapshot().cards[0].issue).toBe(null);
    expect(test.archive).not.toHaveBeenCalled();
  } finally {
    test.board.dispose();
  }
});

it("keeps an idle candidate's warning while its schedule is still due", async () => {
  const test = idleBoard({
    agents: [agent("parent", OLD)],
    history: { parent: [OLD] },
  });
  test.host.safety = async () => "git-dirty";
  try {
    await test.board.start();
    const before = test.board.snapshot();
    const saved = await test.board.mutate({
      action: "settings",
      revision: before.revision,
      expectedSettings: before.settings,
      settings: { ...before.settings, archiveDoneAfterDays: 40 },
    });
    expect(saved.cards[0].issue).toBe("git-dirty");
  } finally {
    test.board.dispose();
  }
});

it("reports the server clock's offset in the snapshot", async () => {
  const test = idleBoard({ agents: [agent("parent", OLD)] });
  const shifted = new Workboard(test.host, test.store, test.now, 60_000, 7_000);
  try {
    expect(shifted.snapshot().clockOffsetMs).toBe(7_000);
    expect(test.board.snapshot().clockOffsetMs).toBe(0);
  } finally {
    shifted.dispose();
    test.board.dispose();
  }
});
