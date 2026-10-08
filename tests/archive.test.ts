import { afterEach, expect, it, vi } from "vitest";
import { settingsSchema } from "../shared/model";
import { Workboard } from "../server/workboard";
import { Store } from "../server/store";
import { migrateData } from "../shared/migrations";
import { agentEvidence, fixture, observed, workspace } from "./fixtures";
import { newTask } from "../shared/model";
afterEach(() => vi.useRealTimers());
function dueFixture() {
  const test = fixture({
    settings: settingsSchema.parse({ autoArchive: true }),
  });
  test.inventory.workspaces.push(workspace("old", undefined, ["task:done"]));
  test.inventory.agents.push({
    id: "a",
    workspaceId: "old",
    title: null,
    updatedAt: "2026-08-01T00:00:00Z",
    lastUserMessageAt: "2026-08-01T00:00:00Z",
    activity: "idle",
  });
  test.host.conversation = agentEvidence("2026-08-01T00:00:00Z");
  return test;
}
it("archives on cold start without any UI and keeps the original conversation clock", async () => {
  const { board, host } = dueFixture();
  try {
    await board.start();
    expect(host.archive).toHaveBeenCalledExactlyOnceWith("old");
    expect(board.snapshot().cards[0].archived).toMatchObject({
      status: "archived",
      kind: "automatic",
      lastConversationAt: "2026-08-01T00:00:00.000Z",
    });
    await board.refresh();
    expect(host.archive).toHaveBeenCalledTimes(1);
  } finally {
    board.dispose();
  }
});
it("periodic work strictly crosses 30 days, includes archived Agents, and stops after dispose", async () => {
  vi.useFakeTimers();
  const test = dueFixture();
  let clock = Date.parse("2026-08-31T00:00:00Z");
  test.inventory.agents[0].archivedAt = "2026-08-02T00:00:00Z";
  const board = new Workboard(test.host, test.store, () => clock, 1000);
  try {
    await board.start();
    expect(test.host.archive).not.toHaveBeenCalled();
    clock += 1;
    await vi.advanceTimersByTimeAsync(1000);
    expect(test.host.archive).toHaveBeenCalledExactlyOnceWith("old");
    board.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(test.host.archive).toHaveBeenCalledTimes(1);
  } finally {
    board.dispose();
  }
});
it("defers no conversation, recent replies, busy agents, unsafe Git and label conflicts", async () => {
  for (const reason of ["none", "recent", "busy", "git", "conflict"]) {
    const { board, host, inventory } = dueFixture();
    if (reason === "none") host.conversation = agentEvidence(null);
    if (reason === "recent")
      host.conversation = agentEvidence("2026-09-22T00:00:00Z");
    if (reason === "busy") inventory.agents[0].activity = "waiting";
    if (reason === "git") host.safety = async () => "git-dirty";
    if (reason === "conflict")
      inventory.workspaces[0].labels.push("task:review");
    try {
      await board.start();
      expect(host.archive, reason).not.toHaveBeenCalled();
      expect(board.snapshot().cards[0].archived, reason).toBeNull();
    } finally {
      board.dispose();
    }
  }
});
it("archives an unreadable history from its recorded upper bound and keeps the reason", async () => {
  const { board, host } = dueFixture();
  host.conversation = async () => {
    throw new Error("History missing");
  };
  try {
    await board.start();
    // Paseo's recorded activity is never earlier than the last message, so gating on it can
    // only delay an archive; the degraded evidence stays visible on the card.
    expect(host.archive).toHaveBeenCalledExactlyOnceWith("old");
    expect(board.snapshot().cards[0]).toMatchObject({
      conversationDisplayEvidence: "upper-bound",
      conversationGateEvidence: "upper-bound",
      conversationReason: "timeline-unreadable",
    });
  } finally {
    board.dispose();
  }
});
it("invalidates a scan when labels or a new conversation change while safety checks wait", async () => {
  for (const change of ["labels", "conversation"]) {
    const { board, host, inventory } = dueFixture();
    host.safety = vi.fn(async () => {
      if (change === "labels") inventory.workspaces[0].labels = ["task:todo"];
      else host.conversation = agentEvidence("2026-09-23T00:00:00Z");
      board.changed();
      return null;
    });
    try {
      await board.start();
      expect(host.safety).toHaveBeenCalled();
      expect(host.archive).not.toHaveBeenCalled();
      expect(board.snapshot().cards[0].archived).toBeNull();
    } finally {
      board.dispose();
    }
  }
});
it("does not let activity in a different workspace indefinitely block an old task", async () => {
  const { board, host } = dueFixture();
  host.safety = async () => {
    board.changed("some-other-workspace");
    return null;
  };
  try {
    await board.start();
    expect(host.archive).toHaveBeenCalledExactlyOnceWith("old");
  } finally {
    board.dispose();
  }
});

