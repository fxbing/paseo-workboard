import { expect, it, vi } from "vitest";
import type {
  PaseoApi,
  OwnedSubscription,
  SubscriptionObserver,
} from "@getpaseo/client";
import { allPages, PaseoHost } from "../server/host";
import type { PaseoCompat } from "../server/paseo-compat";
import { providerHost, workspace } from "./fixtures";

it("reads every page and rejects a cursor loop instead of silently truncating", async () => {
  expect(
    await allPages(async (cursor) =>
      cursor
        ? { entries: [201], pageInfo: { hasMore: false, nextCursor: null } }
        : {
            entries: Array.from({ length: 200 }, (_, i) => i + 1),
            pageInfo: { hasMore: true, nextCursor: "second" },
          },
    ),
  ).toHaveLength(201);
  await expect(
    allPages(async () => ({
      entries: [],
      pageInfo: { hasMore: true, nextCursor: "loop" },
    })),
  ).rejects.toThrow("pagination");
});
it("keeps directory and subagent subscriptions across inventories, overlays off-page changes and refreshes restored snapshots", async () => {
  const observers: SubscriptionObserver<unknown>[] = [];
  const release = vi.fn(async () => {});
  const subscribe = () =>
    ({
      ready: Promise.resolve({ subscriptionId: "s" }),
      subscriptionId: "s",
      release,
      subscribe: (observer: SubscriptionObserver<unknown>) => {
        observers.push(observer);
        observer.snapshot({ subscriptionId: "s" });
        return () => {};
      },
    }) as OwnedSubscription<unknown>;
  const rows = Array.from({ length: 201 }, (_, i) => ({
    ...workspace(String(i)),
    syncSeq: 1,
  }));
  let subscriptionRequests = 0;
  const api = {
    observeEvents: subscribe,
    workspaces: {
      list: async (options: {
        subscribe?: object;
        page?: { cursor?: string };
      }) => {
        if (options.subscribe) {
          subscriptionRequests++;
          return {
            entries: rows.slice(0, 200),
            subscription: subscribe(),
            pageInfo: { nextCursor: "tail", hasMore: true },
          };
        }
        if (options.page?.cursor) {
          observers[0].update({
            type: "workspace_update",
            payload: {
              kind: "upsert",
              workspace: {
                ...rows[200],
                name: "Fresh beyond page one",
                forge: "gitlab",
                githubRuntime: {
                  pullRequest: {
                    number: 42,
                    url: "https://code.example/team/repo/-/merge_requests/42",
                    title: "Updated MR",
                    state: "OPEN",
                    baseRefName: "main",
                    headRefName: "fix",
                    isMerged: false,
                  },
                },
                syncSeq: 2,
              },
            },
          } as Parameters<(typeof observers)[0]["update"]>[0]);
          return {
            entries: rows.slice(200),
            pageInfo: { nextCursor: null, hasMore: false },
          };
        }
        return {
          entries: rows.slice(0, 200),
          pageInfo: { nextCursor: "tail", hasMore: true },
        };
      },
    },
    agents: {
      list: async (options: { subscribe?: object }) => {
        if (options.subscribe) subscriptionRequests++;
        return {
          entries: [],
          subscription: options.subscribe ? subscribe() : undefined,
          pageInfo: { nextCursor: null, hasMore: false },
        };
      },
    },
    projects: { list: async () => ({ projects: [] }) },
  };
  const changed = vi.fn();
  const host = new PaseoHost(
    api as unknown as PaseoApi,
    {} as PaseoCompat,
    { serverId: "h", version: "0.9.1" },
    changed,
  );
  try {
    const first = await host.inventory();
    expect(first.workspaces).toHaveLength(201);
    expect(first.workspaces[200].name).toBe("Fresh beyond page one");
    expect(first.workspaces[200]).toMatchObject({
      forge: "gitlab",
      githubRuntime: { pullRequest: { number: 42, title: "Updated MR" } },
    });
    await host.inventory();
    expect(subscriptionRequests).toBe(2);
    expect(release).not.toHaveBeenCalled();
    changed.mockClear();
    observers[0].snapshot({});
    expect(changed).toHaveBeenCalledTimes(1);
  } finally {
    host.dispose();
  }
  expect(release).toHaveBeenCalledTimes(3);
});

const parentAgent = {
  id: "parent",
  workspaceId: "w1",
  title: "Parent",
  updatedAt: "2026-08-03T00:00:00.000Z",
  lastUserMessageAt: null,
  archivedAt: null,
  pendingPermissions: [],
  attentionReason: null,
  status: "idle",
  activeTurn: null,
  lastError: null,
  requiresAttention: false,
};
/** An active agent may be asked about its history; an idle one may not. */
const runningAgent = {
  ...parentAgent,
  status: "running",
  activeTurn: { turnId: "turn-1", startedAt: "2026-08-03T00:00:00.000Z" },
};

