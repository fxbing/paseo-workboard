import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import {
  boardSchema,
  newTask,
  settingsSchema,
  type Board,
} from "../shared/model";
import { strings } from "../client/strings";

const hooks = vi.hoisted(() => ({ cursor: 0, values: [] as unknown[] }));

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useState: <T>(initial: T | (() => T)) => {
      const index = hooks.cursor++;
      const values = hooks.values;
      if (index >= hooks.values.length)
        values[index] =
          typeof initial === "function" ? (initial as () => T)() : initial;
      const setValue = (next: T | ((current: T) => T)) => {
        values[index] =
          typeof next === "function"
            ? (next as (current: T) => T)(values[index] as T)
            : next;
      };
      return [values[index] as T, setValue] as const;
    },
  };
});

vi.mock("@getpaseo/plugin/client", () => ({ useRpc: vi.fn() }));
vi.mock("@getpaseo/plugin/client/react-native", () => {
  const component = () => null;
  return {
    Icon: component,
    Modal: component,
    ScrollView: component,
    TextInput: component,
    useToast: vi.fn(),
  };
});
vi.mock("@getpaseo/plugin/client/ui", () => {
  const component = () => null;
  return {
    ExternalLink: component,
    SettingsCard: component,
    SettingsInput: component,
    SettingsRow: component,
    SettingsSection: component,
    SettingsSelect: component,
    SettingsSwitch: component,
  };
});

import { SettingsPage } from "../client/WorkboardScreen";

beforeEach(() => {
  hooks.cursor = 0;
  hooks.values = [];
});

function findElement(
  node: ReactNode,
  matches: (element: ReactElement<Record<string, unknown>>) => boolean,
  description: string,
): ReactElement<Record<string, unknown>> {
  if (!node || typeof node !== "object")
    throw new Error(`${description} not found`);
  const element = node as ReactElement<{
    children?: ReactNode;
    [key: string]: unknown;
  }>;
  if (matches(element)) return element;
  const children = Array.isArray(element.props.children)
    ? element.props.children
    : [element.props.children];
  for (const child of children) {
    try {
      return findElement(child, matches, description);
    } catch {
      // Keep searching siblings.
    }
  }
  throw new Error(`${description} not found`);
}

const findByTestId = (node: ReactNode, testID: string) =>
  findElement(node, (element) => element.props.testID === testID, testID);

const theme = {
  colors: {
    accent: "#000000",
    accentForeground: "#ffffff",
    foreground: "#111111",
    foregroundMuted: "#777777",
    statusDanger: "#cc0000",
    statusWarning: "#aa7700",
    surface0: "#ffffff",
  },
} as never;
const t = strings("zh");

function renderSettings(
  board: Board,
  mutate: Parameters<typeof SettingsPage>[0]["mutate"],
) {
  hooks.cursor = 0;
  return SettingsPage({
    board,
    t,
    theme,
    disabled: false,
    saving: false,
    mutate,
    onBack: vi.fn(),
  });
}

function board(
  settings = settingsSchema.parse({}),
  cards: Board["cards"] = [],
) {
  return boardSchema.parse({
    revision: 7,
    serverId: "host",
    version: "0.10.0-beta.1",
    connected: true,
    error: null,
    refreshedAt: null,
    settings,
    cards,
    projects: [],
  });
}

it.each([
  ["automatic archive", "workboard-auto-archive", "autoArchive", true],
  [
    "In progress sidebar pinning",
    "workboard-pin-in-progress",
    "pinInProgressWorkspaces",
    false,
  ],
] as const)(
  "persists %s when its switch changes and keeps it after reopening",
  async (_, testID, key, value) => {
    const settings = settingsSchema.parse({
      autoArchive: false,
      pinInProgressWorkspaces: true,
    });
    const initial = board(settings);
    const saved = {
      ...initial,
      revision: 8,
      settings: { ...settings, [key]: value },
    };
    const mutate = vi.fn().mockResolvedValue(saved);
    const screen = renderSettings(initial, mutate);

    const toggle = findByTestId(screen, testID);
    await (
      toggle.props as { onValueChange(nextValue: boolean): Promise<void> }
    ).onValueChange(value);

    expect(mutate).toHaveBeenCalledWith({
      action: "settings",
      revision: 7,
      expectedSettings: settings,
      settings: { ...settings, [key]: value },
    });
    expect(
      findByTestId(renderSettings(initial, mutate), testID).props.value,
    ).toBe(value);

    hooks.values = [];
    expect(
      findByTestId(renderSettings(saved, mutate), testID).props.value,
    ).toBe(value);
  },
);

