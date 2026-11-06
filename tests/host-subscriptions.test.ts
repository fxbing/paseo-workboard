import { expect, it, vi } from "vitest";
import type {
  PaseoApi,
  PaseoAgentTimelineEvent,
  SubscriptionObserver,
} from "@getpaseo/client";
import { PaseoHost } from "../server/host";
import type { PaseoCompat } from "../server/paseo-compat";
import { workspace } from "./fixtures";

const old = "2026-08-01T00:00:00.000Z";
const recent = "2026-08-02T00:00:00.000Z";
const agent = (id: string, status = "idle") => ({
  id,
  workspaceId: "w1",
  title: id,
  status,
  createdAt: old,
  updatedAt: old,
  lastUserMessageAt: old,
  archivedAt: null as string | null,
  labels: {},
  pendingPermissions: [],
  attentionReason: null,
  activeTurn: null,
  lastError: null,
  requiresAttention: false,
});
function setup(rows = [agent("a", "running")]) {
  const observers: SubscriptionObserver<unknown>[] = [];
  const timelineListeners = new Map<
    string,
    (event: PaseoAgentTimelineEvent) => void
  >();
  const stops = new Map<string, ReturnType<typeof vi.fn>>();
  const state = {
    rows,
    workspaces: [workspace("w1")],
    beforePage: undefined as
      | ((cursor?: string) => void | Promise<void>)
      | undefined,
    timeline: {
      epoch: "e",
      gap: false,
      staleCursor: false,
      error: null,
      hasOlder: false,
      startCursor: null as { epoch: string; seq: number } | null,
      window: { maxSeq: 1 },
      entries: [{ timestamp: old, item: { type: "assistant_message" } }],
      agent: rows[0],
    },
  };
  const subscription = (snapshot: unknown = {}) => ({
    subscribe: (observer: SubscriptionObserver<unknown>) => {
      observers.push(observer);
      observer.snapshot(snapshot);
      return () => {};
    },
    release: vi.fn(async () => {}),
    ready: Promise.resolve({}),
  });
  const listWorkspaces = vi.fn(async (options: { subscribe?: object }) => ({
    entries: structuredClone(state.workspaces),
    pageInfo: { hasMore: false, nextCursor: null },
    subscription: options.subscribe
      ? subscription({ entries: structuredClone(state.workspaces) })
      : undefined,
  }));
  const listAgents = vi.fn(
    async (options: { subscribe?: object; page?: { cursor?: string } }) => {
      if (!options.subscribe) await state.beforePage?.(options.page?.cursor);
      const offset = Number(options.page?.cursor ?? 0);
      return {
        entries: structuredClone(state.rows.slice(offset, offset + 200)).map(
          (agent) => ({ agent }),
        ),
        pageInfo: {
          hasMore: state.rows.length > offset + 200,
          nextCursor:
            state.rows.length > offset + 200 ? String(offset + 200) : null,
        },
        subscription: options.subscribe ? subscription() : undefined,
      };
    },
  );
  const listProjects = vi.fn(async () => ({ projects: [] }));
  const readTimeline = vi.fn(async () => structuredClone(state.timeline));
  const subscribeTimeline = vi.fn(
    (id: string, listener: (event: PaseoAgentTimelineEvent) => void) => {
      timelineListeners.set(id, listener);
      const stop = vi.fn();
      stops.set(id, stop);
      return Object.assign(stop, { ready: Promise.resolve() });
    },
  );
  const api = {
    workspaces: { list: listWorkspaces },
    agents: {
      list: listAgents,
      ref: (id: string) => ({
        timeline: {
          refetch: readTimeline,
          subscribe: (listener: (event: PaseoAgentTimelineEvent) => void) =>
            subscribeTimeline(id, listener),
        },
      }),
    },
    projects: { list: listProjects },
    observeEvents: () => subscription(),
  };
  const changed = vi.fn();
  const host = new PaseoHost(
    api as unknown as PaseoApi,
    { subagents: async () => [] } as unknown as PaseoCompat,
    { serverId: "h", version: "0.15.2" },
    changed,
  );
  const emit = (index: number, message: unknown) =>
    observers[index].update(
      message as Parameters<SubscriptionObserver<unknown>["update"]>[0],
    );
  return {
    host,
    state,
    observers,
    emit,
    changed,
    timelineListeners,
    stops,
    listWorkspaces,
    listAgents,
    listProjects,
    readTimeline,
    subscribeTimeline,
  };
}

