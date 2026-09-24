import { expect, it, vi } from "vitest";
import { Store } from "../server/store";
import { Workboard } from "../server/workboard";
import {
  DEFAULT_GROUPS,
  nextGroupColor,
  settingsSchema,
  type Group,
} from "../shared/model";
import { mutationSchema } from "../shared/rpc";
import { fixture, workspace } from "./fixtures";

it("persists independent group colors through RPC and storage without changing workspace behavior", async () => {
  const custom = [
    { id: "coding", name: "Coding", kind: "in-progress", label: "task:coding" },
    {
      id: "testing",
      name: "Testing",
      kind: "in-progress",
      label: "task:testing",
    },
  ];
  const { board, backing, host, inventory, store, now } = fixture({
    settings: settingsSchema.parse({ groups: [...DEFAULT_GROUPS, ...custom] }),
  });
  inventory.workspaces.push(
    workspace("active", "Active", ["task:coding", "keep-me"]),
  );
  let reopened: Workboard | undefined;
  await board.start();
  try {
    const before = board.snapshot();
    expect(before.settings.groups).toEqual([...DEFAULT_GROUPS, ...custom]);
    const pins = store.current.autoPins;
    const native = structuredClone(inventory.workspaces);
    vi.mocked(host.setLabel).mockClear();
    vi.mocked(host.setPinned).mockClear();
    const groups = before.settings.groups.map((group) => ({
      ...group,
      ...(group.id === "coding" ? { color: "violet" } : {}),
      ...(group.id === "testing" ? { color: "cyan" } : {}),
    }));
    const saved = await board.mutate(
      mutationSchema.parse({
        action: "settings",
        revision: before.revision,
        expectedSettings: before.settings,
        settings: { ...before.settings, groups },
      }),
    );
    expect(saved.settings).toEqual({ ...before.settings, groups });
    expect(saved.cards.map(({ id, stage }) => ({ id, stage }))).toEqual(
      before.cards.map(({ id, stage }) => ({ id, stage })),
    );
    board.dispose();
    reopened = new Workboard(host, new Store(backing), now);
    await reopened.start();
    expect(reopened.snapshot().settings).toEqual(saved.settings);
    expect(inventory.workspaces).toEqual(native);
    expect(store.current.autoPins).toEqual(pins);
    expect(host.setLabel).not.toHaveBeenCalled();
    expect(host.setPinned).not.toHaveBeenCalled();
    expect(host.archive).not.toHaveBeenCalled();
  } finally {
    board.dispose();
    reopened?.dispose();
  }
});

it("keeps legacy group data intact and rejects unsupported color values", () => {
  expect(settingsSchema.parse({}).groups).toEqual(DEFAULT_GROUPS);
  const groups = DEFAULT_GROUPS.map((group) => ({
    ...group,
    color: "#123456",
  }));
  expect(settingsSchema.safeParse({ groups }).success).toBe(false);
});

it("recommends unused colors before reusing the least common color, counting legacy groups", () => {
  const groups: Group[] = [...DEFAULT_GROUPS];
  const recommendations: string[] = [];
  for (let i = 0; i < 7; i++) {
    const color = nextGroupColor(groups);
    expect(nextGroupColor([...groups].reverse())).toBe(color);
    recommendations.push(color);
    groups.push({
      id: `custom-${i}`,
      name: `Custom ${i}`,
      kind: "todo",
      label: `task:custom-${i}`,
      color,
    });
  }
  expect(recommendations).toEqual([
    "cyan",
    "teal",
    "orange",
    "violet",
    "pink",
    "blue",
    "cyan",
  ]);
});
