import { vi } from "vitest";
import { dataSchema, type Data } from "../shared/model";
import { Store } from "../server/store";
import { Workboard } from "../server/workboard";
import type {
  Agent,
  ConversationEvidence,
  Host,
  Inventory,
  Workspace,
} from "../server/host";

/**
 * Build one agent's evidence. Fixtures describe the conversation a workspace observes and
 * default to an exact time, so a test only spells out the degraded case it exercises.
 */
export function observed(
  at: string | null,
  evidence: Partial<ConversationEvidence> = {},
): ConversationEvidence {
  return {
    displayAt: at,
    display: at === null ? "none" : "exact",
    gateAt: at,
    gate: at === null ? "unknown" : "exact",
    reason: null,
    ...evidence,
  };
}

/** Evidence for one agent at a fixed time, for host mocks. */
export function agentEvidence(at: string | null = null) {
  return async (_agent: Agent): Promise<ConversationEvidence> => observed(at);
}

export function fixture(initial: Partial<Data> = {}) {
  let saved = dataSchema.parse(initial);
  let revision = 0;
  const backing = {
    read: async () => ({
      status: "ready",
      revision: String(revision),
      values: structuredClone(saved),
    }),
    write: async (expected: string, values: Data) => {
      if (expected !== String(revision))
        return { status: "conflict", error: "Conflict" };
      saved = structuredClone(values);
      return {
        status: "saved",
        revision: String(++revision),
        values: structuredClone(saved),
      };
    },
  };
  const inventory: Inventory = { workspaces: [], agents: [], projects: [] };
  const created = new Map<string, string>();
  let pinWrites = 0;
  const host: Host = {
    identity: { serverId: "fixture-host", version: "0.9.1" },
    inventory: async () => structuredClone(inventory),
    workspace: async (id) =>
      structuredClone(inventory.workspaces.find((w) => w.id === id) ?? null),
    conversation: agentEvidence(),
    create: vi.fn(async (_source, title, key) => {
      if (created.has(key)) return created.get(key)!;
      const id = `w${created.size + 1}`;
      created.set(key, id);
      inventory.workspaces.push(workspace(id, title));
      return id;
    }),
    setLabel: vi.fn(async (id, name, _color, assigned) => {
      const w = inventory.workspaces.find((w) => w.id === id)!;
      w.labels = w.labels.filter((label) => label !== name);
      if (assigned) w.labels.push(name);
      return w.labels;
    }),
    setPinned: vi.fn(async (id, pinned) => {
      const w = inventory.workspaces.find((w) => w.id === id)!;
      w.pinnedAt = pinned ? new Date(now() + ++pinWrites).toISOString() : null;
      return w.pinnedAt;
    }),
    archive: vi.fn(async (id) => {
      inventory.workspaces = inventory.workspaces.filter((w) => w.id !== id);
      return { archivedAt: new Date(now()).toISOString(), error: null };
    }),
    safety: async () => null,
    dispose: vi.fn(),
  };
  const now = () => Date.parse("2026-09-23T00:00:00Z");
  const store = new Store(backing);
  const board = new Workboard(host, store, now);
  return { board, host, store, inventory, backing, now };
}
export function workspace(
  id: string,
  name = id,
  labels: string[] = [],
): Workspace {
  return {
    id,
    name,
    labels,
    projectId: "p",
    projectDisplayName: "Project",
    workspaceDirectory: "/fixture",
    projectKind: "directory",
    workspaceKind: "directory",
    archivingAt: null,
    status: "done",
    scripts: [],
  };
}
