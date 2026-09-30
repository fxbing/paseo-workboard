import type {
  Board,
  Card,
  ConversationAgent,
  ConversationDisplay,
  ConversationGate,
  ConversationReason,
  StartInput,
} from "../shared/model";
import type { ConversationWindow, TimelineReader } from "./conversations";
import { readConversationTime } from "./conversations";
import { checkGitSafety } from "./git-safety";
import type { PaseoApi, PaseoCompat } from "./paseo-compat";

type PaseoWorkspace = Awaited<
  ReturnType<PaseoApi["workspaces"]["list"]>
>["entries"][number];
type PaseoAgent = Awaited<
  ReturnType<PaseoApi["agents"]["list"]>
>["entries"][number]["agent"];
type EventSubscription = ReturnType<PaseoApi["observeEvents"]>;
type Observer = Parameters<EventSubscription["subscribe"]>[0];
type SessionOutboundMessage = Parameters<Observer["update"]>[0];
type Subscription = {
  release(): Promise<void>;
  subscribe(
    observer: Omit<Observer, "snapshot"> & { snapshot(): void },
  ): unknown;
};
export type ProviderChild = Awaited<
  ReturnType<PaseoCompat["subagents"]>
>[number];
interface ChildRecord {
  parentUpdatedAt: string;
  seenWhileLive: boolean;
  children: ProviderChild[];
  refused: boolean;
}

export type Workspace = Pick<
  PaseoWorkspace,
  | "id"
  | "name"
  | "pinnedAt"
  | "projectId"
  | "projectDisplayName"
  | "workspaceDirectory"
  | "projectKind"
  | "workspaceKind"
  | "archivingAt"
  | "status"
  | "scripts"
  | "gitRuntime"
  | "githubRuntime"
  | "forge"
  | "syncSeq"
> & { labels: string[] };
export type Agent = Pick<
  PaseoAgent,
  | "id"
  | "workspaceId"
  | "title"
  | "updatedAt"
  | "lastUserMessageAt"
  | "archivedAt"
> & {
  activity: Card["activity"];
  parentAgentId?: string;
  subagentId?: string;
  /** Whether this parent's provider children could be listed in this inventory. */
  childEnumeration?: "complete" | "refused" | "unavailable";
};
/**
 * One agent's conversation evidence. Display and gate stay separate because Paseo records
 * neither a trustworthy exact time nor a single usable bound for every provider.
 */
export interface ConversationEvidence {
  displayAt: string | null;
  display: ConversationDisplay;
  gateAt: string | null;
  gate: ConversationGate;
  reason: ConversationReason | null;
}
export interface Inventory {
  workspaces: Workspace[];
  agents: Agent[];
  projects: Board["projects"];
}
export interface Host {
  identity: { serverId: string; version: string };
  inventory(): Promise<Inventory>;
  workspace(id: string): Promise<Workspace | null>;
  conversation(
    agent: Agent,
    now: number,
    options?: { archivedTimeline?: boolean },
  ): Promise<ConversationEvidence>;
  setLabel(
    workspaceId: string,
    name: string,
    color: string,
    assigned: boolean,
  ): Promise<string[]>;
  setPinned(workspaceId: string, pinned: boolean): Promise<string | null>;
  create(
    source: Extract<StartInput["target"], { kind: "new" }>["source"],
    title: string,
    key: string,
  ): Promise<string>;
  safety(workspace: Workspace): Promise<string | null>;
  archive(
    id: string,
  ): Promise<{ archivedAt: string | null; error: string | null }>;
  dispose(): void;
}
interface Page<T> {
  entries: T[];
  pageInfo: { nextCursor: string | null; hasMore: boolean };
}
export async function allPages<T>(
  read: (cursor?: string) => Promise<Page<T>>,
): Promise<T[]> {
  const result: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await read(cursor);
    result.push(...page.entries);
    if (!page.pageInfo.hasMore) return result;
    const next = page.pageInfo.nextCursor;
    if (!next || seen.has(next))
      throw new Error("Paseo directory pagination is incomplete");
    seen.add(next);
    cursor = next;
  } while (true);
}
function activity(agent: PaseoAgent): Card["activity"] {
  if (agent.archivedAt) return "idle";
  if (agent.pendingPermissions.length || agent.attentionReason === "permission")
    return "waiting";
  if (
    agent.status === "running" ||
    agent.status === "initializing" ||
    agent.activeTurn
  )
    return "running";
  if (
    agent.status === "error" ||
    agent.lastError ||
    agent.attentionReason === "error"
  )
    return "error";
  return agent.requiresAttention ? "attention" : "idle";
}
const normalize = (workspace: PaseoWorkspace): Workspace => ({
  ...workspace,
  labels: workspace.labels ?? [],
});