it("keeps archived and off-page Agents while directory events update a cached board", async () => {
  const rows = Array.from({ length: 205 }, (_, i) => agent(String(i)));
  rows[204].archivedAt = recent;
  const test = setup(rows);
  test.state.beforePage = (cursor) => {
    if (!cursor) return;
    test.emit(1, {
      type: "agent_update",
      payload: { kind: "remove", agentId: "3" },
    });
    test.emit(1, {
      type: "agent_update",
      payload: {
        kind: "upsert",
        agent: {
          ...rows[1],
          title: "Changed while paging",
          updatedAt: recent,
        },
      },
    });
  };
  try {
    const first = await test.host.inventory();
    expect(first.agents).toHaveLength(204);
    expect(first.agents.some((row) => row.id === "3")).toBe(false);
    expect(first.agents.find((row) => row.id === "1")?.title).toBe(
      "Changed while paging",
    );
    expect(first.agents.find((row) => row.id === "204")?.archivedAt).toBe(
      recent,
    );
    for (const [options] of test.listAgents.mock.calls)
      expect(options).toMatchObject({
        filter: { includeArchived: true },
        sort: [{ key: "created_at", direction: "asc" }],
      });
    expect(test.listWorkspaces).toHaveBeenCalledWith({
      sync: {},
      subscribe: {},
    });
    test.emit(0, {
      type: "workspace_update",
      payload: {
        kind: "upsert",
        workspace: {
          ...workspace("w1"),
          githubRuntime: { pullRequest: { number: 7, title: "Fresh PR" } },
        },
      },
    });
    test.emit(2, {
      type: "project.update",
      payload: {
        kind: "upsert",
        project: {
          projectId: "p",
          projectDisplayName: "New project",
          projectRootPath: "/fixture",
          projectKind: "git",
        },
      },
    });
    const scripts = [{ name: "setup", lifecycle: "running" }];
    test.emit(2, {
      type: "script_status_update",
      payload: { workspaceId: "w1", scripts },
    });
    const current = await test.host.currentInventory();
    expect(current.workspaces[0]).toMatchObject({
      githubRuntime: { pullRequest: { number: 7 } },
      scripts,
    });
    expect(current.projects).toEqual([
      { id: "p", name: "New project", directory: "/fixture", isGit: true },
    ]);
    expect(test.changed).toHaveBeenLastCalledWith("w1", false, false);
    expect(test.listWorkspaces).toHaveBeenCalledTimes(1);
    expect(test.listAgents).toHaveBeenCalledTimes(3);
    expect(test.listProjects).toHaveBeenCalledTimes(1);
  } finally {
    test.host.dispose();
  }
});

it("follows assistant-only timeline changes using the read's current descriptor and releases inactive subscriptions", async () => {
  const test = setup();
  try {
    const first = await test.host.inventory();
    expect(test.subscribeTimeline).toHaveBeenCalledTimes(1);
    expect(test.readTimeline).not.toHaveBeenCalled();
    test.state.timeline.agent = { ...test.state.rows[0], updatedAt: recent };
    test.state.timeline.entries[0].timestamp = recent;
    test.changed.mockClear();
    test.timelineListeners.get("a")!({
      agentId: "a",
      event: { type: "subscription_restored" },
      subscriptionId: "new",
    });
    expect(test.changed).toHaveBeenCalledWith("w1", false, true);
    const evidence = await test.host.conversation(
      first.agents[0],
      Date.parse(recent),
    );
    expect(evidence).toMatchObject({
      displayAt: recent,
      display: "exact",
      gateAt: recent,
      gate: "exact",
    });
    expect(test.readTimeline).toHaveBeenCalledTimes(1);
    expect((await test.host.currentInventory()).agents[0].updatedAt).toBe(
      recent,
    );
    const stop = test.stops.get("a")!;
    test.emit(1, {
      type: "agent_update",
      payload: {
        kind: "upsert",
        agent: { ...test.state.rows[0], status: "idle" },
      },
    });
    expect(stop).toHaveBeenCalledTimes(1);
    const idle = await test.host.currentInventory();
    await test.host.conversation(idle.agents[0], Date.parse(recent));
    expect(test.readTimeline).toHaveBeenCalledTimes(1);
    const calls = test.changed.mock.calls.length;
    test.timelineListeners.get("a")!({
      agentId: "a",
      event: { type: "subscription_restored" },
      subscriptionId: "late",
    });
    expect(test.changed).toHaveBeenCalledTimes(calls);
    test.emit(1, {
      type: "agent_update",
      payload: { kind: "upsert", agent: test.state.rows[0] },
    });
    expect(test.subscribeTimeline).toHaveBeenCalledTimes(2);
  } finally {
    test.host.dispose();
  }
  expect(test.stops.get("a")).toHaveBeenCalledTimes(1);
});

