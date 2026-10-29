import { describe, expect, it } from "vitest";
import {
  DEFAULT_GROUPS,
  settingsSchema,
  newTask,
  type Board,
  type Card,
} from "../shared/model";
import {
  boardNow,
  cardsForStage,
  attentionReasons,
  childrenSkippedForIdle,
  groupDeleteReason,
  groupTasks,
  mappingPreview,
  stageAtX,
  visibleCards,
  withOptimisticStages,
} from "../client/board-utils";

const card = (overrides: Partial<Card>): Card => ({
  ...newTask("a", "Fix import", "2026-01-01T00:00:00Z"),
  workspaceId: "workspace",
  projectId: "p1",
  projectName: "Demo",
  stage: "todo",
  labels: [],
  managedLabels: [],
  changeRequest: null,
  changeRequestUnavailable: false,
  pinState: "none",
  activity: "idle",
  dueAt: null,
  agents: [],
  ...overrides,
});
const archivedAgent = {
  id: "agent-1",
  title: "Old session",
  activity: "idle" as const,
  archived: true,
};
const board = (cards: Card[]) => ({ cards }) as Board;

describe("card drag targets", () => {
  it("keeps a target through the gap between independently sized columns", () => {
    const columns = {
      todo: { left: 12, right: 258 },
      review: { left: 268, right: 688 },
    };
    expect(stageAtX(261, columns, ["todo", "review"])).toBe("todo");
    expect(stageAtX(266, columns, ["todo", "review"])).toBe("review");
    expect(stageAtX(650, columns, ["todo", "review"])).toBe("review");
    expect(stageAtX(5, columns, ["todo", "review"])).toBeNull();
    expect(stageAtX(700, columns, ["todo", "review"])).toBeNull();
  });
});

