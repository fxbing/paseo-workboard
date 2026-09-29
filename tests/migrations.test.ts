import { expect, it } from "vitest";
import { migrateData } from "../shared/migrations";
import {
  DEFAULT_GROUPS,
  DEFAULT_LABELS,
  groupsSchema,
  groupOrderSchema,
  settingsSchema,
  newTask,
  orderedGroups,
} from "../shared/model";
import { mutationSchema } from "../shared/rpc";

it.each(["zh", "en"])(
  "removes the v4 language preference %s while retaining tasks, groups and pin ownership",
  (language) => {
    const settings = {
      ...settingsSchema.parse({}),
      autoArchive: true,
      pinInProgressWorkspaces: false,
      groups: [
        ...DEFAULT_GROUPS,
        {
          id: "ideas",
          kind: "todo",
          name: "Ideas",
          label: "task:ideas",
          color: "violet",
        },
      ],
      groupOrder: ["ideas", "todo"],
    };
    const previous = {
      schemaVersion: 4,
      revision: 7,
      serverId: "fixture-host",
      settings: { ...settings, language },
      tasks: [newTask("draft", "Idea", "2026-09-23T00:00:00Z")],
      autoPins: { "workspace-1": "2026-09-23T00:00:00Z" },
    };
    const migrated = migrateData(previous, 4);
    expect(migrated).toEqual({ ...previous, schemaVersion: 6, settings });
    expect(migrated.settings).not.toHaveProperty("language");
  },
);

it.each([true, false])(
  "migrates the v3 pin preference %s to sidebar pinning without adopting manual pins",
  (value) => {
    const task = newTask("existing", "Existing", "2026-09-24T00:00:00Z");
    const result = migrateData(
      {
        schemaVersion: 3,
        settings: { pinRunningWorkspaces: value, language: "zh" },
        tasks: [task],
      },
      3,
    );
    expect(result.schemaVersion).toBe(6);
    expect(result.settings.pinInProgressWorkspaces).toBe(value);
    expect(result.settings).not.toHaveProperty("pinRunningWorkspaces");
    expect(result.settings).not.toHaveProperty("language");
    expect(result.settings.groups).toEqual(DEFAULT_GROUPS);
    expect(result.autoPins).toEqual({});
    expect(result.tasks).toEqual([task]);
  },
);

it("retains implicit defaults when upgrading v1 settings", () => {
  expect(migrateData({ schemaVersion: 1 }, 1).settings.groups).toEqual(
    DEFAULT_GROUPS,
  );
});

it("adds Inbox to v2 without replacing colliding custom groups, labels, order or tasks", () => {
  const groups = [
    ...DEFAULT_GROUPS.filter((group) => group.id !== "inbox"),
    { id: "inbox", kind: "todo", name: "Ideas", label: " TASK:INBOX " },
  ];
  const previous = {
    schemaVersion: 2,
    revision: 9,
    serverId: "fixture-host",
    settings: {
      autoArchive: true,
      pinRunningWorkspaces: false,
      language: "zh",
      groups,
      groupOrder: [
        "review",
        "todo",
        "in-progress",
        "done",
        "canceled",
        "inbox",
      ],
    },
    tasks: [newTask("draft", "Idea", "2026-09-23T00:00:00Z")],
  };
  const result = migrateData(previous, 2);
  expect(result.schemaVersion).toBe(6);
  expect(
    result.settings.groups.find((group) => group.kind === "inbox"),
  ).toEqual({
    id: "inbox-2",
    kind: "inbox",
    name: null,
    label: "task:inbox-2",
  });
  expect(
    result.settings.groups.find((group) => group.id === "inbox"),
  ).toMatchObject({ kind: "todo", name: "Ideas", label: "TASK:INBOX" });
  expect(orderedGroups(result.settings).map((group) => group.id)).toEqual([
    "inbox-2",
    "review",
    "todo",
    "in-progress",
    "done",
    "canceled",
    "inbox",
  ]);
  expect(result.tasks).toEqual(previous.tasks);
  expect(result.settings).toMatchObject({
    autoArchive: true,
    pinInProgressWorkspaces: false,
  });
  expect(result.revision).toBe(9);
});

