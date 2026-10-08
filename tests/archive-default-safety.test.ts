import { expect, it, vi } from "vitest";
import {
  DEFAULT_GROUPS,
  defaultWorkspaceGroup,
  settingsSchema,
} from "../shared/model";
import { migrateData } from "../shared/migrations";
import { fixture, observed, workspace } from "./fixtures";

function expired(defaultStartGroup: string, gate: "exact" | "upper-bound") {
  const test = fixture({
    settings: settingsSchema.parse({ autoArchive: true, defaultStartGroup }),
  });
  test.inventory.workspaces.push(workspace("w"));
  test.inventory.agents.push({
    id: "a",
    workspaceId: "w",
    title: null,
    activity: "idle",
    updatedAt: "2026-08-01T00:00:00Z",
    lastUserMessageAt: "2026-08-01T00:00:00Z",
  });
  test.host.conversation = async () =>
    observed("2026-08-01T00:00:00Z", { display: gate, gate });
  test.host.safety = vi.fn(async () => null);
  return test;
}

it.each([
  ["done", "exact"],
  ["done", "upper-bound"],
  ["canceled", "exact"],
  ["canceled", "upper-bound"],
] as const)(
  "keeps persisted terminal default %s parseable and never archives an unlabeled workspace with an expired %s gate",
  async (terminal, gate) => {
    const test = expired(terminal, gate);
    try {
      await test.board.start();
      expect(test.host.archive).not.toHaveBeenCalled();
      expect(test.board.snapshot().cards[0]).toMatchObject({
        stage: "inbox",
        archived: null,
        conversationGateEvidence: gate,
      });
      expect(defaultWorkspaceGroup(DEFAULT_GROUPS, terminal)).toBe("inbox");
    } finally {
      test.board.dispose();
    }
  },
);

it.each([
  ["done", "select"],
  ["canceled", "select"],
  ["done", "change-type"],
  ["canceled", "change-type"],
] as const)(
  "rejects %s as a terminal default via %s",
  async (terminal, action) => {
    const test = expired("review", "exact");
    try {
      await test.board.start();
      const before = test.store.current.settings;
      const next =
        action === "select"
          ? { ...before, defaultStartGroup: terminal }
          : {
              ...before,
              groups: before.groups.map((g) =>
                g.id === "review" ? { ...g, kind: terminal } : g,
              ),
            };
      await expect(
        test.board.mutate({
          action: "settings",
          revision: test.store.current.revision,
          expectedSettings: before,
          settings: next,
        }),
      ).rejects.toThrow("group-default-terminal");
      await test.board.refresh();
      expect(test.store.current.settings).toEqual(before);
      expect(test.host.archive).not.toHaveBeenCalled();
    } finally {
      test.board.dispose();
    }
  },
);

it.each(["done", "canceled"] as const)(
  "falls back safely if the persisted default group has subsequently become %s",
  async (terminal) => {
    const test = expired("review", "upper-bound");
    try {
      await test.board.start();
      await test.store.update((data) => {
        data.settings.groups = data.settings.groups.map((g) =>
          g.id === "review" ? { ...g, kind: terminal } : g,
        );
      });
      await test.board.refresh();
      expect(test.host.archive).not.toHaveBeenCalled();
      expect(test.board.snapshot().cards[0]).toMatchObject({
        stage: "inbox",
        archived: null,
        conversationGateEvidence: "upper-bound",
      });
    } finally {
      test.board.dispose();
    }
  },
);

it("pauses autoarchive only when migration must add a canceled mapping and prevents takeover until re-enabled", async () => {
  const migrated = migrateData(
    {
      schemaVersion: 6,
      settings: {
        autoArchive: true,
        groups: DEFAULT_GROUPS.filter((g) => g.kind !== "canceled"),
      },
    },
    6,
  );
  const boardTest = fixture(migrated);
  boardTest.inventory.workspaces.push(
    workspace("w", "Ordinary label", ["task:canceled"]),
  );
  boardTest.inventory.agents.push({
    id: "a",
    workspaceId: "w",
    title: null,
    activity: "idle",
    updatedAt: "2026-08-01T00:00:00Z",
    lastUserMessageAt: "2026-08-01T00:00:00Z",
  });
  boardTest.host.conversation = async () => observed("2026-08-01T00:00:00Z");
  boardTest.host.safety = vi.fn(async () => null);
  try {
    await boardTest.board.start();
    expect(boardTest.host.archive).not.toHaveBeenCalled();
    expect(boardTest.store.current.settings).toMatchObject({
      autoArchive: false,
      archiveMappingNeedsReview: true,
    });
    expect(boardTest.board.snapshot().cards[0]).toMatchObject({
      stage: "canceled",
      archived: null,
      conversationGateEvidence: "exact",
    });
    const current = boardTest.board.snapshot();
    await boardTest.board.mutate({
      action: "settings",
      revision: current.revision,
      expectedSettings: current.settings,
      settings: { ...current.settings, autoArchive: true },
    });
    await boardTest.board.refresh();
    expect(boardTest.host.archive).toHaveBeenCalledExactlyOnceWith("w");
    expect(boardTest.store.current.settings.archiveMappingNeedsReview).toBe(
      false,
    );
  } finally {
    boardTest.board.dispose();
  }
  for (const autoArchive of [true, false])
    expect(
      migrateData({ schemaVersion: 6, settings: { autoArchive } }, 6).settings
        .autoArchive,
    ).toBe(autoArchive);
});