it("keeps automatic archive off when saving fails", async () => {
  const initial = board(settingsSchema.parse({ autoArchive: false }));
  const mutate = vi.fn().mockResolvedValue(undefined);
  const toggle = findByTestId(
    renderSettings(initial, mutate),
    "workboard-auto-archive",
  );

  await (
    toggle.props as { onValueChange(nextValue: boolean): Promise<void> }
  ).onValueChange(true);

  expect(
    findByTestId(renderSettings(initial, mutate), "workboard-auto-archive")
      .props.value,
  ).toBe(false);
});

it("adopts a completed save after leaving and reopening while it is pending", async () => {
  const settings = settingsSchema.parse({ autoArchive: false });
  const initial = board(settings);
  const saved = {
    ...initial,
    revision: 8,
    settings: { ...settings, autoArchive: true },
  };
  let finish!: (result: Board) => void;
  const mutate = vi.fn(
    () =>
      new Promise<Board>((resolve) => {
        finish = resolve;
      }),
  );
  const toggle = findByTestId(
    renderSettings(initial, mutate),
    "workboard-auto-archive",
  );

  const pending = (
    toggle.props as { onValueChange(nextValue: boolean): Promise<void> }
  ).onValueChange(true);
  hooks.values = [];
  expect(
    findByTestId(renderSettings(initial, mutate), "workboard-auto-archive")
      .props.value,
  ).toBe(false);

  finish(saved);
  await pending;
  expect(
    findByTestId(renderSettings(saved, mutate), "workboard-auto-archive").props
      .value,
  ).toBe(true);
});

it("requires confirmation before enabling automatic archive with due workspaces", async () => {
  const settings = settingsSchema.parse({ autoArchive: false });
  const timestamp = "2026-01-01T00:00:00.000Z";
  const due = {
    ...newTask("task", "Due task", timestamp, "done"),
    workspaceId: "workspace",
    lastConversationAt: timestamp,
    conversationStatus: "known" as const,
    conversationDisplayEvidence: "exact" as const,
    conversationGateEvidence: "exact" as const,
    conversationGateAt: timestamp,
    stage: "done" as const,
    labels: ["task:done"],
    managedLabels: ["task:done"],
    changeRequest: null,
    changeRequestUnavailable: false,
    activity: "idle" as const,
    pinState: "none" as const,
    dueAt: timestamp,
    agents: [],
  };
  const initial = board(settings, [due]);
  const saved = {
    ...initial,
    revision: 8,
    settings: { ...settings, autoArchive: true },
  };
  const mutate = vi.fn().mockResolvedValue(saved);
  const toggle = findByTestId(
    renderSettings(initial, mutate),
    "workboard-auto-archive",
  );

  await (
    toggle.props as { onValueChange(nextValue: boolean): Promise<void> }
  ).onValueChange(true);
  expect(mutate).not.toHaveBeenCalled();

  const confirmation = findElement(
    renderSettings(initial, mutate),
    (element) => element.props.title === t.enableAutoArchive,
    "automatic archive confirmation",
  );
  await (confirmation.props as { onConfirm(): Promise<boolean> }).onConfirm();

  expect(mutate).toHaveBeenCalledWith({
    action: "settings",
    revision: 7,
    expectedSettings: settings,
    settings: { ...settings, autoArchive: true },
  });
});
