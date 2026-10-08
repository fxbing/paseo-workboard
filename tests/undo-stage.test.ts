import { expect, it, vi } from "vitest";
import { settingsSchema } from "../shared/model";
import { mutationSchema } from "../shared/rpc";
import { fixture, observed, workspace } from "./fixtures";

it.each(["kind", "label", "deleted"])(
  "R01 refuses undo after the original group is %s, without native writes or archival",
  async (change) => {
    const test = fixture({
      settings: settingsSchema.parse({ autoArchive: true }),
    });
    test.inventory.workspaces.push(
      workspace("w", "Workspace", ["task:review"]),
    );
    test.inventory.agents.push({
      id: "a",
      workspaceId: "w",
      title: null,
      activity: "idle",
      updatedAt: "2026-08-01T00:00:00Z",
      lastUserMessageAt: "2026-08-01T00:00:00Z",
    });
    test.host.conversation = async () => observed("2026-08-01T00:00:00Z");
    test.host.safety = vi.fn(async () => null);
    await test.board.start();
    try {
      const before = test.board.snapshot();
      const original = before.cards[0];
      const group = before.settings.groups.find((g) => g.id === "review")!;
      const moved = await test.board.mutate({
        action: "stage",
        taskId: original.id,
        stage: "in-progress",
        expectedLabels: original.managedLabels,
      });
      const current = test.store.current.settings;
      await test.board.mutate({
        action: "settings",
        revision: test.store.current.revision,
        expectedSettings: current,
        settings: {
          ...current,
          groups: current.groups.flatMap((g) =>
            g.id !== group.id
              ? [g]
              : change === "deleted"
                ? []
                : [
                    {
                      ...g,
                      ...(change === "kind"
                        ? { kind: "done" as const }
                        : { label: "task:new-review" }),
                    },
                  ],
          ),
        },
      });
      vi.mocked(test.host.setLabel).mockClear();
      await expect(
        test.board.mutate(
          mutationSchema.parse({
            action: "stage",
            taskId: original.id,
            stage: group.id,
            expectedLabels: moved.cards[0].managedLabels,
            expectedUpdatedAt: moved.cards[0].updatedAt,
            expectedGroup: {
              id: group.id,
              kind: group.kind,
              label: group.label,
            },
          }),
        ),
      ).rejects.toThrow("stage-group-changed");
      await test.board.refresh();
      expect(test.board.snapshot().cards[0]).toMatchObject({
        stage: "in-progress",
        archived: null,
        conversationGateEvidence: "exact",
      });
      expect(test.host.setLabel).not.toHaveBeenCalled();
      expect(test.host.archive).not.toHaveBeenCalled();
    } finally {
      test.board.dispose();
    }
  },
);
it("R02 refuses draft undo when another client has moved it before polling", async () => {
  const test = fixture();
  await test.board.start();
  try {
    const created = await test.board.mutate({
      action: "create",
      title: "Draft",
      description: "",
      projectId: null,
    });
    const moved = await test.board.mutate({
      action: "stage",
      taskId: created.cards[0].id,
      stage: "canceled",
      expectedLabels: [],
    });
    const successful = moved.cards[0];
    await test.board.mutate({
      action: "stage",
      taskId: successful.id,
      stage: "inbox",
      expectedLabels: [],
    });
    const later = test.store.current.tasks[0];
    await expect(
      test.board.mutate(
        mutationSchema.parse({
          action: "stage",
          taskId: successful.id,
          stage: "todo",
          expectedLabels: [],
          expectedUpdatedAt: successful.updatedAt,
          expectedGroup: { id: "todo", kind: "todo", label: "task:todo" },
        }),
      ),
    ).rejects.toThrow("stage-task-changed");
    expect(test.store.current.tasks[0]).toEqual(later);
    expect(test.board.snapshot().cards[0].stage).toBe("inbox");
  } finally {
    test.board.dispose();
  }
});
it.each(["group", "task"])(
  "R01/R02 recheck %s after asynchronous native reads, before label writes",
  async (change) => {
    const test = fixture();
    test.inventory.workspaces.push(
      workspace("w", "Workspace", ["task:in-progress"]),
    );
    await test.board.start();
    try {
      const value = test.board.snapshot().cards[0];
      const expectedGroup = {
        id: "review",
        kind: "review",
        label: "task:review",
      };
      const read = test.host.workspace;
      test.host.workspace = vi.fn(async (id) => {
        const result = await read(id);
        await test.store.update((data) => {
          if (change === "group")
            data.settings.groups.find((g) => g.id === "review")!.kind = "done";
          else data.tasks[0].updatedAt = "2026-09-23T00:00:01.000Z";
        });
        return result;
      });
      await expect(
        test.board.mutate(
          mutationSchema.parse({
            action: "stage",
            taskId: value.id,
            stage: "review",
            expectedLabels: value.managedLabels,
            expectedUpdatedAt: value.updatedAt,
            expectedGroup,
          }),
        ),
      ).rejects.toThrow(
        change === "group" ? "stage-group-changed" : "stage-task-changed",
      );
      expect(test.host.setLabel).not.toHaveBeenCalled();
      expect(test.inventory.workspaces[0].labels).toEqual(["task:in-progress"]);
    } finally {
      test.board.dispose();
    }
  },
);

it("R04 retains the post-write expected-group check before another native operation", async () => {
  const test = fixture();
  test.inventory.workspaces.push(
    workspace("w", "Workspace", ["task:in-progress"]),
  );
  await test.board.start();
  try {
    const card = test.board.snapshot().cards[0];
    const write = test.host.setLabel;
    test.host.setLabel = vi.fn(async (id, name, color, assigned) => {
      const labels = await write(id, name, color, assigned);
      await test.store.update((data) => {
        data.settings.groups.find((g) => g.id === "review")!.kind = "done";
      });
      return labels;
    });
    await expect(
      test.board.mutate({
        action: "stage",
        taskId: card.id,
        stage: "review",
        expectedLabels: card.managedLabels,
        expectedUpdatedAt: card.updatedAt,
        expectedGroup: { id: "review", kind: "review", label: "task:review" },
      }),
    ).rejects.toThrow("stage-group-changed");
    expect(test.host.setLabel).toHaveBeenCalledTimes(1);
    expect(test.inventory.workspaces[0].labels).toEqual([
      "task:in-progress",
      "task:review",
    ]);
    expect(test.store.current.tasks[0].lastStage).toBe("in-progress");
    expect(test.store.current.tasks[0].updatedAt).toBe(card.updatedAt);
    expect(test.host.archive).not.toHaveBeenCalled();
  } finally {
    test.board.dispose();
  }
});
