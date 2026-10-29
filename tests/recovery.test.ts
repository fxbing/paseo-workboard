import { expect, it, vi } from "vitest";
import { newTask, settingsSchema } from "../shared/model";
import { mutationSchema, CANCEL_BINDING_BUSY_ERROR_CODE } from "../shared/rpc";
import { Workboard } from "../server/workboard";
import { Store } from "../server/store";
import { agentEvidence, fixture, workspace } from "./fixtures";
import { visibleCards } from "../client/board-utils";

function archivedAutomatic() {
  const task = newTask("task", "Completed task", "2026-08-01T00:00:00Z");
  return {
    ...task,
    workspaceId: "w",
    lastStage: "done" as const,
    archived: {
      operationId: "archive-op",
      kind: "automatic" as const,
      status: "archived" as const,
      stage: "done",
      group: null,
      startedAt: task.createdAt,
      archivedAt: task.createdAt,
      lastConversationAt: task.createdAt,
      detail: "Archived",
    },
  };
}
const undoInput = (
  card: ReturnType<Workboard["snapshot"]>["cards"][number],
) => ({
  action: "undo-archive" as const,
  taskId: card.id,
  updatedAt: card.updatedAt,
  operationId: card.archived!.operationId,
});

it.each(["archived", "uncertain"] as const)(
  "restores an %s native workspace and persists the pause until a different group is observed",
  async (status) => {
    const task = archivedAutomatic();
    const test = fixture({
      tasks: [{ ...task, archived: { ...task.archived, status } }],
      settings: settingsSchema.parse({
        archiveDoneEnabled: true,
        exclusiveStatusLabels: false,
      }),
    });
    test.host.restore = vi.fn(async () => {
      expect(test.store.current.tasks[0]).toMatchObject({
        autoArchivePaused: true,
        archived: { undo: "pending" },
      });
      test.inventory.workspaces.push(
        workspace("w", "Completed task", ["task:done"]),
      );
    });
    await test.board.start();
    try {
      const before = test.board.snapshot().cards[0];
      const pending = await test.board.mutate(undoInput(before));
      expect(pending.cards[0].archived?.undo).toBe("pending");
      await test.board.refresh();
      const restored = test.board.snapshot();
      expect(restored.cards[0]).toMatchObject({
        archived: null,
        autoArchivePaused: true,
        stage: "done",
        dueAt: null,
        recheckAt: null,
      });
      expect(test.host.restore).toHaveBeenCalledOnce();
      await expect(test.board.mutate(undoInput(before))).rejects.toThrow(
        "archive-resolution-stale",
      );
      const reopened = new Workboard(
        test.host,
        new Store(test.backing),
        test.now,
      );
      try {
        await reopened.start();
        expect(reopened.snapshot().cards[0].autoArchivePaused).toBe(true);
        await reopened.refresh();
        expect(test.host.archive).not.toHaveBeenCalled();
        test.inventory.workspaces[0].labels = ["task:done", "task:review"];
        await reopened.refresh();
        // A conflict resolved back to the same group must not resume automatic archive.
        test.inventory.workspaces[0].labels = ["task:done"];
        await reopened.refresh();
        expect(reopened.snapshot().cards[0].autoArchivePaused).toBe(true);
        const card = reopened.snapshot().cards[0];
        await reopened.mutate({
          action: "stage",
          taskId: card.id,
          stage: "review",
          expectedLabels: card.managedLabels,
        });
        expect(reopened.snapshot().cards[0].autoArchivePaused).toBeUndefined();
      } finally {
        reopened.dispose();
      }
    } finally {
      test.board.dispose();
    }
  },
);