it("does not restore provider sessions outside active workspaces", async () => {
  const subagents = vi.fn(async () => []);
  const host = providerHost(
    { ...parentAgent, workspaceId: "archived-workspace" },
    { subagents } as unknown as PaseoCompat,
  );
  try {
    const inventory = await host.inventory();
    expect(inventory.workspaces.map((w) => w.id)).toEqual(["w1"]);
    expect(subagents).not.toHaveBeenCalled();
  } finally {
    host.dispose();
  }
});

it("keeps an agent removal scoped to its last known workspace", async () => {
  const changed = vi.fn();
  const observers: SubscriptionObserver<unknown>[] = [];
  const host = providerHost(
    parentAgent,
    { subagents: async () => [] } as unknown as PaseoCompat,
    changed,
    observers,
  );
  try {
    await host.inventory();
    const remove = (agentId: string) =>
      observers[1].update({
        type: "agent_update",
        payload: { kind: "remove", agentId },
      } as Parameters<SubscriptionObserver<unknown>["update"]>[0]);
    remove("parent");
    expect(changed).toHaveBeenLastCalledWith("w1");
    remove("unknown");
    expect(changed).toHaveBeenLastCalledWith(undefined);
  } finally {
    host.dispose();
  }
});

it("merges provider-managed subagents and reads their projected conversation time", async () => {
  const read = vi.fn(async () => ({
    epoch: "epoch-1",
    gap: false,
    staleCursor: false,
    error: null,
    hasOlder: false,
    startCursor: null,
    window: { maxSeq: 2 },
    entries: [
      { timestamp: "2026-08-01T00:00:00.000Z", item: { type: "user_message" } },
      {
        timestamp: "2026-08-02T00:00:00.000Z",
        item: { type: "assistant_message" },
      },
    ],
  }));
  const compat = {
    subagents: vi.fn(async () => [
      {
        id: "child",
        title: "Worker",
        status: "completed",
        updatedAt: "2026-08-03T00:00:00.000Z",
      },
    ]),
    subagentTimeline: vi.fn(() => read),
  } as unknown as PaseoCompat;
  const host = providerHost(runningAgent, compat);
  try {
    const inventory = await host.inventory();
    const child = inventory.agents.find(
      (agent) => agent.id === "parent/provider/child",
    );
    expect(child).toMatchObject({
      workspaceId: "w1",
      parentAgentId: "parent",
      subagentId: "child",
      title: "Worker",
      activity: "idle",
    });
    expect(
      await host.conversation(child!, Date.parse("2026-08-04T00:00:00.000Z")),
    ).toEqual({
      displayAt: "2026-08-02T00:00:00.000Z",
      display: "exact",
      gateAt: "2026-08-02T00:00:00.000Z",
      gate: "exact",
      reason: null,
    });
    expect(read).toHaveBeenCalledWith({ direction: "tail", limit: 200 });
  } finally {
    host.dispose();
  }
});

it("keeps a projected child whose row is newer than its descriptor unknown", async () => {
  const read = vi.fn(async () => ({
    epoch: "epoch-1",
    gap: false,
    staleCursor: false,
    error: null,
    hasOlder: false,
    startCursor: null,
    window: { maxSeq: 2 },
    entries: [
      {
        timestamp: "2026-08-04T00:00:00.000Z",
        item: { type: "assistant_message" },
      },
    ],
  }));
  const compat = {
    subagents: vi.fn(async () => [
      {
        id: "child",
        title: "Worker",
        status: "completed",
        updatedAt: "2026-08-03T00:00:00.000Z",
      },
    ]),
    subagentTimeline: vi.fn(() => read),
  } as unknown as PaseoCompat;
  const host = providerHost(runningAgent, compat);
  try {
    const child = (await host.inventory()).agents.find(
      (agent) => agent.id === "parent/provider/child",
    );
    // The stamped row is neither activity nor a conversation time, and a child descriptor
    // never bounds the archive gate.
    expect(
      await host.conversation(child!, Date.parse("2026-08-05T00:00:00.000Z")),
    ).toEqual({
      displayAt: null,
      display: "unknown",
      gateAt: null,
      gate: "unknown",
      reason: "replay-timestamp",
    });
  } finally {
    host.dispose();
  }
});

