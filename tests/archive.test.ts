import { afterEach, expect, it, vi } from "vitest";
import { settingsSchema } from "../shared/model";
import { Workboard } from "../server/workboard";
import { Store } from "../server/store";
import { agentEvidence, fixture, observed, workspace } from "./fixtures";
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
