import type { Board, Card, StartInput } from "../shared/model";
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
  | "providerUnavailable"
> & { activity: Card["activity"]; parentAgentId?: string; subagentId?: string };
export interface Inventory {
  workspaces: Workspace[];
  agents: Agent[];
  projects: Board["projects"];
}
export interface Host {
  identity: { serverId: string; version: string };
  inventory(): Promise<Inventory>;
  workspace(id: string): Promise<Workspace | null>;
  conversation(agent: Agent, now: number): Promise<string | null>;
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
        this.agentUpdates.set(change.agentId, null);
        const workspaceId = this.agentWorkspaces.get(change.agentId);
        this.agentWorkspaces.delete(change.agentId);
        this.changed(workspaceId);
      }
    } else if (message.type === "agent.provider_subagents.update") {
      const change = message.payload;
      this.changed(
        this.agentWorkspaces.get(
          change.kind === "upsert"
            ? change.subagent.parentAgentId
            : change.parentAgentId,
        ),
      );
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
      // 0.9.1 refuses the provider-subagent API for archived parents. On a
      // first import we cannot prove that no provider children existed, so the
      // parent's whole conversation is unknown even if its own timeline reads.
      if (agent.archivedAt) {
        agent.providerUnavailable = true;
        continue;
      }
      try {
        for (const child of await this.compat.subagents(agent.id))
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
      } catch {
        agent.providerUnavailable = true;
      }
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
  async workspace(id: string): Promise<Workspace | null> {
    const value = await this.api.workspaces.ref(id).refresh();
    return value ? normalize(value) : null;
  }
  async conversation(agent: Agent, now: number): Promise<string | null> {
    if (agent.providerUnavailable)
      throw new Error("Conversation provider is unavailable");
    // A subagent descriptor timestamp is only a cautious consistency check against
    // replay synthesized as "now". It is never the conversation time; a projected
    // row newer than the descriptor remains unknown rather than being archived.
    const read =
      agent.parentAgentId && agent.subagentId
        ? this.compat.subagentTimeline(agent.parentAgentId, agent.subagentId)
        : (options: Parameters<import("./conversations").TimelineReader>[0]) =>
            this.api.agents.ref(agent.id).timeline.refetch(options);
    const time = await readConversationTime(read, now, agent.updatedAt);
    if (
      agent.lastUserMessageAt &&
      (!time || Date.parse(time) < Date.parse(agent.lastUserMessageAt))
    )
      throw new Error("Conversation history is incomplete");
    return time;
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