it("discards a paginated read across a restored subscription and rebuilds the cache", async () => {
  const test = setup([agent("a")]);
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  test.state.beforePage = async () => {
    entered();
    await waiting;
  };
  try {
    const pending = test.host.inventory();
    const rejected = expect(pending).rejects.toThrow("directory changed");
    await started;
    test.observers[0].snapshot({});
    test.state.rows = [agent("new")];
    release();
    await rejected;
    test.state.beforePage = undefined;
    expect(
      (await test.host.currentInventory()).agents.map((row) => row.id),
    ).toEqual(["new"]);
    expect(test.changed).toHaveBeenCalledWith(undefined, true, true);
  } finally {
    test.host.dispose();
  }
});

it("keeps archive recheck bounds when loading an idle runtime stamps its history", async () => {
  const test = setup([agent("a")]);
  try {
    const first = await test.host.inventory();
    test.state.timeline.agent = { ...test.state.rows[0], updatedAt: recent };
    test.state.timeline.entries[0].timestamp = recent;
    const evidence = await test.host.conversation(
      first.agents[0],
      Date.parse(recent),
      { recheck: true },
    );
    expect(evidence).toEqual({
      displayAt: old,
      display: "lower-bound",
      gateAt: old,
      gate: "upper-bound",
      reason: "replay-timestamp",
    });
    expect(test.readTimeline).toHaveBeenCalledTimes(1);
    expect(test.subscribeTimeline).not.toHaveBeenCalled();
    expect((await test.host.currentInventory()).agents[0].updatedAt).toBe(old);
  } finally {
    test.host.dispose();
  }
});

it("refuses conversation evidence when its directory reconnects during look-back", async () => {
  const test = setup();
  try {
    const first = await test.host.inventory();
    test.readTimeline.mockImplementationOnce(async () => ({
      ...test.state.timeline,
      hasOlder: true,
      startCursor: { epoch: "e", seq: 3 },
      entries: [],
    }));
    test.readTimeline.mockImplementationOnce(async () => {
      test.observers[0].snapshot({ entries: test.state.workspaces });
      return test.state.timeline;
    });
    expect(
      await test.host.conversation(first.agents[0], Date.parse(recent)),
    ).toMatchObject({
      display: "lower-bound",
      gate: "upper-bound",
      reason: "timeline-unreadable",
    });
  } finally {
    test.host.dispose();
  }
});

it("retries failed active timeline subscriptions without polling the directory or waking idle Agents", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(recent));
  const test = setup();
  try {
    await test.host.inventory();
    test.timelineListeners.get("a")!({
      agentId: "a",
      event: { type: "error", error: "Lost observation" },
    });
    expect(test.stops.get("a")).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.parse(recent) + 59_999);
    await test.host.currentInventory();
    expect(test.subscribeTimeline).toHaveBeenCalledTimes(1);
    test.changed.mockClear();
    vi.setSystemTime(Date.parse(recent) + 60_000);
    await test.host.currentInventory();
    expect(test.subscribeTimeline).toHaveBeenCalledTimes(2);
    expect(test.changed).toHaveBeenCalledWith("w1", false, true);
    expect(test.listAgents).toHaveBeenCalledTimes(2);
    expect(test.readTimeline).not.toHaveBeenCalled();
  } finally {
    test.host.dispose();
    vi.useRealTimers();
  }
});

it("ignores callbacks from released directory subscriptions after rebuilding", async () => {
  const test = setup([agent("a")]);
  try {
    await test.host.inventory();
    test.observers[1].error!(new Error("Lost directory"));
    await test.host.currentInventory();
    test.changed.mockClear();
    test.emit(0, {
      type: "workspace_update",
      payload: { kind: "remove", id: "w1" },
    });
    expect(
      (await test.host.currentInventory()).workspaces.map((row) => row.id),
    ).toEqual(["w1"]);
    expect(test.changed).not.toHaveBeenCalled();
  } finally {
    test.host.dispose();
  }
});