describe("board card selection", () => {
  it("explains the same attention conditions without duplicating a label conflict", () => {
    expect(
      attentionReasons(
        card({
          activity: "waiting",
          stage: "conflict",
          issue: "labels-conflict",
        }),
      ),
    ).toEqual(["waiting", "labels-conflict"]);
    expect(attentionReasons(card({ issue: "git-dirty" }))).toEqual([
      "git-dirty",
    ]);
    expect(
      attentionReasons(card({ activity: "running", issue: "agent-busy" })),
    ).toEqual([]);
  });
  it("explains nonempty and required group deletion restrictions", () => {
    const inbox = DEFAULT_GROUPS.find((group) => group.id === "inbox")!;
    const todo = DEFAULT_GROUPS.find((group) => group.id === "todo")!;
    const review = DEFAULT_GROUPS.find((group) => group.id === "review")!;
    expect(groupDeleteReason([], DEFAULT_GROUPS, inbox)).toBe(
      "groupNeedsInbox",
    );
    expect(groupDeleteReason([], DEFAULT_GROUPS, todo)).toBe("groupNeedsTodo");
    expect(groupDeleteReason([], DEFAULT_GROUPS, review)).toBeNull();
    expect(
      groupDeleteReason(
        [],
        [...DEFAULT_GROUPS, { ...todo, id: "later" }],
        todo,
      ),
    ).toBe("groupDefaultInUse");
    expect(
      groupDeleteReason([card({ stage: "review" })], DEFAULT_GROUPS, review),
    ).toBe("groupDeleteNotEmpty");
    expect(
      groupDeleteReason(
        [card({ stage: "conflict", labels: [review.label, todo.label] })],
        DEFAULT_GROUPS,
        review,
      ),
    ).toBe("groupDeleteNotEmpty");
  });

  it("keeps actionable problems in attention while excluding normal activity and automatic deferrals", () => {
    const cards = [
      card({ id: "idle" }),
      card({ id: "running", activity: "running" }),
      card({ id: "no-history", issue: "no-conversation" }),
      card({ id: "busy", issue: "agent-busy" }),
      card({ id: "script", issue: "script-running" }),
      card({ id: "retry", issue: "changed-during-check" }),
      card({ id: "permission", activity: "waiting" }),
      card({ id: "error", activity: "error" }),
      card({ id: "unread", activity: "attention" }),
      card({ id: "conflict", stage: "conflict" }),
      card({ id: "binding", issue: "label-sync-incomplete" }),
      card({
        id: "history-unknown",
        issue: "conversation-unknown",
        agents: [archivedAgent],
      }),
      card({ id: "dirty", issue: "git-dirty" }),
      card({ id: "unpushed", issue: "git-unpushed" }),
      card({ id: "terminal", issue: "terminal-open" }),
      card({ id: "archive-unknown", issue: "native-archive-unknown" }),
    ];
    expect(
      visibleCards(board(cards), "all", "", true).map((item) => item.id),
    ).toEqual([
      "permission",
      "error",
      "unread",
      "conflict",
      "binding",
      "history-unknown",
      "dirty",
      "unpushed",
      "terminal",
      "archive-unknown",
    ]);
    expect(visibleCards(board(cards), "all", "", false)).toEqual(cards);
  });

  it("does not flag agentless workspaces for unknown conversation time", () => {
    const unknown = card({ id: "none", issue: "conversation-unknown" });
    expect(attentionReasons(unknown)).toEqual([]);
    expect(
      visibleCards(board([unknown]), "all", "", true).map((item) => item.id),
    ).toEqual([]);
    expect(attentionReasons(card({ issue: "git-dirty", agents: [] }))).toEqual([
      "git-dirty",
    ]);
    expect(
      attentionReasons(
        card({ issue: "conversation-unknown", agents: [archivedAgent] }),
      ),
    ).toEqual(["conversation-unknown"]);
    expect(
      attentionReasons(
        card({ issue: "conversation-unknown", workspaceId: null }),
      ),
    ).toEqual(["conversation-unknown"]);
  });

  it("keeps other attention reasons when an agentless workspace has unknown conversation time", () => {
    const value = card({
      issue: "conversation-unknown",
      stage: "conflict",
      changeRequest: {
        forge: "github",
        number: 42,
        url: "https://code.example/repo/pull/42",
        title: "Fix workspace sync",
        state: "open",
        checksStatus: "failure",
        reviewDecision: "changes_requested",
      },
    });
    expect(attentionReasons(value)).toEqual([
      "labels-conflict",
      "checks-failure",
      "changes-requested",
    ]);
    expect(visibleCards(board([value]), "all", "", true)).toEqual([value]);
  });

  it("flags failing checks or requested changes only on current open change requests", () => {
    const request: NonNullable<Card["changeRequest"]> = {
      forge: "gitlab",
      number: 42,
      url: "https://code.example/repo/-/merge_requests/42",
      title: "Fix sync",
      state: "open",
      checksStatus: "failure",
      reviewDecision: "pending",
    };
    const cards = [
      card({ id: "ci", changeRequest: request }),
      card({ id: "draft-ci", changeRequest: { ...request, state: "draft" } }),
      card({
        id: "changes",
        changeRequest: {
          ...request,
          checksStatus: "success",
          reviewDecision: "changes_requested",
        },
      }),
      card({
        id: "pending",
        changeRequest: { ...request, checksStatus: "pending" },
      }),
      card({
        id: "approved",
        changeRequest: {
          ...request,
          checksStatus: "success",
          reviewDecision: "approved",
        },
      }),
      card({
        id: "merged",
        changeRequest: {
          ...request,
          state: "merged",
          reviewDecision: "changes_requested",
        },
      }),
      card({ id: "closed", changeRequest: { ...request, state: "closed" } }),
      card({ id: "unknown", changeRequest: { ...request, state: "unknown" } }),
      card({
        id: "unavailable",
        changeRequest: request,
        changeRequestUnavailable: true,
      }),
      card({ id: "unlinked" }),
    ];
    expect(
      visibleCards(board(cards), "all", "", true).map((item) => item.id),
    ).toEqual(["ci", "draft-ci", "changes"]);
    cards[0].changeRequest = { ...request, checksStatus: "success" };
    cards[1].changeRequest = null;
    cards[2].changeRequest = {
      ...request,
      checksStatus: "success",
      reviewDecision: "approved",
    };
    expect(visibleCards(board(cards), "all", "", true)).toEqual([]);
  });

  it("counts conflicts and pending bindings as group members while excluding archived history", () => {
    const group = {
      id: "verification",
      kind: "review" as const,
      name: "联调",
      label: "task:verification",
    };
    const archived: Card["archived"] = {
      operationId: "op",
      status: "archived",
      kind: "automatic",
      stage: group.id,
      group,
      startedAt: "2026-01-01T00:00:00Z",
      archivedAt: null,
      lastConversationAt: null,
      detail: "ok",
    };
    expect(
      groupTasks(
        [
          card({ id: "direct", stage: group.id }),
          card({
            id: "conflict",
            stage: "conflict",
            labels: ["TASK:VERIFICATION", "task:todo"],
          }),
          card({
            id: "binding",
            binding: {
              operationId: "bind",
              stage: group.id,
              workspaceId: null,
              target: { kind: "existing", workspaceId: "w" },
            },
          }),
          card({ id: "archived", stage: group.id, archived }),
          card({
            id: "external",
            stage: group.id,
            archived: { ...archived, status: "external" },
          }),
          card({
            id: "uncertain",
            stage: group.id,
            archived: { ...archived, status: "uncertain" },
          }),
          card({ id: "other", stage: "todo" }),
        ],
        group,
      ).map((item) => item.id),
    ).toEqual(["direct", "conflict", "binding", "uncertain"]);
  });

  it("filters active cards by project, text and attention without exposing archived cards", () => {
    const cards = [
      card({ id: "match", activity: "attention" }),
      card({
        id: "archived",
        archived: {
          operationId: "op",
          status: "archived",
          kind: "automatic",
          stage: "done",
          group: null,
          startedAt: "2026-01-01T00:00:00Z",
          archivedAt: null,
          lastConversationAt: null,
          detail: "ok",
        },
      }),
      card({
        id: "pending",
        archived: {
          operationId: "op2",
          status: "pending",
          kind: "automatic",
          stage: "done",
          group: null,
          startedAt: "2026-01-01T00:00:00Z",
          archivedAt: null,
          lastConversationAt: null,
          detail: "checking",
        },
      }),
      card({ id: "other", projectId: null, projectName: "" }),
    ];
    expect(
      visibleCards(board(cards), "p1", "import", true).map((item) => item.id),
    ).toEqual(["match"]);
    expect(
      visibleCards(board(cards), "p1", "", false).map((item) => item.id),
    ).toContain("pending");
    expect(
      visibleCards(board(cards), "none", "", false).map((item) => item.id),
    ).toEqual(["other"]);
  });
  it("orders each stage by conversation or draft edit time, leaving workspaces without conversations last", () => {
    const cards = [
      card({
        id: "old",
        lastConversationAt: "2026-01-10T00:00:00Z",
        updatedAt: "2026-03-01T00:00:00Z",
      }),
      card({ id: "old-draft", workspaceId: null }),
      card({ id: "new", lastConversationAt: "2026-02-01T00:00:00Z" }),
      card({
        id: "recent-draft",
        workspaceId: null,
        updatedAt: "2026-01-20T00:00:00Z",
      }),
      card({
        id: "no-conversation",
        lastConversationAt: null,
        updatedAt: "2026-03-01T00:00:00Z",
      }),
      card({ id: "other-stage", stage: "done" }),
    ];
    const originalOrder = cards.map((item) => item.id);
    const sorted = cardsForStage(cards, "todo");
    expect(sorted.map((item) => item.id)).toEqual([
      "new",
      "recent-draft",
      "old",
      "old-draft",
      "no-conversation",
    ]);
    expect(cards.map((item) => item.id)).toEqual(originalOrder);
    cards[0].lastConversationAt = "2026-02-02T00:00:00Z";
    expect(cardsForStage(cards, "todo").map((item) => item.id)).toEqual([
      "old",
      "new",
      "recent-draft",
      "old-draft",
      "no-conversation",
    ]);
  });
  it("compares actual instants and keeps ties stable when snapshots arrive in a different order", () => {
    const cards = [
      card({ id: "b", lastConversationAt: "2026-02-01T08:00:00+08:00" }),
      card({ id: "a", lastConversationAt: "2026-02-01T00:00:00.000Z" }),
      card({ id: "newer", lastConversationAt: "2026-02-01T00:01:00Z" }),
    ];
    expect(cardsForStage(cards, "todo").map((item) => item.id)).toEqual([
      "newer",
      "a",
      "b",
    ]);
    expect(
      cardsForStage([...cards].reverse(), "todo").map((item) => item.id),
    ).toEqual(["newer", "a", "b"]);
  });
  it("keeps last-activity order even when cards have running agents", () => {
    const runningAgent = {
      id: "worker",
      title: "Worker",
      activity: "running" as const,
      archived: false,
    };
    const cards = [
      card({ id: "recent-idle", lastConversationAt: "2026-03-03T00:00:00Z" }),
      card({
        id: "running-older",
        lastConversationAt: "2026-03-01T00:00:00Z",
        activity: "waiting",
        agents: [
          { ...runningAgent, id: "waiting", activity: "waiting" },
          { ...runningAgent },
        ],
      }),
      card({
        id: "running-newer",
        lastConversationAt: "2026-03-02T00:00:00Z",
        activity: "running",
        agents: [{ ...runningAgent }],
      }),
      card({
        id: "archived-agent",
        lastConversationAt: "2026-03-04T00:00:00Z",
        agents: [{ ...runningAgent, archived: true }],
      }),
      card({
        id: "waiting-only",
        lastConversationAt: "2026-03-05T00:00:00Z",
        activity: "waiting",
        agents: [{ ...runningAgent, activity: "waiting" }],
      }),
      card({ id: "other-stage", stage: "in-progress", agents: [runningAgent] }),
    ];
    const timeOrder = [
      "waiting-only",
      "archived-agent",
      "recent-idle",
      "running-newer",
      "running-older",
    ];
    expect(cardsForStage(cards, "todo").map((item) => item.id)).toEqual(
      timeOrder,
    );
    cards[1].agents[1].activity = "idle";
    cards[2].agents[0].activity = "idle";
    cards[2].activity = "idle";
    expect(cardsForStage(cards, "todo").map((item) => item.id)).toEqual(
      timeOrder,
    );
  });
  it("maps a desktop drag release to its measured target column only", () => {
    const columns = {
      todo: { left: 0, right: 100 },
      "in-progress": { left: 110, right: 210 },
    };
    expect(
      stageAtX(155, columns, [
        "todo",
        "in-progress",
        "review",
        "done",
        "canceled",
      ]),
    ).toBe("in-progress");
    expect(stageAtX(105, columns, ["todo", "in-progress"])).toBe("todo");
  });
  it("keeps a requested move visible without replacing the server label snapshot", () => {
    const original = board([
      card({ id: "moving", stage: "todo", labels: ["task:todo"] }),
    ]);
    const projected = withOptimisticStages(
      original,
      new Map([["moving", "review" as const]]),
    );
    expect(projected.cards[0]).toMatchObject({
      stage: "review",
      labels: ["task:todo"],
    });
    expect(original.cards[0].stage).toBe("todo");
    expect(withOptimisticStages(original, new Map())).toBe(original);
  });
  it("previews linked tasks whose stage or archive eligibility changes under a new mapping", () => {
    const settings = {
      ...settingsSchema.parse({}),
      groupOrder: [],
      archiveDoneEnabled: true,
      archiveCanceledEnabled: true,
      pinInProgressWorkspaces: true,
      groups: DEFAULT_GROUPS.map((group) => ({ ...group, label: group.id })),
    };
    const cards = [
      card({
        labels: ["done"],
        managedLabels: ["task:todo"],
        lastStage: "todo",
        stage: "todo",
        conversationStatus: "known",
        conversationDisplayEvidence: "exact",
        conversationGateEvidence: "exact",
        conversationGateAt: "2025-01-01T00:00:00Z",
        lastConversationAt: "2025-01-01T00:00:00Z",
      }),
      card({ id: "draft", workspaceId: null, labels: ["done"] }),
      card({
        id: "unknown",
        stage: "done",
        labels: ["done"],
        conversationStatus: "unknown",
        lastConversationAt: "2025-01-01T00:00:00Z",
      }),
      card({
        id: "canceled",
        stage: "canceled",
        labels: ["canceled"],
        conversationStatus: "known",
        conversationDisplayEvidence: "exact",
        conversationGateEvidence: "exact",
        conversationGateAt: "2025-01-01T00:00:00Z",
        lastConversationAt: "2025-01-01T00:00:00Z",
      }),
    ];
    expect(
      mappingPreview(cards, settings, Date.parse("2026-02-01T00:00:00Z")),
    ).toMatchObject({ affected: 1, due: 2, dueDone: 1, dueCanceled: 1 });
  });
});

