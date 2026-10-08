import { expect, it } from "vitest";
import { newTask } from "../shared/model";
import { mutationSchema } from "../shared/rpc";
import { Workboard } from "../server/workboard";
import { Store } from "../server/store";
import { fixture, workspace } from "./fixtures";

async function merged(description = "Original notes") {
  const test = fixture({
    tasks: [
      {
        ...newTask("survivor", "Workspace", "2026-09-01T00:00:00Z"),
        workspaceId: "w",
        description,
      },
      {
        ...newTask("draft-one", "First", "2026-09-01T00:00:00Z"),
        description: "First plan",
      },
      {
        ...newTask("draft-two", "Second", "2026-09-01T00:00:00Z"),
        description: "Second plan",
      },
    ],
  });
  test.inventory.workspaces.push(workspace("w"));
  await test.board.start();
  for (const taskId of ["draft-one", "draft-two"])
    await test.board.mutate({
      action: "start",
      taskId,
      target: { kind: "existing", workspaceId: "w" },
    });
  return test;
}

it.each([
  ["draft-one", "draft-two", "Original notes"],
  ["draft-two", "draft-one", "Original notes"],
  ["draft-one", "draft-two", ""],
  ["draft-two", "draft-one", ""],
])(
  "detaches multiple merged drafts independently in order %s, %s",
  async (first, second, description) => {
    const test = await merged(description);
    try {
      const survivor = test.store.current.tasks[0];
      expect(survivor.mergedDrafts).toMatchObject([
        { draftId: "draft-one", title: "First", description: "First plan" },
        { draftId: "draft-two", title: "Second", description: "Second plan" },
      ]);
      for (const draftId of [first, second]) {
        const current = test.store.current.tasks.find(
          (t) => t.id === "survivor",
        )!;
        const input = mutationSchema.parse({
          action: "detach-draft",
          taskId: current.id,
          updatedAt: current.updatedAt,
          draftId,
        });
        await test.board.mutate(input);
        await expect(test.board.mutate(input)).rejects.toThrow(
          "detach-draft-stale",
        );
      }
      expect(
        test.store.current.tasks.find((t) => t.id === "survivor"),
      ).toMatchObject({ description, mergedDrafts: [] });
      expect(
        test.store.current.tasks.find((t) => t.id === "draft-one"),
      ).toMatchObject({
        workspaceId: null,
        title: "First",
        description: "First plan",
        draftStage: "todo",
        binding: null,
      });
      expect(
        test.store.current.tasks.find((t) => t.id === "draft-two"),
      ).toMatchObject({
        workspaceId: null,
        title: "Second",
        description: "Second plan",
      });
    } finally {
      test.board.dispose();
    }
  },
);

it.each(["edited", "ambiguous", "occupied-id", "archived", "external"])(
  "rejects detach for %s and preserves the record and all data",
  async (reason) => {
    const test = await merged();
    try {
      await test.store.update((data) => {
        const survivor = data.tasks.find((t) => t.id === "survivor")!;
        if (reason === "edited")
          survivor.description = "User rewrote everything";
        if (reason === "ambiguous")
          survivor.description += survivor.mergedDrafts[0].appendedText;
        if (reason === "occupied-id")
          data.tasks.push(
            newTask("draft-one", "Other task", "2026-09-01T00:00:00Z"),
          );
        if (reason === "archived" || reason === "external")
          survivor.archived = {
            operationId: "archive",
            status: reason === "external" ? "external" : "archived",
            kind: "automatic",
            stage: "done",
            group: null,
            startedAt: "2026-09-01T00:00:00Z",
            archivedAt: "2026-09-01T00:00:00Z",
            lastConversationAt: null,
            detail: "Archived",
          };
      });
      const before = structuredClone(test.store.current.tasks);
      const input = {
        action: "detach-draft" as const,
        taskId: "survivor",
        updatedAt: test.store.current.tasks[0].updatedAt,
        draftId: "draft-one",
      };
      await expect(
        test.board.mutate({ ...input, updatedAt: "stale" }),
      ).rejects.toThrow(
        reason === "archived" || reason === "external"
          ? "detach-draft-archived"
          : "detach-draft-stale",
      );
      await expect(test.board.mutate(input)).rejects.toThrow(
        reason === "archived" || reason === "external"
          ? "detach-draft-archived"
          : reason === "occupied-id"
            ? "detach-draft-id-in-use"
            : "detach-draft-text-changed",
      );
      expect(test.store.current.tasks).toEqual(before);
    } finally {
      test.board.dispose();
    }
  },
);