it("keeps a parent readable when its provider children cannot be listed", async () => {
  const read = vi.fn(async () => ({
    epoch: "epoch-1",
    gap: false,
    staleCursor: false,
    error: null,
    hasOlder: false,
    startCursor: null,
    window: { maxSeq: 2 },
    entries: [
      {
        timestamp: "2026-08-02T00:00:00.000Z",
        item: { type: "assistant_message" },
      },
    ],
  }));
  const compat = {
    subagents: vi.fn(async () => {
      throw new Error("provider unavailable");
    }),
  } as unknown as PaseoCompat;
  const host = providerHost(runningAgent, compat, vi.fn(), [], read);
  try {
    const parent = (await host.inventory()).agents.find(
      (agent) => agent.id === "parent",
    );
    expect(parent?.childEnumeration).toBe("unavailable");
    expect(compat.subagents).toHaveBeenCalledTimes(1);
    await host.inventory();
    // A cached record keeps the daemon from being asked once per agent and pass.
    expect(compat.subagents).toHaveBeenCalledTimes(1);
    const evidence = await host.conversation(
      parent!,
      Date.parse("2026-08-04T00:00:00.000Z"),
    );
    expect(evidence.display).toBe("exact");
    expect(evidence.displayAt).toBe("2026-08-02T00:00:00.000Z");
  } finally {
    host.dispose();
  }
});

it("never asks an idle agent about its history", async () => {
  const read = vi.fn(async () => ({
    epoch: "epoch-1",
    gap: false,
    staleCursor: false,
    error: null,
    hasOlder: false,
    startCursor: null,
    window: { maxSeq: 2 },
    entries: [
      {
        timestamp: "2026-08-02T00:00:00.000Z",
        item: { type: "assistant_message" },
      },
    ],
  }));
  const subagents = vi.fn(async () => []);
  const compat = { subagents } as unknown as PaseoCompat;
  const host = providerHost(
    { ...parentAgent, lastUserMessageAt: "2026-08-01T00:00:00.000Z" },
    compat,
    vi.fn(),
    [],
    read,
  );
  try {
    const agent = (await host.inventory()).agents.find(
      (candidate) => candidate.id === "parent",
    )!;
    expect(agent.activity).toBe("idle");
    // Listing children and reading a timeline both resume the agent's provider process,
    // so an idle agent is never asked about either.
    expect(subagents).not.toHaveBeenCalled();
    const evidence = await host.conversation(
      agent,
      Date.parse("2026-08-04T00:00:00.000Z"),
    );
    expect(read).not.toHaveBeenCalled();
    expect(evidence).toEqual({
      displayAt: "2026-08-01T00:00:00.000Z",
      display: "lower-bound",
      gateAt: "2026-08-03T00:00:00.000Z",
      gate: "upper-bound",
      reason: "inactive-metadata",
    });
  } finally {
    host.dispose();
  }
});

it("asks an active agent about its history", async () => {
  const read = vi.fn(async () => ({
    epoch: "epoch-1",
    gap: false,
    staleCursor: false,
    error: null,
    hasOlder: false,
    startCursor: null,
    window: { maxSeq: 2 },
    entries: [
      {
        timestamp: "2026-08-02T00:00:00.000Z",
        item: { type: "assistant_message" },
      },
    ],
  }));
  const subagents = vi.fn(async () => []);
  const compat = { subagents } as unknown as PaseoCompat;
  const host = providerHost(runningAgent, compat, vi.fn(), [], read);
  try {
    const agent = (await host.inventory()).agents.find(
      (candidate) => candidate.id === "parent",
    )!;
    expect(agent.activity).toBe("running");
    expect(agent.childEnumeration).toBe("complete");
    expect(subagents).toHaveBeenCalledTimes(1);
    const evidence = await host.conversation(
      agent,
      Date.parse("2026-08-04T00:00:00.000Z"),
    );
    expect(read).toHaveBeenCalled();
    expect(evidence).toEqual({
      displayAt: "2026-08-02T00:00:00.000Z",
      display: "exact",
      gateAt: "2026-08-02T00:00:00.000Z",
      gate: "exact",
      reason: null,
    });
  } finally {
    host.dispose();
  }
});