it("defers unrelated archive candidates during scoped events but checks them on the next full refresh", async () => {
  vi.useFakeTimers();
  const { board, host, inventory } = dueFixture();
  inventory.workspaces[0].labels = ["task:todo"];
  inventory.workspaces.push(workspace("active"));
  await board.start();
  try {
    inventory.workspaces[0].labels = ["task:done"];
    board.changed("active");
    await vi.advanceTimersByTimeAsync(300);
    expect(host.archive).not.toHaveBeenCalled();
    await board.refresh();
    expect(host.archive).toHaveBeenCalledExactlyOnceWith("old");
  } finally {
    board.dispose();
  }
});

it.each(["disconnect", "stage change"])(
  "does not archive when a %s arrives while reconciliation is waiting",
  async (change) => {
    const { board, host, inventory } = dueFixture();
    inventory.workspaces[0].labels = ["task:todo"];
    await board.start();
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    host.conversation = async () => {
      entered();
      await blocked;
      return observed("2026-08-01T00:00:00Z");
    };
    inventory.workspaces[0].labels = ["task:done"];
    try {
      const refresh = board.refresh().catch(() => undefined);
      await reading;
      const mutation =
        change === "stage change"
          ? board.mutate({
              action: "stage",
              taskId: board.snapshot().cards[0].id,
              stage: "todo",
              expectedLabels: ["task:done"],
            })
          : null;
      if (change === "disconnect")
        board.disconnected("Fixture connection lost");
      release();
      await refresh;
      if (mutation) expect((await mutation).cards[0].stage).toBe("todo");
      else
        expect(board.snapshot()).toMatchObject({
          connected: false,
          error: "Fixture connection lost",
        });
      expect(host.archive).not.toHaveBeenCalled();
    } finally {
      release();
      board.dispose();
    }
  },
);
it("uses the latest of multiple agents, including a provider child, without borrowing another workspace's time", async () => {
  const test = dueFixture();
  test.inventory.agents.push({
    id: "a/provider/child",
    parentAgentId: "a",
    subagentId: "child",
    workspaceId: "old",
    title: "Child",
    updatedAt: "2026-09-22T00:00:00Z",
    lastUserMessageAt: null,
    activity: "idle",
  });
  test.inventory.workspaces.push(workspace("other"));
  test.inventory.agents.push({
    id: "unrelated",
    workspaceId: "other",
    title: null,
    updatedAt: "2026-09-23T00:00:00Z",
    lastUserMessageAt: null,
    activity: "idle",
  });
  test.host.conversation = async (agent) =>
    observed(
      agent.id.includes("child")
        ? "2026-09-22T00:00:00Z"
        : agent.id === "unrelated"
          ? "2026-09-23T00:00:00Z"
          : "2026-08-01T00:00:00Z",
    );
  try {
    await test.board.start();
    expect(test.host.archive).not.toHaveBeenCalled();
    expect(
      test.board.snapshot().cards.find((c) => c.workspaceId === "old")
        ?.lastConversationAt,
    ).toBe("2026-09-22T00:00:00.000Z");
  } finally {
    test.board.dispose();
  }
});
it("keeps native timeout/partial failure uncertain across restart and never sends a second archive", async () => {
  for (const failure of ["timeout", "partial"]) {
    const { board, host, backing, now } = dueFixture();
    host.archive = vi.fn(async () => {
      if (failure === "timeout") throw new Error("Timeout");
      return { archivedAt: null, error: "Worktree cleanup failed" };
    });
    try {
      await board.start();
      expect(board.snapshot().cards[0].archived?.status).toBe("uncertain");
      board.dispose();
      const resumed = new Workboard(host, new Store(backing), now);
      await resumed.start();
      await resumed.refresh();
      expect(host.archive).toHaveBeenCalledTimes(1);
      expect(resumed.snapshot().cards[0].archived?.status).toBe("uncertain");
      resumed.dispose();
    } finally {
      board.dispose();
    }
  }
});