it("persists merge sources across restart and preserves notes edited outside the unique appended block", async () => {
  const test = await merged();
  test.board.dispose();
  const reopened = new Workboard(test.host, new Store(test.backing), test.now);
  try {
    await reopened.start();
    const survivor = reopened
      .snapshot()
      .cards.find((c) => c.id === "survivor")!;
    expect(survivor.mergedDrafts[0].mergedAt).toBe("2026-09-23T00:00:00.000Z");
    const edited = await reopened.mutate({
      action: "edit",
      taskId: survivor.id,
      updatedAt: survivor.updatedAt,
      title: survivor.title,
      projectId: survivor.projectId,
      description: survivor.description + "\nExtra notes",
    });
    const current = edited.cards.find((c) => c.id === "survivor")!;
    const result = await reopened.mutate({
      action: "detach-draft",
      taskId: current.id,
      updatedAt: current.updatedAt,
      draftId: "draft-one",
    });
    expect(result.cards.find((c) => c.id === "survivor")).toMatchObject({
      description: "Original notes\n\n[Second]\nSecond plan\nExtra notes",
      mergedDrafts: [expect.objectContaining({ draftId: "draft-two" })],
    });
    expect(result.cards.find((c) => c.id === "draft-one")).toMatchObject({
      workspaceId: null,
      title: "First",
      description: "First plan",
    });
  } finally {
    reopened.dispose();
  }
});

it.each(["identical", "cross-block"])(
  "rejects a %s source substring appearing twice, including overlapping matches, without losing any records",
  async (scenario) => {
    const test = fixture({
      tasks: [
        {
          ...newTask("survivor", "Workspace", "2026-09-01T00:00:00Z"),
          workspaceId: "w",
        },
        {
          ...newTask("one", "Same", "2026-09-01T00:00:00Z"),
          description: scenario === "identical" ? "Plan" : "x\n\n[Same]\nx",
        },
        {
          ...newTask("two", "Same", "2026-09-01T00:00:00Z"),
          description: scenario === "identical" ? "Plan" : "x",
        },
      ],
    });
    test.inventory.workspaces.push(workspace("w"));
    try {
      await test.board.start();
      for (const taskId of ["one", "two"])
        await test.board.mutate({
          action: "start",
          taskId,
          target: { kind: "existing", workspaceId: "w" },
        });
      const before = test.store.current.tasks;
      expect(before[0].mergedDrafts).toHaveLength(2);
      expect(before[0].description).toBe(
        scenario === "identical"
          ? "[Same]\nPlan\n\n[Same]\nPlan"
          : "[Same]\nx\n\n[Same]\nx\n\n[Same]\nx",
      );
      expect(before[0].mergedDrafts[0].appendedText).toBe(
        scenario === "identical" ? "[Same]\nPlan" : "[Same]\nx\n\n[Same]\nx",
      );
      await expect(
        test.board.mutate({
          action: "detach-draft",
          taskId: "survivor",
          draftId: "one",
          updatedAt: before[0].updatedAt,
        }),
      ).rejects.toThrow("detach-draft-text-changed");
      expect(test.store.current.tasks).toEqual(before);
    } finally {
      test.board.dispose();
    }
  },
);