it("migrates v1 settings, task identities, pending binding and archived history without resetting preferences", () => {
  const task = newTask("draft", "Idea", "2026-09-23T00:00:00Z");
  const binding = {
    operationId: "bind-1",
    workspaceId: null,
    target: { kind: "new", source: { kind: "directory", path: "/fixture" } },
  };
  const archived = {
    operationId: "archive-1",
    kind: "automatic",
    status: "archived",
    stage: "done",
    startedAt: "2026-09-22T00:00:00Z",
    archivedAt: "2026-09-22T00:00:01Z",
    lastConversationAt: "2026-08-01T00:00:00Z",
    detail: "Archived",
  };
  const result = migrateData(
    {
      schemaVersion: 1,
      revision: 42,
      serverId: "fixture-host",
      settings: {
        autoArchive: true,
        pinRunningWorkspaces: false,
        language: "en",
        labels: { ...DEFAULT_LABELS, done: "workflow:shipped" },
      },
      tasks: [
        task,
        { ...task, id: "binding", binding },
        {
          ...task,
          id: "finished",
          workspaceId: "workspace-1",
          lastStage: "done",
          archived,
        },
      ],
    },
    1,
  );
  expect(result).toMatchObject({
    schemaVersion: 6,
    revision: 42,
    serverId: "fixture-host",
    settings: {
      autoArchive: true,
      pinInProgressWorkspaces: false,
      groupOrder: [],
    },
  });
  expect(result.settings.groups).toEqual(
    DEFAULT_GROUPS.map((group) =>
      group.id === "done" ? { ...group, label: "workflow:shipped" } : group,
    ),
  );
  expect(result.tasks[0]).toEqual(task);
  expect(result.tasks[1].binding).toEqual({ ...binding, stage: "in-progress" });
  expect(result.tasks[2].archived).toEqual({
    ...archived,
    group: { id: "done", kind: "done", name: null, label: "workflow:shipped" },
  });
});

it("rejects unsupported storage and ambiguous legacy mappings instead of replacing data", () => {
  expect(() => migrateData({}, 6)).toThrow("Unsupported");
  expect(() => migrateData({ schemaVersion: 2 }, 1)).toThrow();
  expect(() =>
    migrateData(
      { settings: { labels: { ...DEFAULT_LABELS, done: "task:todo" } } },
      1,
    ),
  ).toThrow();
});

it("splits the v5 conversation status into display and gate evidence", () => {
  const result = migrateData(
    {
      schemaVersion: 5,
      revision: 3,
      serverId: "fixture-host",
      settings: settingsSchema.parse({}),
      tasks: [
        {
          ...newTask("known", "Known", "2026-09-23T00:00:00Z"),
          workspaceId: "w1",
          lastConversationAt: "2026-08-01T00:00:00Z",
          conversationStatus: "known",
          conversationAgents: ["a1", "a1/provider/c1"],
        },
        {
          ...newTask("stale", "Stale", "2026-09-23T00:00:00Z"),
          workspaceId: "w2",
          lastConversationAt: "2026-08-02T00:00:00Z",
          conversationStatus: "unknown",
        },
        {
          ...newTask("empty", "Empty", "2026-09-23T00:00:00Z"),
          workspaceId: "w3",
          conversationStatus: "none",
        },
      ],
    },
    5,
  );
  expect(result.schemaVersion).toBe(6);
  expect(result.tasks[0]).toMatchObject({
    conversationDisplayEvidence: "exact",
    conversationGateAt: "2026-08-01T00:00:00Z",
    conversationGateEvidence: "exact",
    conversationAgents: [
      { id: "a1", lastObservedAt: null, seenWhileLive: true },
      {
        id: "a1/provider/c1",
        lastObservedAt: null,
        seenWhileLive: true,
      },
    ],
  });
  // A once exact observation stays a lower bound: the real last message may be newer, so it
  // must never gate archiving.
  expect(result.tasks[1]).toMatchObject({
    conversationDisplayEvidence: "lower-bound",
    conversationGateAt: null,
    conversationGateEvidence: "unknown",
  });
  expect(result.tasks[2]).toMatchObject({
    conversationDisplayEvidence: "none",
    conversationGateEvidence: "unknown",
  });
});

it("rejects ambiguous labels or identities and missing default destinations", () => {
  for (const groups of [
    [
      ...DEFAULT_GROUPS,
      { id: "another", kind: "review", name: "Other", label: " TASK:TODO " },
    ],
    [
      ...DEFAULT_GROUPS,
      { id: "todo", kind: "todo", name: "Other", label: "task:another" },
    ],
    [
      ...DEFAULT_GROUPS,
      { id: "conflict", kind: "todo", name: "Other", label: "task:another" },
    ],
    DEFAULT_GROUPS.filter((group) => group.kind !== "todo"),
    DEFAULT_GROUPS.filter((group) => group.kind !== "inbox"),
    [{ id: "todo", kind: "todo", name: " ", label: "task:todo" }],
  ])
    expect(groupsSchema.safeParse(groups).success).toBe(false);
  expect(groupOrderSchema.safeParse(["todo", "todo"]).success).toBe(false);
  expect(
    mutationSchema.safeParse({
      action: "settings",
      revision: 1,
      settings: { language: "en", labels: DEFAULT_LABELS },
    }).success,
  ).toBe(false);
});