/**
 * A child that vanished before its time was recorded leaves the timeline unreadable, so the
 * gate may never go back before an observation that was actually recorded.
 */
function vanishedChildFixture(lastObservedAt: string | null) {
  const test = fixture({
    settings: settingsSchema.parse({ autoArchive: true }),
    tasks: [
      {
        ...newTask("task", "Old task", "2026-08-01T00:00:00Z", "done"),
        workspaceId: "old",
        lastStage: "done",
        conversationAgents: [
          {
            id: "a/provider/child",
            lastObservedAt,
            seenWhileLive: true,
          },
        ],
      },
    ],
  });
  test.inventory.workspaces.push(workspace("old", undefined, ["task:done"]));
  test.inventory.agents.push({
    id: "a",
    workspaceId: "old",
    title: null,
    updatedAt: "2026-08-01T00:00:00Z",
    lastUserMessageAt: "2026-08-01T00:00:00Z",
    activity: "idle",
  });
  test.host.conversation = agentEvidence("2026-08-01T00:00:00Z");
  return test;
}

it("folds a vanished child's recorded time into the archive gate", async () => {
  const test = vanishedChildFixture("2026-09-10T00:00:00Z");
  try {
    await test.board.start();
    const card = test.board
      .snapshot()
      .cards.find((c) => c.workspaceId === "old")!;
    // Gating on the parent alone would be 2026-08-01 and archive this workspace.
    expect(card.conversationGateAt).toBe("2026-09-10T00:00:00.000Z");
    expect(card.conversationGateEvidence).toBe("upper-bound");
    expect(card.conversationDisplayEvidence).toBe("lower-bound");
    expect(test.host.archive).not.toHaveBeenCalled();
  } finally {
    test.board.dispose();
  }
});

it("refuses the gate when a vanished child has no recorded time", async () => {
  const test = vanishedChildFixture(null);
  try {
    await test.board.start();
    const card = test.board
      .snapshot()
      .cards.find((c) => c.workspaceId === "old")!;
    expect(card.conversationGateAt).toBeNull();
    expect(card.conversationGateEvidence).toBe("unknown");
    expect(card.conversationReason).toBe("child-enumeration-unavailable");
    expect(card.conversationStatus).toBe("known");
    expect(test.host.archive).not.toHaveBeenCalled();
  } finally {
    test.board.dispose();
  }
});

it("does not leave a v5-migrated task permanently blocked by a never-observed legacy agent id", async () => {
  const migrated = migrateData(
    {
      schemaVersion: 5,
      revision: 1,
      serverId: "fixture-host",
      settings: settingsSchema.parse({ autoArchive: true }),
      tasks: [
        {
          ...newTask("task", "Old task", "2026-08-01T00:00:00Z", "done"),
          workspaceId: "old",
          lastStage: "done",
          lastConversationAt: "2026-08-01T00:00:00Z",
          conversationStatus: "known",
          conversationAgents: ["a", "a/provider/child"],
        },
      ],
    },
    5,
  );
  expect(migrated.tasks[0].conversationAgents).toEqual([]);
  const { board, inventory, host } = fixture(migrated);
  inventory.workspaces.push(workspace("old", undefined, ["task:done"]));
  inventory.agents.push({
    id: "a",
    workspaceId: "old",
    title: null,
    updatedAt: "2026-08-01T00:00:00Z",
    lastUserMessageAt: "2026-08-01T00:00:00Z",
    activity: "idle",
  });
  host.conversation = agentEvidence("2026-08-01T00:00:00Z");
  try {
    await board.start();
    const card = board.snapshot().cards.find((c) => c.workspaceId === "old")!;
    expect(card.conversationGateEvidence).toBe("exact");
    expect(host.archive).toHaveBeenCalledExactlyOnceWith("old");
  } finally {
    board.dispose();
  }
});