it.each([false, true])(
  "undoes an uncertain archive only when the native workspace is active and not archiving (%s)",
  async (archiving) => {
    const task = archivedAutomatic();
    const test = fixture({
      tasks: [{ ...task, archived: { ...task.archived, status: "uncertain" } }],
      settings: settingsSchema.parse({ archiveDoneEnabled: true }),
    });
    test.inventory.workspaces.push({
      ...workspace("w", "Completed task", ["task:done"]),
      archivingAt: archiving ? task.createdAt : null,
    });
    await test.board.start();
    try {
      const undo = test.board.mutate(undoInput(test.board.snapshot().cards[0]));
      if (archiving) {
        await expect(undo).rejects.toThrow("archive-undo-unknown");
        expect(test.store.current.tasks[0].archived).toMatchObject({
          status: "uncertain",
        });
        expect(test.store.current.tasks[0].archived?.undo).toBeUndefined();
      } else {
        await undo;
        await test.board.refresh();
        expect(test.board.snapshot().cards[0]).toMatchObject({
          archived: null,
          autoArchivePaused: true,
          dueAt: null,
        });
      }
      expect(test.host.checkRestore).not.toHaveBeenCalled();
      expect(test.host.restore).not.toHaveBeenCalled();
    } finally {
      test.board.dispose();
    }
  },
);

it("keeps a lost restore response durable and verifies it after restart without resending", async () => {
  const test = fixture({ tasks: [archivedAutomatic()] });
  test.host.restore = vi.fn(async () => {
    throw new Error("Restore response lost");
  });
  await test.board.start();
  try {
    await test.board.mutate(undoInput(test.board.snapshot().cards[0]));
    await test.board.refresh();
    expect(test.store.current.tasks[0].archived).toMatchObject({
      undo: "uncertain",
    });
    const reopened = new Workboard(
      test.host,
      new Store(test.backing),
      test.now,
    );
    try {
      await reopened.start();
      await expect(
        reopened.mutate(undoInput(reopened.snapshot().cards[0])),
      ).rejects.toThrow("archive-undo-unknown");
      test.inventory.workspaces.push(
        workspace("w", "Completed task", ["task:done"]),
      );
      const restored = await reopened.mutate(
        undoInput(reopened.snapshot().cards[0]),
      );
      expect(restored.cards[0]).toMatchObject({
        archived: null,
        autoArchivePaused: true,
      });
      expect(test.host.restore).toHaveBeenCalledOnce();
    } finally {
      reopened.dispose();
    }
  } finally {
    test.board.dispose();
  }
});
it("turns an interrupted recovery into verification-only state after restart", async () => {
  const task = archivedAutomatic();
  const test = fixture({
    tasks: [
      {
        ...task,
        autoArchivePaused: true,
        archived: { ...task.archived, undo: "pending" },
      },
    ],
  });
  await test.board.start();
  try {
    expect(test.board.snapshot().cards[0].archived?.undo).toBe("uncertain");
    test.inventory.workspaces.push({
      ...workspace("w"),
      archivingAt: test.now().toString(),
    });
    await expect(
      test.board.mutate(undoInput(test.board.snapshot().cards[0])),
    ).rejects.toThrow("archive-undo-unknown");
    expect(test.host.restore).not.toHaveBeenCalled();
    expect(test.store.current.tasks[0].archived?.undo).toBe("uncertain");
  } finally {
    test.board.dispose();
  }
});
it("returns a durable pending reply before slow native recovery and refuses duplicate writes", async () => {
  const test = fixture({ tasks: [archivedAutomatic()] });
  let finish!: () => void;
  test.host.restore = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await test.board.start();
  try {
    const pending = await test.board.mutate(
      undoInput(test.board.snapshot().cards[0]),
    );
    expect(pending.cards[0].archived?.undo).toBe("pending");
    await expect(
      test.board.mutate(undoInput(pending.cards[0])),
    ).rejects.toThrow("archive-undo-pending");
    expect(test.board.snapshot().cards[0].archived?.undo).toBe("pending");
    test.inventory.workspaces.push(
      workspace("w", "Completed task", ["task:done"]),
    );
    finish();
    await test.board.refresh();
    expect(test.board.snapshot().cards[0].archived).toBeNull();
    expect(test.host.restore).toHaveBeenCalledOnce();
  } finally {
    finish?.();
    test.board.dispose();
  }
});

