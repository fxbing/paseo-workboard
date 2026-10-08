import { expect, it, vi } from "vitest";
import { Store } from "../server/store";
import { Workboard } from "../server/workboard";
import {
  DEFAULT_GROUPS,
  GROUP_COLORS,
  STAGE_COLORS,
  groupColorKey,
  nextGroupColor,
  settingsSchema,
  type Group,
} from "../shared/model";
import { mutationSchema } from "../shared/rpc";
import { groupColorValue, supplementalColor } from "../client/colors";
import { WorkspaceLabelColorSchema } from "@getpaseo/protocol/messages";
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
    "gray",
    "teal",
    "amber",
    "pink",
    "gray",
    "blue",
    "cyan",
  ]);
});

const colorTheme = (surface0: string) =>
  ({
    colors: {
      surface0,
      accent: "accent",
      foregroundMuted: "muted",
      statusSuccess: "success",
      statusWarning: "warning",
      statusDanger: "danger",
    },
  }) as any;
it.each([
  "#fff",
  "#FFFFFF",
  "#ffffffff",
  "rgb(255, 255, 255)",
  "rgba(255,255,255,0.5)",
])("U01 reads light surfaces in %s", (surface) => {
  expect(supplementalColor(colorTheme(surface), "light", "dark")).toBe("light");
});
it.each(["#000", "#000000", "#000000ff", "rgb(0, 0, 0)", "rgba(0,0,0,1)"])(
  "U01 reads dark surfaces in %s",
  (surface) => {
    expect(supplementalColor(colorTheme(surface), "light", "dark")).toBe(
      "dark",
    );
  },
);
it.each([
  "unrecognized",
  "#ffff",
  "#gggggg",
  "rgb(256,0,0)",
  "rgb(-1,0,0)",
  "rgba(0,0,0,2)",
  "rgb(0,0)",
])("U01 uses independent fixed fallbacks for invalid %s", (surface) => {
  const colors = GROUP_COLORS.map((color) =>
    groupColorValue(color, colorTheme(surface)),
  );
  expect(new Set(colors).size).toBe(10);
  expect(colors).toEqual(
    GROUP_COLORS.map((color) => groupColorValue(color, colorTheme("#fff"))),
  );
  expect(colors).not.toContain("accent");
});
it("U02 gives all ten colors distinct light and dark palettes independent of semantic tokens", () => {
  const light = GROUP_COLORS.map((color) =>
    groupColorValue(color, colorTheme("#fff")),
  );
  const dark = GROUP_COLORS.map((color) =>
    groupColorValue(color, colorTheme("#000")),
  );
  expect(new Set(light).size).toBe(10);
  expect(new Set(dark).size).toBe(10);
  for (let i = 0; i < 10; i++) {
    expect(light[i]).toMatch(/^#[a-f0-9]{6}$/i);
    expect(dark[i]).toMatch(/^#[a-f0-9]{6}$/i);
    expect(light[i]).not.toBe(dark[i]);
  }
});
it("U04 defaults share the native stage color mapping while preserving the host's named-color contract", () => {
  expect(DEFAULT_GROUPS.map(groupColorKey)).toEqual([
    "violet",
    "cyan",
    "blue",
    "orange",
    "green",
    "red",
  ]);
  expect(STAGE_COLORS).toEqual({
    inbox: "indigo",
    todo: "sky",
    "in-progress": "blue",
    review: "orange",
    done: "emerald",
    canceled: "red",
  });
  for (const color of Object.values(STAGE_COLORS))
    expect(WorkspaceLabelColorSchema.safeParse(color).success).toBe(true);
  expect(groupColorKey({ ...DEFAULT_GROUPS[0], color: "pink" })).toBe("pink");
});

it("U04 sends compatible native colors on real stage transitions", async () => {
  const test = fixture();
  test.inventory.workspaces.push(workspace("w", "Workspace", ["task:inbox"]));
  await test.board.start();
  try {
    for (const group of DEFAULT_GROUPS.slice(1)) {
      const value = test.board.snapshot().cards[0];
      await test.board.mutate({
        action: "stage",
        taskId: value.id,
        stage: group.id,
        expectedLabels: value.managedLabels,
      });
      expect(test.host.setLabel).toHaveBeenCalledWith(
        "w",
        group.label,
        STAGE_COLORS[group.kind],
        true,
      );
    }
  } finally {
    test.board.dispose();
  }
});