it("shares scan inventory and exponentially defers unchanged unsafe candidates up to one hour", async () => {
  const test = dueFixture();
  test.inventory.workspaces.push(workspace("second", undefined, ["task:done"]));
  test.inventory.agents.push({
    ...test.inventory.agents[0],
    id: "b",
    workspaceId: "second",
  });
  let clock = test.now();
  const board = new Workboard(test.host, test.store, () => clock);
  test.host.inventory = vi.fn(test.host.inventory);
  test.host.conversation = vi.fn(test.host.conversation);
  test.host.safety = vi.fn(async () => "git-dirty");
  try {
    await board.start();
    expect(test.host.inventory).toHaveBeenCalledTimes(2); // Reconcile and one scan inventory for both candidates.
    expect(test.host.conversation).toHaveBeenCalledTimes(4);
    expect(test.host.safety).toHaveBeenCalledTimes(2);
    for (const delay of [60, 120, 240, 480, 960, 1920, 3600, 3600]) {
      vi.mocked(test.host.inventory).mockClear();
      vi.mocked(test.host.conversation).mockClear();
      vi.mocked(test.host.safety).mockClear();
      clock += delay * 1000 - 1;
      await board.refresh();
      expect(test.host.inventory).toHaveBeenCalledTimes(1);
      expect(test.host.conversation).not.toHaveBeenCalled();
      expect(test.host.safety).not.toHaveBeenCalled();
      expect(board.snapshot().cards.map((card) => card.issue)).toEqual([
        "git-dirty",
        "git-dirty",
      ]);
      clock++;
      await board.refresh();
      expect(test.host.inventory).toHaveBeenCalledTimes(3);
      expect(test.host.conversation).toHaveBeenCalledTimes(4);
      expect(test.host.safety).toHaveBeenCalledTimes(2);
      expect(test.host.archive).not.toHaveBeenCalled();
    }
    expect(test.store.current).not.toHaveProperty("archiveDeferrals");
  } finally {
    board.dispose();
  }
});

it("rechecks changed activity promptly and resets the backoff when the blocking reason changes", async () => {
  const test = dueFixture();
  let clock = test.now();
  const board = new Workboard(test.host, test.store, () => clock);
  test.inventory.agents[0].activity = "running";
  test.host.safety = vi.fn(async () => "git-dirty");
  test.host.conversation = vi.fn(test.host.conversation);
  try {
    await board.start();
    expect(board.snapshot().cards[0].issue).toBe("agent-busy");
    vi.mocked(test.host.conversation).mockClear();
    clock += 30_000;
    await board.refresh();
    expect(test.host.conversation).not.toHaveBeenCalled();
    expect(test.host.safety).not.toHaveBeenCalled();
    test.inventory.agents[0].activity = "idle";
    await board.refresh();
    expect(board.snapshot().cards[0].issue).toBe("git-dirty");
    expect(test.host.safety).toHaveBeenCalledTimes(1);
    clock += 60_000;
    await board.refresh(); // Same reason now waits 120 seconds.
    expect(test.host.safety).toHaveBeenCalledTimes(2);
    vi.mocked(test.host.safety).mockResolvedValue("git-no-upstream");
    clock += 120_000;
    await board.refresh();
    expect(board.snapshot().cards[0].issue).toBe("git-no-upstream");
    expect(test.host.safety).toHaveBeenCalledTimes(3);
    clock += 60_000;
    await board.refresh(); // New reason starts again at 60 seconds.
    expect(test.host.safety).toHaveBeenCalledTimes(4);
    expect(test.host.archive).not.toHaveBeenCalled();
  } finally {
    board.dispose();
  }
});

it("defers an unknown verification timeline and retries after the deadline", async () => {
  const test = dueFixture();
  let clock = test.now();
  const board = new Workboard(test.host, test.store, () => clock);
  test.host.conversation = vi.fn(async (_agent, _now, options) =>
    options?.archivedTimeline
      ? observed(null)
      : observed("2026-08-01T00:00:00Z"),
  );
  try {
    await board.start();
    expect(board.snapshot().cards[0].issue).toBe("conversation-unknown");
    expect(test.host.conversation).toHaveBeenCalledTimes(2);
    clock += 59_999;
    await board.refresh();
    expect(test.host.conversation).toHaveBeenCalledTimes(2);
    test.host.conversation = vi.fn(agentEvidence("2026-08-01T00:00:00Z"));
    clock++;
    await board.refresh();
    expect(test.host.archive).toHaveBeenCalledExactlyOnceWith("old");
  } finally {
    board.dispose();
  }
});