it("rejects competing mutations while native recovery inspection is still in flight", async () => {
  const test = fixture({ tasks: [archivedAutomatic()] });
  let release!: () => void;
  let started!: () => void;
  const inspecting = new Promise<void>((resolve) => {
    started = resolve;
  });
  test.host.checkRestore = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
        started();
      }),
  );
  test.host.restore = vi.fn(async () => {
    test.inventory.workspaces.push(
      workspace("w", "Completed task", ["task:done"]),
    );
  });
  await test.board.start();
  const undo = test.board.mutate(undoInput(test.board.snapshot().cards[0]));
  try {
    await inspecting;
    await expect(
      test.board.mutate({
        action: "create",
        title: "Do not queue",
        description: "",
        projectId: null,
      }),
    ).rejects.toThrow("archive-undo-pending");
    release();
    await undo;
    await test.board.refresh();
    expect(test.board.snapshot().cards).toHaveLength(1);
  } finally {
    release?.();
    await undo;
    test.board.dispose();
  }
});
it("does not restore when the native preflight or durable intent write fails", async () => {
  for (const failure of ["preflight", "storage"] as const) {
    const test = fixture({ tasks: [archivedAutomatic()] });
    await test.board.start();
    try {
      if (failure === "preflight")
        test.host.checkRestore = vi.fn(async () => {
          throw new Error("Missing directory");
        });
      else
        test.backing.write = async () => {
          throw new Error("Storage unavailable");
        };
      await expect(
        test.board.mutate(undoInput(test.board.snapshot().cards[0])),
      ).rejects.toThrow();
      expect(test.host.restore).not.toHaveBeenCalled();
      expect(test.store.current.tasks[0].archived?.operationId).toBe(
        "archive-op",
      );
    } finally {
      test.board.dispose();
    }
  }
});
it("keeps an unknown automatic archive when native confirmation fails and rejects record-only restoration", async () => {
  const task = archivedAutomatic();
  const test = fixture({
    tasks: [
      {
        ...task,
        archived: { ...task.archived, status: "uncertain", archivedAt: null },
      },
    ],
  });
  await test.board.start();
  try {
    test.host.checkRestore = vi.fn(async () => {
      throw new Error("Not archived");
    });
    const card = test.board.snapshot().cards[0];
    for (const outcome of ["confirm", "restore"] as const) {
      await expect(
        test.board.mutate({
          action: "resolve-archive",
          taskId: card.id,
          updatedAt: card.updatedAt,
          operationId: card.archived!.operationId,
          outcome,
        }),
      ).rejects.toThrow();
      expect(test.store.current.tasks[0].archived?.status).toBe("uncertain");
    }
  } finally {
    test.board.dispose();
  }
});

