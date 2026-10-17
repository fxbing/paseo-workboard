import { expect, it, vi } from "vitest";
import {
  DEFAULT_GROUPS,
  defaultReviewGroup,
  resolveStage,
  settingsSchema,
} from "../shared/model";
import { fixture, workspace } from "./fixtures";

function reviewFixture(
  settings: Partial<ReturnType<typeof settingsSchema.parse>> = {},
) {
  const test = fixture({
    settings: settingsSchema.parse({
      autoMoveInProgressToReview: true,
      ...settings,
    }),
  });
  test.inventory.workspaces.push(workspace("w", "Work", ["task:in-progress"]));
  test.inventory.agents.push({
    id: "agent",
    workspaceId: "w",
    title: null,
    updatedAt: "2026-09-23T00:00:00Z",
    lastUserMessageAt: null,
    activity: "idle",
  });
  return test;
}

it("keeps review automation opt-in and resolves a Review destination", () => {
  const settings = settingsSchema.parse({});
  expect(settings.autoMoveInProgressToReview).toBe(false);
  expect(settings.defaultReviewGroup).toBeNull();
  expect(defaultReviewGroup(DEFAULT_GROUPS, null)).toBe("review");
  expect(defaultReviewGroup(DEFAULT_GROUPS, "missing")).toBe("review");
  expect(
    defaultReviewGroup(
      DEFAULT_GROUPS.filter((group) => group.kind !== "review"),
      null,
    ),
  ).toBeUndefined();
});

it("moves an In progress workspace to Review after a successful turn event", async () => {
  const test = reviewFixture();
  try {
    await test.board.start();
    expect(test.board.snapshot().cards[0].stage).toBe("in-progress");

    test.turnCompletions.add("w");
    await test.board.refresh();

    expect(test.host.setLabel).toHaveBeenCalledWith(
      "w",
      "task:review",
      "orange",
      true,
    );
    expect(test.board.snapshot().cards[0].stage).toBe("review");
  } finally {
    test.board.dispose();
  }
});

it("does not move idle history merely because the setting or daemon starts", async () => {
  const test = reviewFixture();
  try {
    await test.board.start();
    await test.board.refresh();
    expect(test.board.snapshot().cards[0].stage).toBe("in-progress");
    expect(test.host.setLabel).not.toHaveBeenCalled();
  } finally {
    test.board.dispose();
  }
});

it.each(["running", "waiting", "error"] as const)(
  "does not move while any Agent is %s",
  async (activity) => {
    const test = reviewFixture();
    test.inventory.agents[0].activity = activity;
    try {
      await test.board.start();
      test.turnCompletions.add("w");
      await test.board.refresh();
      expect(test.board.snapshot().cards[0].stage).toBe("in-progress");
      expect(test.host.setLabel).not.toHaveBeenCalled();
    } finally {
      test.board.dispose();
    }
  },
);

it("waits for an active Agent and moves after it settles without another completion event", async () => {
  const test = reviewFixture();
  test.inventory.agents[0].activity = "running";
  try {
    await test.board.start();
    test.turnCompletions.add("w");
    await test.board.refresh();
    expect(test.board.snapshot().cards[0].stage).toBe("in-progress");

    test.inventory.agents[0].activity = "idle";
    await test.board.refresh();
    expect(test.board.snapshot().cards[0].stage).toBe("review");
  } finally {
    test.board.dispose();
  }
});

it("does not replay a completion after the switch is enabled later", async () => {
  const test = reviewFixture({ autoMoveInProgressToReview: false });
  try {
    await test.board.start();
    test.turnCompletions.add("w");
    await test.board.refresh();
    await test.board.mutate({
      action: "settings",
      revision: test.store.current.revision,
      expectedSettings: test.store.current.settings,
      settings: {
        ...test.store.current.settings,
        autoMoveInProgressToReview: true,
      },
    });
    expect(test.board.snapshot().cards[0].stage).toBe("in-progress");
    expect(test.host.setLabel).not.toHaveBeenCalled();
  } finally {
    test.board.dispose();
  }
});

it("uses a configured Review group and ignores ambiguous workspace labels", async () => {
  const review = {
    id: "acceptance",
    kind: "review" as const,
    name: "Acceptance",
    label: "task:acceptance",
  };
  const test = reviewFixture({
    defaultReviewGroup: review.id,
    groups: [...DEFAULT_GROUPS, review],
  });
  try {
    await test.board.start();
    test.turnCompletions.add("w");
    await test.board.refresh();
    expect(test.board.snapshot().cards[0].stage).toBe("acceptance");

    const labelWrites = vi.mocked(test.host.setLabel).mock.calls.length;
    test.inventory.workspaces[0].labels = ["task:in-progress", "task:review"];
    test.turnCompletions.add("w");
    await test.board.refresh();
    const card = test.board.snapshot().cards[0];
    expect(resolveStage(card.labels, test.store.current.settings.groups)).toBe(
      "conflict",
    );
    expect(card.stage).toBe("conflict");
    expect(vi.mocked(test.host.setLabel)).toHaveBeenCalledTimes(labelWrites);
  } finally {
    test.board.dispose();
  }
});

it("marks a failed automatic label transition without guessing a new state", async () => {
  const test = reviewFixture();
  test.host.setLabel = vi.fn(async () => {
    throw new Error("Fixture label failure");
  });
  try {
    await test.board.start();
    test.turnCompletions.add("w");
    await test.board.refresh();
    expect(test.board.snapshot().cards[0]).toMatchObject({
      stage: "in-progress",
      issue: "auto-review-failed",
    });
  } finally {
    test.board.dispose();
  }
});

it("refuses a non-Review automatic destination", async () => {
  const test = fixture();
  try {
    await test.board.start();
    await expect(
      test.board.mutate({
        action: "settings",
        revision: test.store.current.revision,
        expectedSettings: test.store.current.settings,
        settings: {
          ...test.store.current.settings,
          defaultReviewGroup: "done",
        },
      }),
    ).rejects.toThrow("group-default-review-invalid");
  } finally {
    test.board.dispose();
  }
});

it("protects a selected Review destination from deletion", async () => {
  const review = {
    id: "acceptance",
    kind: "review" as const,
    name: "Acceptance",
    label: "task:acceptance",
  };
  const groups = [...DEFAULT_GROUPS, review];
  const test = fixture({
    settings: settingsSchema.parse({
      groups,
      defaultReviewGroup: review.id,
    }),
  });
  try {
    await test.board.start();
    await expect(
      test.board.mutate({
        action: "settings",
        revision: test.store.current.revision,
        expectedSettings: test.store.current.settings,
        settings: {
          ...test.store.current.settings,
          groups: DEFAULT_GROUPS,
        },
      }),
    ).rejects.toThrow("group-default-in-use");
  } finally {
    test.board.dispose();
  }
});

it("leaves the task in progress when no Review group exists", async () => {
  const test = reviewFixture({
    groups: DEFAULT_GROUPS.filter((group) => group.kind !== "review"),
  });
  try {
    await test.board.start();
    test.turnCompletions.add("w");
    await test.board.refresh();
    expect(test.board.snapshot().cards[0].stage).toBe("in-progress");
    expect(test.host.setLabel).not.toHaveBeenCalled();
  } finally {
    test.board.dispose();
  }
});