export class PaseoHost implements Host {
  private subscriptions: Array<() => Promise<void>> = [];
  private disposed = false;
  private subscriptionsFailed = false;
  private workspaceUpdates = new Map<string, Workspace | null>();
  private agentUpdates = new Map<string, Agent | null>();
  private agentWorkspaces = new Map<string, string | undefined>();
  /** Provider children per parent, keyed by the parent activity Paseo last reported. */
  private childRecords = new Map<string, ChildRecord>();
  constructor(
    private api: PaseoApi,
    private compat: PaseoCompat,
    readonly identity: Host["identity"],
    private changed: (workspaceId?: string) => void,
  ) {}
  private own(subscription: Subscription): void {
    let initial = true;
    subscription.subscribe({
      snapshot: () => {
        if (initial) initial = false;
        else this.changed();
      },
      update: (message) => this.update(message),
      error: () => {
        this.subscriptionsFailed = true;
        this.changed();
      },
    });
    this.subscriptions.push(() => subscription.release());
  }
  private update(message: SessionOutboundMessage): void {
    if (message.type === "workspace_update") {
      const change = message.payload;
      const id = change.kind === "upsert" ? change.workspace.id : change.id;
      this.workspaceUpdates.set(
        id,
        change.kind === "upsert" ? normalize(change.workspace) : null,
      );
      this.changed(id);
    } else if (message.type === "agent_update") {
      const change = message.payload;
      if (change.kind === "upsert") {
        this.agentUpdates.set(change.agent.id, {
          ...change.agent,
          activity: activity(change.agent),
        });
        this.changed(change.agent.workspaceId);
      } else {
        this.childRecords.delete(change.agentId);
        this.agentUpdates.set(change.agentId, null);
        const workspaceId = this.agentWorkspaces.get(change.agentId);
        this.agentWorkspaces.delete(change.agentId);
        this.changed(workspaceId);
      }
    } else if (message.type === "agent.provider_subagents.update") {
      const change = message.payload;
      const parentAgentId =
        change.kind === "upsert"
          ? change.subagent.parentAgentId
          : change.parentAgentId;
      // A child change does not have to touch the parent, so the cache cannot wait for
      // the parent's updatedAt to move.
      this.childRecords.delete(parentAgentId);
      this.changed(this.agentWorkspaces.get(parentAgentId));
    }
  }
  async inventory(): Promise<Inventory> {
    if (this.disposed) throw new Error("Workboard stopped");
    this.workspaceUpdates.clear();
    this.agentUpdates.clear();
    if (this.subscriptionsFailed) {
      await Promise.allSettled(this.subscriptions.map((release) => release()));
      this.subscriptions = [];
      this.subscriptionsFailed = false;
    }
    if (!this.subscriptions.length) {
      try {
        // In 0.9.1 the subscription is filtered, not paged (session.ts handleFetch*).
        // A single unfiltered subscription covers updates beyond the first 200 rows.
        this.own(
          (
            await this.api.workspaces.list({
              page: { limit: 200 },
              subscribe: {},
            })
          ).subscription,
        );
        this.own(
          (
            await this.api.agents.list({
              filter: { includeArchived: true },
              page: { limit: 200 },
              subscribe: {},
            })
          ).subscription,
        );
        const events = this.api.observeEvents([
          "agent.provider_subagents.update",
        ]);
        this.own(events);
        await events.ready;
      } catch (error) {
        await Promise.allSettled(
          this.subscriptions.map((release) => release()),
        );
        this.subscriptions = [];
        throw error;
      }
    }
    const [workspaces, agents, projects] = await Promise.all([
      allPages((cursor) =>
        this.api.workspaces.list({ page: { limit: 200, cursor } }),
      ),
      allPages((cursor) =>
        this.api.agents.list({
          filter: { includeArchived: true },
          page: { limit: 200, cursor },
        }),
      ),
      this.api.projects.list(),
    ]);
    if (this.disposed) throw new Error("Workboard stopped");
    const workspaceMap = new Map(workspaces.map((w) => [w.id, normalize(w)]));
    const agentMap = new Map<string, Agent>(
      agents.map(({ agent }) => [
        agent.id,
        { ...agent, activity: activity(agent) },
      ]),
    );
    for (const [id, value] of this.workspaceUpdates) {
      if (!value) workspaceMap.delete(id);
      else if (
        (value.syncSeq ?? Infinity) >= (workspaceMap.get(id)?.syncSeq ?? 0)
      )
        workspaceMap.set(id, value);
    }
    for (const [id, value] of this.agentUpdates) {
      if (!value) agentMap.delete(id);
      else if (
        !agentMap.has(id) ||
        Date.parse(value.updatedAt) >= Date.parse(agentMap.get(id)!.updatedAt)
      )
        agentMap.set(id, value);
    }
    for (const agent of [...agentMap.values()]) {
      this.agentWorkspaces.set(agent.id, agent.workspaceId);
      if (!agent.workspaceId || !workspaceMap.has(agent.workspaceId)) continue;
      const record = await this.childRecord(agent);
      agent.childEnumeration = record.refused
        ? agent.archivedAt
          ? "refused"
          : "unavailable"
        : "complete";
      for (const child of record.children)
        agentMap.set(`${agent.id}/provider/${child.id}`, {
          id: `${agent.id}/provider/${child.id}`,
          workspaceId: agent.workspaceId,
          parentAgentId: agent.id,
          subagentId: child.id,
          title: child.title,
          updatedAt: child.updatedAt,
          lastUserMessageAt: null,
          activity:
            child.status === "running"
              ? "running"
              : child.status === "failed"
                ? "error"
                : "idle",
        });
    }
    return {
      workspaces: [...workspaceMap.values()],
      agents: [...agentMap.values()],
      projects: projects.projects.map((project) => ({
        id: project.projectId,
        name: project.projectDisplayName,
        directory: project.projectRootPath,
        isGit: project.projectKind === "git",
      })),
    };
  }
  /**
   * Provider children are cached per parent activity. Re-listing them costs the daemon one
   * request per agent on every pass, and an archived parent cannot be re-listed at all, so
   * the children observed while it was live are kept instead of its chat going unknown.
   */
  private async childRecord(agent: Agent): Promise<ChildRecord> {
    const cached = this.childRecords.get(agent.id);
    if (cached && cached.parentUpdatedAt === agent.updatedAt) return cached;
    let record: ChildRecord;
    if (agent.archivedAt) {
      record = {
        parentUpdatedAt: agent.updatedAt,
        seenWhileLive: false,
        children: cached?.children ?? [],
        refused: true,
      };
    } else {
      try {
        record = {
          parentUpdatedAt: agent.updatedAt,
          seenWhileLive: true,
          children: await this.compat.subagents(agent.id),
          refused: false,
        };
      } catch {
        record = {
          parentUpdatedAt: agent.updatedAt,
          seenWhileLive: false,
          children: cached?.children ?? [],
          refused: true,
        };
      }
    }
    this.childRecords.set(agent.id, record);
    return record;
  }
  async workspace(id: string): Promise<Workspace | null> {
    const value = await this.api.workspaces.ref(id).refresh();
    return value ? normalize(value) : null;
  }
  /**
   * Read one agent's conversation evidence. `archivedTimeline` is opt-in because Paseo
   * re-projects an archived agent's whole history on every read (7.2-19.3s for pi), which
   * must not sit in the periodic refresh path; only the archive recheck asks for it.
   */
  async conversation(
    agent: Agent,
    now: number,
    options: { archivedTimeline?: boolean } = {},
  ): Promise<ConversationEvidence> {
    const isChild = Boolean(agent.parentAgentId && agent.subagentId);
    const parse = (value: string | null | undefined): number | null => {
      if (!value) return null;
      const time = Date.parse(value);
      return Number.isFinite(time) ? time : null;
    };
    // A recorded user message is a lower bound of the last message. A provider child's
    // descriptor timestamp is a hydration stamp, so only its parent bounds that window.
    const recordedLower = parse(agent.lastUserMessageAt);
    const recordedUpper = isChild ? null : parse(agent.updatedAt);
    const evidenceFor = (
      lower: number | null,
      reason: ConversationReason | null,
    ): ConversationEvidence => {
      // The gate is a max of upper bounds, so folding a lower bound in can only delay it.
      const gate = (value: number | null) => {
        if (value === null)
          return { gateAt: null, gate: "unknown" as ConversationGate };
        const bound = lower === null ? value : Math.max(value, lower);
        return {
          gateAt: new Date(bound).toISOString(),
          gate: "upper-bound" as ConversationGate,
        };
      };
      if (lower !== null)
        return {
          displayAt: new Date(lower).toISOString(),
          display: "lower-bound",
          ...gate(recordedUpper),
          reason,
        };
      if (recordedUpper !== null)
        return {
          displayAt: new Date(recordedUpper).toISOString(),
          display: "upper-bound",
          ...gate(recordedUpper),
          reason,
        };
      return {
        displayAt: null,
        display: "unknown",
        gateAt: null,
        gate: "unknown",
        reason,
      };
    };
    if (agent.archivedAt && !options.archivedTimeline)
      return evidenceFor(recordedLower, null);
    let window: ConversationWindow;
    try {
      const read = isChild
        ? this.compat.subagentTimeline(agent.parentAgentId!, agent.subagentId!)
        : (timeline: Parameters<TimelineReader>[0]) =>
            this.api.agents.ref(agent.id).timeline.refetch(timeline);
      window = await readConversationTime(read, {
        now,
        observedUpdatedAt: agent.updatedAt,
        observedUserMessageAt: agent.lastUserMessageAt ?? undefined,
      });
    } catch {
      return evidenceFor(recordedLower, "timeline-unreadable");
    }
    const admitted = parse(window.latest);
    const lower =
      admitted === null
        ? recordedLower
        : recordedLower === null
          ? admitted
          : Math.max(admitted, recordedLower);
    // An exact time needs every message row, no re-projected batch, and a timeline that
    // already contains the recorded user message; otherwise the value is only a bound.
    if (
      window.messages > 0 &&
      window.replayStamped === 0 &&
      !window.reproduced &&
      admitted !== null &&
      (recordedLower === null || admitted >= recordedLower)
    )
      return {
        displayAt: new Date(admitted).toISOString(),
        display: "exact",
        gateAt: new Date(admitted).toISOString(),
        gate: "exact",
        reason: null,
      };
    if (
      window.messages === 0 &&
      window.replayStamped === 0 &&
      !window.truncated &&
      recordedLower === null
    )
      return {
        displayAt: null,
        display: "none",
        gateAt: null,
        gate: "unknown",
        reason: null,
      };
    return evidenceFor(
      lower,
      window.truncated
        ? "truncated-window"
        : recordedLower !== null &&
            admitted !== null &&
            recordedLower > admitted
          ? "timeline-unreadable"
          : "replay-timestamp",
    );
  }
  setLabel(id: string, name: string, color: string, assigned: boolean) {
    return this.compat.setLabel(id, name, color, assigned);
  }
  setPinned(id: string, pinned: boolean) {
    return this.compat.setPinned(id, pinned);
  }
  async create(
    source: Extract<StartInput["target"], { kind: "new" }>["source"],
    title: string,
    key: string,
  ) {
    return (
      await this.api.workspaces.create({ source, title, idempotencyKey: key })
    ).id;
  }
  async safety(workspace: Workspace): Promise<string | null> {
    if (workspace.scripts.some((script) => script.lifecycle === "running"))
      return "script-running";
    if (
      (await this.api.terminals.list({ workspaceId: workspace.id })).entries
        .length
    )
      return "terminal-open";
    if (
      workspace.workspaceKind === "worktree" &&
      workspace.gitRuntime?.isPaseoOwnedWorktree !== true
    )
      return "git-unknown";
    return checkGitSafety(
      workspace.workspaceDirectory,
      workspace.projectKind === "git",
    );
  }
  archive(id: string) {
    return this.api.workspaces.archive(id);
  }
  dispose() {
    this.disposed = true;
    void Promise.allSettled(this.subscriptions.map((release) => release()));
    this.subscriptions = [];
  }
}