it.each(["external"] as const)(
  "resolves %s archives with stale-write protection and durable manual restoration",
  async (status) => {
    for (const outcome of ["confirm", "restore"] as const) {
      const archived = {
        operationId: "archive-op",
        kind: "external" as const,
        status,
        stage: "done",
        group: null,
        startedAt: "2026-08-01T00:00:00Z",
        archivedAt: null,
        lastConversationAt: "2026-08-01T00:00:00Z",
        detail: "unknown",
      };
      const test = fixture({
        settings: settingsSchema.parse({
          archiveDoneEnabled: true,
          archiveCanceledEnabled: true,
        }),
        tasks: [
          {
            ...newTask("task", "Task", "2026-08-01T00:00:00Z"),
            workspaceId: "w",
            lastStage: "done",
            conversationGateAt: "2026-08-01T00:00:00Z",
            conversationGateEvidence: "exact",
            archived,
          },
        ],
      });
      await test.board.start();
      try {
        const card = test.board.snapshot().cards[0];
        await expect(
          test.board.mutate({
            action: "resolve-archive",
            operationId: archived.operationId,
            taskId: card.id,
            updatedAt: "stale",
            outcome,
          }),
        ).rejects.toThrow("archive-resolution-stale");
        expect(test.store.current.tasks[0].archived).toEqual(archived);
        const input = mutationSchema.parse({
          action: "resolve-archive",
          operationId: archived.operationId,
          taskId: card.id,
          updatedAt: card.updatedAt,
          outcome,
        });
        const result = await test.board.mutate(input);
        if (outcome === "confirm") {
          expect(result.cards[0].archived).toEqual({
            ...archived,
            status: "archived",
            detail: "archive-confirmed-by-user",
          });
        } else {
          expect(result.cards[0]).toMatchObject({
            archived: null,
            stage: "done",
            workspaceId: "w",
            issue: "archive-restored-workspace-unavailable",
          });
        }
        await expect(test.board.mutate(input)).rejects.toThrow(
          "archive-resolution-stale",
        );
        await test.board.refresh();
        expect(test.board.snapshot().cards[0].archived?.status ?? null).toBe(
          outcome === "confirm" ? "archived" : null,
        );
        const reopened = new Workboard(
          test.host,
          new Store(test.backing),
          test.now,
        );
        try {
          await reopened.start();
          expect(reopened.snapshot().cards[0].archived?.status ?? null).toBe(
            outcome === "confirm" ? "archived" : null,
          );
        } finally {
          reopened.dispose();
        }
        expect(test.host.archive).not.toHaveBeenCalled();
        expect(test.host.setLabel).not.toHaveBeenCalled();
      } finally {
        test.board.dispose();
      }
    }
  },
);

it.each(["create", "transition"])(
  "cancels a failed %s binding only for its expected operation",
  async (failure) => {
    const test = fixture();
    await test.board.start();
    try {
      const card = (
        await test.board.mutate({
          action: "create",
          title: "Task",
          description: "Notes",
          projectId: null,
        })
      ).cards[0];
      if (failure === "create")
        vi.mocked(test.host.create).mockRejectedValueOnce(
          new Error("Create failed"),
        );
      else
        vi.mocked(test.host.setLabel).mockRejectedValueOnce(
          new Error("Labels failed"),
        );
      await expect(
        test.board.mutate({
          action: "start",
          taskId: card.id,
          target: {
            kind: "new",
            source: { kind: "directory", path: "/fixture" },
          },
        }),
      ).rejects.toThrow("failed");
      const pending = test.board.snapshot().cards[0];
      const operationId = pending.binding!.operationId;
      await expect(
        test.board.mutate({
          action: "cancel-binding",
          taskId: card.id,
          operationId: "stale",
        }),
      ).rejects.toThrow("cancel-binding-changed");
      expect(test.store.current.tasks[0].binding!.operationId).toBe(
        operationId,
      );
      const result = await test.board.mutate(
        mutationSchema.parse({
          action: "cancel-binding",
          taskId: card.id,
          operationId,
        }),
      );
      expect(result.cards[0]).toMatchObject({
        binding: null,
        description: "Notes",
        workspaceId: failure === "create" ? null : "w1",
      });
      if (failure === "create") {
        const started = await test.board.mutate({
          action: "start",
          taskId: card.id,
          target: {
            kind: "new",
            source: { kind: "directory", path: "/other" },
          },
        });
        expect(started.cards[0]).toMatchObject({
          binding: null,
          stage: "in-progress",
        });
      } else {
        const moved = await test.board.mutate({
          action: "stage",
          taskId: card.id,
          stage: "review",
          expectedLabels: [],
        });
        expect(moved.cards[0]).toMatchObject({
          binding: null,
          stage: "review",
        });
        expect(test.inventory.workspaces).toHaveLength(1);
      }
    } finally {
      test.board.dispose();
    }
  },
);