it("keeps each archive's final inventory confirmation even when candidates share scan inventory", async () => {
  const test = dueFixture();
  test.inventory.workspaces.push(workspace("second", undefined, ["task:done"]));
  test.inventory.agents.push({
    ...test.inventory.agents[0],
    id: "b",
    workspaceId: "second",
  });
  test.host.inventory = vi.fn(test.host.inventory);
  test.host.safety = vi.fn(async () => null);
  try {
    await test.board.start();
    expect(test.host.archive).toHaveBeenCalledTimes(2);
    expect(test.host.inventory).toHaveBeenCalledTimes(6); // Reconcile + shared scan + two pre-send + two post-send reads.
    expect(test.host.safety).toHaveBeenCalledTimes(4);
  } finally {
    test.board.dispose();
  }
});

it("clears process-local backoff on restart without weakening safety checks", async () => {
  const test = dueFixture();
  test.host.safety = vi.fn(async () => "git-dirty");
  await test.board.start();
  test.board.dispose();
  const reopened = new Workboard(test.host, new Store(test.backing), test.now);
  try {
    await reopened.start();
    expect(test.host.safety).toHaveBeenCalledTimes(2);
    expect(test.host.archive).not.toHaveBeenCalled();
    expect(reopened.snapshot().cards[0].issue).toBe("git-dirty");
  } finally {
    reopened.dispose();
  }
});

it("refuses native archive if the final inventory reveals activity without a change event", async () => {
  const test = dueFixture();
  const inventory = test.host.inventory;
  let reads = 0;
  test.host.inventory = vi.fn(async () => {
    if (++reads === 3) test.inventory.agents[0].activity = "running";
    return inventory();
  });
  try {
    await test.board.start();
    expect(test.host.inventory).toHaveBeenCalledTimes(3);
    expect(test.host.archive).not.toHaveBeenCalled();
    expect(test.board.snapshot().cards[0]).toMatchObject({
      archived: null,
      issue: "changed-during-check",
    });
  } finally {
    test.board.dispose();
  }
});

it("continues backoff when reconciliation itself loses the conversation gate", async () => {
  const test = dueFixture();
  let clock = test.now();
  const board = new Workboard(test.host, test.store, () => clock);
  test.host.safety = vi.fn(async () => "git-dirty");
  try {
    await board.start();
    test.host.conversation = vi.fn(agentEvidence(null));
    clock += 60_000;
    await board.refresh();
    expect(board.snapshot().cards[0].conversationGateEvidence).toBe("unknown");
    expect(test.host.conversation).toHaveBeenCalledTimes(1);
    clock += 60_000; // First conversation failure retries at 60 seconds.
    await board.refresh();
    expect(test.host.conversation).toHaveBeenCalledTimes(2);
    clock += 60_000; // Same failure now waits 120 seconds.
    await board.refresh();
    expect(test.host.conversation).toHaveBeenCalledTimes(2);
    expect(test.host.safety).toHaveBeenCalledTimes(1);
    expect(test.host.archive).not.toHaveBeenCalled();
  } finally {
    board.dispose();
  }
});

it("rechecks ownership readiness at the same clock after a git-unknown deferral, preserving the archive gates", async () => {
  const test = dueFixture();
  const native = test.inventory.workspaces[0];
  native.projectKind = "git";
  native.workspaceKind = "worktree";
  test.host.safety = vi.fn(async (workspace) =>
    workspace.gitRuntime?.isPaseoOwnedWorktree === true ? null : "git-unknown",
  );
  await test.board.start();
  try {
    expect(test.board.snapshot().cards[0]).toMatchObject({
      issue: "git-unknown",
      archived: null,
      conversationGateEvidence: "exact",
    });
    expect(test.host.archive).not.toHaveBeenCalled();
    const before = test.now();
    native.gitRuntime = { isPaseoOwnedWorktree: true } as NonNullable<
      typeof native.gitRuntime
    >;
    await test.board.refresh();
    expect(test.now()).toBe(before);
    expect(test.host.safety).toHaveBeenCalledTimes(3); // Initial rejection, candidate check, final pre-send check.
    expect(test.host.archive).toHaveBeenCalledExactlyOnceWith("old");
    expect(test.board.snapshot().cards[0]).toMatchObject({
      conversationGateEvidence: "exact",
      conversationGateAt: "2026-08-01T00:00:00.000Z",
      archived: { status: "archived" },
    });
  } finally {
    test.board.dispose();
  }
});