it("keeps a cached provider child without reading its timeline while the parent is idle", async () => {
  const read = vi.fn(async () => ({
    epoch: "epoch-1",
    gap: false,
    staleCursor: false,
    error: null,
    hasOlder: false,
    startCursor: null,
    window: { maxSeq: 2 },
    entries: [
      {
        timestamp: "2026-08-02T00:00:00.000Z",
        item: { type: "assistant_message" },
      },
    ],
  }));
  const childRead = vi.fn(read);
  const subagents = vi.fn(async () => [
    {
      id: "child",
      title: "Worker",
      status: "completed" as const,
      updatedAt: "2026-08-03T00:00:00.000Z",
    },
  ]);
  const compat = {
    subagents,
    subagentTimeline: vi.fn(() => childRead),
  } as unknown as PaseoCompat;
  const parent: Record<string, unknown> = { ...runningAgent };
  const host = providerHost(parent, compat, vi.fn(), [], read);
  try {
    const running = await host.inventory();
    expect(
      running.agents.find((agent) => agent.id === "parent/provider/child"),
    ).toBeDefined();
    // The parent goes idle. Listing its children again would resume the parent, so the
    // children seen while it was live are kept and nothing is asked.
    parent.status = "idle";
    parent.activeTurn = null;
    parent.updatedAt = "2026-08-04T00:00:00.000Z";
    const idle = await host.inventory();
    expect(subagents).toHaveBeenCalledTimes(1);
    expect(idle.agents.find((agent) => agent.id === "parent")).toMatchObject({
      childEnumeration: "unavailable",
    });
    const child = idle.agents.find(
      (agent) => agent.id === "parent/provider/child",
    )!;
    expect(child).toBeDefined();
    const evidence = await host.conversation(
      child,
      Date.parse("2026-08-05T00:00:00.000Z"),
    );
    // Reading a child's timeline loads its parent, so an idle parent's child stays unread.
    expect(compat.subagentTimeline).not.toHaveBeenCalled();
    expect(childRead).not.toHaveBeenCalled();
    expect(evidence).toEqual({
      displayAt: null,
      display: "unknown",
      gateAt: "2026-08-03T00:00:00.000Z",
      gate: "upper-bound",
      reason: "inactive-metadata",
    });
  } finally {
    host.dispose();
  }
});

it("lists a parent's children again once the parent wakes up", async () => {
  const subagents = vi.fn(async () => []);
  const compat = { subagents } as unknown as PaseoCompat;
  const parent: Record<string, unknown> = { ...parentAgent };
  const host = providerHost(parent, compat);
  try {
    await host.inventory();
    expect(subagents).not.toHaveBeenCalled();
    // The parent starts running: it may be asked about its children again.
    parent.status = "running";
    parent.activeTurn = {
      turnId: "turn-1",
      startedAt: "2026-08-03T00:00:00.000Z",
    };
    await host.inventory();
    expect(subagents).toHaveBeenCalledTimes(1);
  } finally {
    host.dispose();
  }
});

it("keeps an archived parent off every history request", async () => {
  const read = vi.fn(async () => ({
    epoch: "epoch-1",
    gap: false,
    staleCursor: false,
    error: null,
    hasOlder: false,
    startCursor: null,
    window: { maxSeq: 2 },
    entries: [
      {
        timestamp: "2026-08-02T00:00:00.000Z",
        item: { type: "assistant_message" },
      },
    ],
  }));
  const compat = { subagents: vi.fn() } as unknown as PaseoCompat;
  const host = providerHost(
    {
      ...parentAgent,
      archivedAt: "2026-08-03T01:00:00.000Z",
      lastUserMessageAt: "2026-08-01T00:00:00.000Z",
    },
    compat,
    vi.fn(),
    [],
    read,
  );
  try {
    const parent = (await host.inventory()).agents.find(
      (agent) => agent.id === "parent",
    );
    expect(parent?.childEnumeration).toBe("refused");
    expect(compat.subagents).not.toHaveBeenCalled();
    const periodic = await host.conversation(
      parent!,
      Date.parse("2026-08-04T00:00:00.000Z"),
    );
    // Reading a history resumes the archived agent's provider, so the plugin answers from
    // the recorded bounds and never asks for the timeline.
    expect(read).not.toHaveBeenCalled();
    expect(periodic).toEqual({
      displayAt: "2026-08-01T00:00:00.000Z",
      display: "lower-bound",
      gateAt: "2026-08-03T00:00:00.000Z",
      gate: "upper-bound",
      reason: "inactive-metadata",
    });
  } finally {
    host.dispose();
  }
});

it("never labels a lower bound exact when the recorded user message is missing", async () => {
  const read = vi.fn(async () => ({
    epoch: "epoch-1",
    gap: false,
    staleCursor: false,
    error: null,
    hasOlder: false,
    startCursor: null,
    window: { maxSeq: 2 },
    entries: [
      {
        timestamp: "2026-08-01T00:00:00.000Z",
        item: { type: "assistant_message" },
      },
    ],
  }));
  const compat = { subagents: vi.fn(async () => []) } as unknown as PaseoCompat;
  const host = providerHost(
    { ...runningAgent, lastUserMessageAt: "2026-08-02T00:00:00.000Z" },
    compat,
    vi.fn(),
    [],
    read,
  );
  try {
    const parent = (await host.inventory()).agents.find(
      (agent) => agent.id === "parent",
    );
    const evidence = await host.conversation(
      parent!,
      Date.parse("2026-08-04T00:00:00.000Z"),
    );
    // The record says a user message exists that this timeline does not show.
    expect(evidence).toEqual({
      displayAt: "2026-08-02T00:00:00.000Z",
      display: "lower-bound",
      gateAt: "2026-08-03T00:00:00.000Z",
      gate: "upper-bound",
      reason: "timeline-unreadable",
    });
  } finally {
    host.dispose();
  }
});