it("rejects cancellation while a retry is queued or actively creating, then allows it after failure", async () => {
  const test = fixture();
  await test.board.start();
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    const card = (
      await test.board.mutate({
        action: "create",
        title: "Task",
        description: "",
        projectId: null,
      })
    ).cards[0];
    const input = {
      action: "start" as const,
      taskId: card.id,
      target: {
        kind: "new" as const,
        source: { kind: "directory" as const, path: "/fixture" },
      },
    };
    vi.mocked(test.host.create).mockRejectedValueOnce(new Error("Failed"));
    await expect(test.board.mutate(input)).rejects.toThrow("Failed");
    const operationId = test.board.snapshot().cards[0].binding!.operationId;
    vi.mocked(test.host.create).mockImplementationOnce(async () => {
      entered();
      await blocked;
      throw new Error("Failed again");
    });
    const retry = test.board.mutate(input);
    const failed = expect(retry).rejects.toThrow("Failed again");
    const cancel = {
      action: "cancel-binding" as const,
      taskId: card.id,
      operationId,
    };
    await expect(test.board.mutate(cancel)).rejects.toThrow(
      CANCEL_BINDING_BUSY_ERROR_CODE,
    );
    await reading;
    await expect(test.board.mutate(cancel)).rejects.toThrow(
      CANCEL_BINDING_BUSY_ERROR_CODE,
    );
    release();
    await failed;
    expect((await test.board.mutate(cancel)).cards[0].binding).toBeNull();
  } finally {
    release?.();
    test.board.dispose();
  }
});

it("rejects cancellation of a binding being resumed during startup", async () => {
  const binding = {
    operationId: "binding-op",
    target: { kind: "existing" as const, workspaceId: "w" },
    workspaceId: "w",
    stage: "in-progress",
  };
  const test = fixture({
    tasks: [
      {
        ...newTask("task", "Task", "2026-08-01T00:00:00Z"),
        workspaceId: "w",
        binding,
      },
    ],
  });
  test.inventory.workspaces.push(workspace("w"));
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.mocked(test.host.setLabel).mockImplementationOnce(async () => {
    entered();
    await blocked;
    throw new Error("Failed");
  });
  const start = test.board.start();
  try {
    await reading;
    await expect(
      test.board.mutate({
        action: "cancel-binding",
        taskId: "task",
        operationId: binding.operationId,
      }),
    ).rejects.toThrow(CANCEL_BINDING_BUSY_ERROR_CODE);
    release();
    await start;
    expect(
      (
        await test.board.mutate({
          action: "cancel-binding",
          taskId: "task",
          operationId: binding.operationId,
        })
      ).cards[0].binding,
    ).toBeNull();
  } finally {
    release();
    await start;
    test.board.dispose();
  }
});

it("rejects a replaced archive operation even when the task timestamp is unchanged", async () => {
  const test = fixture({
    tasks: [
      {
        ...newTask("task", "Task", "2026-08-01T00:00:00Z"),
        workspaceId: "w",
        lastStage: "done",
        archived: {
          operationId: "current",
          kind: "external",
          status: "external",
          stage: "done",
          group: null,
          startedAt: "2026-08-01T00:00:00Z",
          archivedAt: null,
          lastConversationAt: null,
          detail: "Unknown",
        },
      },
    ],
  });
  await test.board.start();
  try {
    await expect(
      test.board.mutate({
        action: "resolve-archive",
        taskId: "task",
        updatedAt: test.board.snapshot().cards[0].updatedAt,
        operationId: "stale",
        outcome: "restore",
      }),
    ).rejects.toThrow("archive-resolution-stale");
    expect(test.store.current.tasks[0].archived?.operationId).toBe("current");
  } finally {
    test.board.dispose();
  }
});