it("explains an unlabeled workspace's default occupancy separately from an explicit task", () => {
  const settings = settingsSchema.parse({
    groups: [
      ...DEFAULT_GROUPS,
      { id: "incoming", kind: "inbox", name: null, label: "task:incoming" },
    ],
    defaultStartGroup: "incoming",
  });
  const group = settings.groups.find((g) => g.id === "incoming")!;
  expect(
    groupDeleteReason(
      [card({ stage: "incoming", labels: [], managedLabels: [] })],
      settings.groups,
      group,
      settings,
    ),
  ).toBe("groupDefaultInUse");
  expect(
    groupDeleteReason(
      [
        card({
          stage: "incoming",
          labels: ["task:incoming"],
          managedLabels: ["task:incoming"],
        }),
      ],
      settings.groups,
      group,
      settings,
    ),
  ).toBe("groupDeleteNotEmpty");
  expect(
    groupDeleteReason([], settings.groups, group, {
      ...settings,
      defaultStartGroup: "inbox",
    }),
  ).toBeNull();
  expect(
    groupDeleteReason(
      [],
      DEFAULT_GROUPS,
      DEFAULT_GROUPS.find((g) => g.kind === "canceled")!,
    ),
  ).toBe("groupNeedsCanceled");
});

it("returns exactly the due candidates and proposed deadlines used by preview counts", () => {
  const old = "2026-01-01T00:00:00Z";
  const due = (id: string, kind = "done", overrides: Partial<Card> = {}) =>
    card({
      id,
      title: `Workspace ${id}`,
      stage: kind,
      labels: [`task:${kind}`],
      conversationGateEvidence: "exact",
      conversationGateAt: old,
      dueAt: "2099-01-01T00:00:00Z",
      ...overrides,
    });
  const pending = {
    operationId: "op",
    status: "pending" as const,
    kind: "automatic" as const,
    stage: "done",
    group: null,
    startedAt: old,
    archivedAt: null,
    lastConversationAt: old,
    detail: "Fixture archive",
  };
  const cards = [
    due("done"),
    due("canceled", "canceled", { conversationGateEvidence: "upper-bound" }),
    due("fresh", "done", { conversationGateAt: "2026-02-01T00:00:00Z" }),
    due("boundary", "done", { conversationGateAt: "2026-01-02T00:00:00Z" }),
    due("unknown", "done", { conversationGateEvidence: "unknown" }),
    due("draft", "done", { workspaceId: null }),
    due("restored", "done", { autoArchivePaused: true }),
    due("archiving", "done", { archived: pending }),
    due("archived", "done", { archived: { ...pending, status: "archived" } }),
    due("binding", "done", {
      binding: {
        operationId: "bind",
        workspaceId: "w",
        stage: "done",
        target: { kind: "existing", workspaceId: "w" },
      },
    }),
    due("conflict", "done", { labels: ["task:done", "task:canceled"] }),
  ];
  const settings = settingsSchema.parse({
    archiveDoneEnabled: true,
    archiveCanceledEnabled: true,
    archiveDoneAfterDays: 30,
    archiveCanceledAfterDays: 7,
  });
  const result = mappingPreview(
    cards,
    settings,
    Date.parse("2026-02-01T00:00:00Z"),
  );
  expect(
    result.candidates.map(({ card, kind, days, dueAt }) => ({
      id: card.id,
      kind,
      days,
      dueAt,
    })),
  ).toEqual([
    { id: "done", kind: "done", days: 30, dueAt: "2026-01-31T00:00:00.000Z" },
    {
      id: "canceled",
      kind: "canceled",
      days: 7,
      dueAt: "2026-01-08T00:00:00.000Z",
    },
  ]);
  expect(result).toMatchObject({ due: 2, dueDone: 1, dueCanceled: 1 });
  const disabled = mappingPreview(
    cards,
    { ...settings, archiveDoneEnabled: false },
    Date.parse("2026-02-01T00:00:00Z"),
  );
  expect(disabled.candidates.map(({ card }) => card.id)).toEqual(["canceled"]);
  expect(disabled).toMatchObject({ due: 1, dueDone: 0, dueCanceled: 1 });
  expect(mappingPreview([], settings, Date.now()).candidates).toEqual([]);
});

describe("children skipped for idle agents", () => {
  const unlisted = (
    recheckAt: string | null,
    reason = "child-enumeration-unavailable",
  ) =>
    card({
      conversationReason: reason as Card["conversationReason"],
      recheckAt,
      agents: [{ id: "a", title: "A", activity: "idle", archived: false }],
    });
  it("follows the server's scheduled-recheck state, not the agents' activity", () => {
    expect(childrenSkippedForIdle(unlisted("2026-08-01T00:00:00.000Z"))).toBe(
      true,
    );
    expect(childrenSkippedForIdle(unlisted(null))).toBe(false);
    expect(
      childrenSkippedForIdle(
        unlisted("2026-08-01T00:00:00.000Z", "replay-timestamp"),
      ),
    ).toBe(false);
  });
});

describe("board clock", () => {
  it("judges due dates by the server's clock, not the browser's alone", () => {
    const real = Date.now();
    expect(boardNow({})).toBeGreaterThanOrEqual(real);
    expect(boardNow({ clockOffsetMs: 3_600_000 })).toBeGreaterThanOrEqual(
      real + 3_600_000,
    );
  });
});