it("retains an unresolved archive if its original group was deleted", async () => {
  const test = fixture({
    tasks: [
      {
        ...newTask("task", "Task", "2026-08-01T00:00:00Z"),
        workspaceId: "w",
        lastStage: "removed",
        archived: {
          operationId: "current",
          kind: "external",
          status: "external",
          stage: "removed",
          group: null,
          startedAt: "2026-08-01T00:00:00Z",
          archivedAt: null,
          lastConversationAt: null,
          detail: "Unknown",
        },
      },
    ],
  });
  await test.board.start();
  try {
    const input = {
      action: "resolve-archive" as const,
      taskId: "task",
      updatedAt: test.board.snapshot().cards[0].updatedAt,
      operationId: "current",
      outcome: "restore" as const,
    };
    await expect(test.board.mutate(input)).rejects.toThrow(
      "archive-group-unavailable",
    );
    expect(test.store.current.tasks[0].archived?.status).toBe("external");
    expect(
      (await test.board.mutate({ ...input, outcome: "confirm" })).cards[0]
        .archived?.status,
    ).toBe("archived");
  } finally {
    test.board.dispose();
  }
});

it("keeps a restored task on the board when native archive removed the workspace but its response was lost", async () => {
  const test = fixture({
    settings: settingsSchema.parse({
      archiveDoneEnabled: true,
      archiveCanceledEnabled: true,
    }),
  });
  test.inventory.workspaces.push(workspace("old", "Old task", ["task:done"]));
  test.inventory.agents.push({
    id: "agent",
    workspaceId: "old",
    title: null,
    activity: "idle",
    updatedAt: "2026-08-01T00:00:00Z",
    lastUserMessageAt: "2026-08-01T00:00:00Z",
  });
  test.host.conversation = agentEvidence("2026-08-01T00:00:00Z");
  test.host.archive = vi.fn(async (id) => {
    test.inventory.workspaces = test.inventory.workspaces.filter(
      (w) => w.id !== id,
    );
    throw new Error("Archive response lost");
  });
  try {
    await test.board.start();
    const card = test.board.snapshot().cards[0];
    expect(card.archived?.status).toBe("uncertain");
    expect(test.inventory.workspaces).toEqual([]);
    await test.board.mutate({
      action: "resolve-archive",
      taskId: card.id,
      operationId: card.archived!.operationId,
      updatedAt: card.updatedAt,
      outcome: "confirm",
    });
    test.host.restore = vi.fn(async () => {
      test.inventory.workspaces.push(
        workspace("old", "Old task", ["task:done"]),
      );
    });
    await test.board.mutate(undoInput(test.board.snapshot().cards[0]));
    await test.board.refresh();
    const restored = test.board.snapshot();
    expect(restored.cards[0].archived).toBeNull();
    expect(restored.cards[0]).toMatchObject({
      stage: "done",
      issue: null,
      autoArchivePaused: true,
    });
    expect(
      visibleCards(restored, "all", "", false).map((task) => task.id),
    ).toEqual([card.id]);
    expect(test.store.current.tasks[0].archived).toBeNull();
    test.inventory.workspaces[0].labels = ["task:review"];
    await test.board.refresh();
    expect(test.board.snapshot().cards[0]).toMatchObject({
      archived: null,
      stage: "review",
      issue: null,
    });
    expect(test.host.archive).toHaveBeenCalledTimes(1);
  } finally {
    test.board.dispose();
  }
});

it("clears startup reservations for a binding overwritten by a workspace merge", async () => {
  const target = { kind: "existing" as const, workspaceId: "w" };
  const test = fixture({
    tasks: [
      {
        ...newTask("draft", "Draft", "2026-08-01T00:00:00Z"),
        description: "Plan",
        binding: {
          operationId: "draft-binding",
          target,
          workspaceId: null,
          stage: "in-progress",
        },
      },
      {
        ...newTask("imported", "Imported", "2026-08-01T00:00:00Z"),
        workspaceId: "w",
        binding: {
          operationId: "overwritten-binding",
          target,
          workspaceId: "w",
          stage: "in-progress",
        },
      },
    ],
  });
  test.inventory.workspaces.push(workspace("w"));
  try {
    await test.board.start();
    expect(test.board.snapshot().cards).toMatchObject([
      { id: "imported", workspaceId: "w", binding: null },
    ]);
    expect(test.board.snapshot().cards).toHaveLength(1);
    expect(test.store.current.tasks[0].description).toContain("Plan");
    await expect(
      test.board.mutate({
        action: "cancel-binding",
        taskId: "imported",
        operationId: "overwritten-binding",
      }),
    ).rejects.toThrow("cancel-binding-missing");
  } finally {
    test.board.dispose();
  }
});

it.each(["done", "canceled"])(
  "reconciles a native restoration into %s and pauses automatic archive",
  async (stage) => {
    const test = fixture({
      tasks: [archivedAutomatic()],
      settings: settingsSchema.parse({
        archiveDoneEnabled: true,
        archiveCanceledEnabled: true,
      }),
    });
    await test.board.start();
    try {
      const stale = undoInput(test.board.snapshot().cards[0]);
      test.inventory.workspaces.push(
        workspace("w", "Restored", [`task:${stage}`]),
      );
      test.inventory.agents.push({
        id: "a",
        workspaceId: "w",
        title: null,
        updatedAt: "2026-08-01T00:00:00Z",
        lastUserMessageAt: "2026-08-01T00:00:00Z",
        activity: "idle",
      });
      test.host.conversation = agentEvidence("2026-08-01T00:00:00Z");
      await test.board.refresh();
      expect(test.board.snapshot().cards[0]).toMatchObject({
        archived: null,
        autoArchivePaused: true,
        stage,
        dueAt: null,
      });
      await expect(test.board.mutate(stale)).rejects.toThrow(
        "archive-resolution-stale",
      );
      await test.board.refresh();
      expect(test.host.archive).not.toHaveBeenCalled();
      const reopened = new Workboard(
        test.host,
        new Store(test.backing),
        test.now,
      );
      try {
        await reopened.start();
        expect(reopened.snapshot().cards[0].autoArchivePaused).toBe(true);
        expect(test.host.archive).not.toHaveBeenCalled();
        test.inventory.workspaces[0].labels = ["task:review"];
        await reopened.refresh();
        expect(reopened.snapshot().cards[0].autoArchivePaused).toBeUndefined();
      } finally {
        reopened.dispose();
      }
    } finally {
      test.board.dispose();
    }
  },
);

it("undoes a completed archive already restored natively before refresh without a restore preflight", async () => {
  const test = fixture({ tasks: [archivedAutomatic()] });
  await test.board.start();
  try {
    test.inventory.workspaces.push(workspace("w", "Restored", ["task:done"]));
    test.host.checkRestore = vi.fn(async () => {
      throw new Error("archive-recovery-unavailable");
    });
    await test.board.mutate(undoInput(test.board.snapshot().cards[0]));
    expect(test.board.snapshot().cards[0]).toMatchObject({
      archived: null,
      autoArchivePaused: true,
    });
    expect(test.host.checkRestore).not.toHaveBeenCalled();
    expect(test.host.restore).not.toHaveBeenCalled();
  } finally {
    test.board.dispose();
  }
});

it.each([
  "archiving",
  "pending",
  "uncertain",
  "undo-pending",
  "undo-uncertain",
] as const)(
  "retains %s archive state when the workspace is active",
  async (state) => {
    const test = fixture({ tasks: [archivedAutomatic()] });
    await test.board.start();
    try {
      await test.store.update((data) => {
        const archive = data.tasks[0].archived!;
        if (state === "pending" || state === "uncertain")
          archive.status = state;
        if (state === "undo-pending") archive.undo = "pending";
        if (state === "undo-uncertain") archive.undo = "uncertain";
      });
      const before = structuredClone(test.store.current.tasks[0].archived);
      test.inventory.workspaces.push({
        ...workspace("w", "Restored", ["task:done"]),
        archivingAt: state === "archiving" ? "2026-09-23T00:00:00Z" : null,
      });
      await test.board.refresh();
      expect(test.store.current.tasks[0].archived).toEqual(before);
      expect(test.host.restore).not.toHaveBeenCalled();
    } finally {
      test.board.dispose();
    }
  },
);
