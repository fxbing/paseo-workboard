import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  archiveDueAt,
  archiveGate,
  conversationStatusFor,
  defaultGroup,
  defaultWorkspaceGroup,
  groupKind,
  isArchiveDue,
  isDraftGroup,
  isTerminalGroup,
  labelKey,
  newTask,
  orderedGroups,
  resolveStage,
  settingsSchema,
  statusLabels,
  STAGE_COLORS,
  type Board,
  type Card,
  type ConversationAgent,
  type ConversationDisplay,
  type ConversationGate,
  type ConversationReason,
  type Settings,
  type Stage,
  type Task,
} from "../shared/model";
import type { Mutation } from "../shared/rpc";
import type {
  Agent,
  ConversationEvidence,
  Host,
  Inventory,
  Workspace,
} from "./host";
import type { Store } from "./store";

/** One workspace's combined conversation evidence. */
interface WorkspaceConversation {
  displayAt: string | null;
  display: ConversationDisplay;
  gateAt: string | null;
  gate: ConversationGate;
  reason: ConversationReason | null;
  agents: ConversationAgent[];
}
/** Most severe first, so one reason is stored per task. */
const REASON_ORDER: ConversationReason[] = [
  "timeline-unreadable",
  "child-enumeration-unavailable",
  "child-timeline-unreadable",
  "replay-timestamp",
  "truncated-window",
];

const labelsEqual = (a: string[], b: string[]) =>
  JSON.stringify(a.map(labelKey).sort()) ===
  JSON.stringify(b.map(labelKey).sort());
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const sameOrder = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);
const hidden = (task: Task) =>
  task.archived?.status === "archived" || task.archived?.status === "external";

function projectChangeRequest(workspace?: Workspace): Card["changeRequest"] {
  const runtime = workspace?.githubRuntime;
  const request = runtime?.pullRequest;
  if (!request) return null;
  const nativeState = request.state.toLowerCase();
  const state =
    request.isMerged || nativeState === "merged"
      ? "merged"
      : nativeState === "closed"
        ? "closed"
        : nativeState === "open" || nativeState === "opened"
          ? request.isDraft
            ? "draft"
            : "open"
          : "unknown";
  return {
    forge: workspace?.forge ?? "github",
    number: request.number ?? null,
    url: request.url,
    title: request.title,
    state,
    checksStatus: request.checksStatus ?? null,
    reviewDecision: request.reviewDecision ?? null,
  };
}

/** One writer per plugin process. UI windows never own timers or archive operations. */
export class Workboard {
  private inventory: Inventory = { workspaces: [], agents: [], projects: [] };
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private refreshing: Promise<void> | undefined;
  // null means a full refresh; undefined means no work is waiting.
  private pendingRefresh: Set<string> | null | undefined;
  private stopped = false;
  private pendingMutations = 0;
  private connectionGeneration = 0;
  private epoch = 0;
  private workspaceEpochs = new Map<string, number>();
  private connected = false;
  private error: string | null = "Workboard is starting";
  private refreshedAt: string | null = null;
  constructor(
    private host: Host,
    private store: Store,
    private now: () => number = Date.now,
    private interval = 60000,
  ) {}
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const work = this.queue.then(() => {
      if (this.stopped) throw new Error("Workboard stopped");
      return run();
    });
    this.queue = work.catch(() => undefined);
    return work;
  }
  private stamp(previous?: string): string {
    return new Date(
      Math.max(this.now(), previous ? Date.parse(previous) + 1 : 0),
    ).toISOString();
  }
  private task(id: string): Task {
    const task = this.store.current.tasks.find((t) => t.id === id);
    if (!task) throw new Error("Task no longer exists");
    return task;
  }
  async start(): Promise<void> {
    await this.serial(async () => {
      await this.load();
      await this.store.update((data) => {
        for (const task of data.tasks)
          if (task.archived?.status === "pending") {
            task.archived.status = "uncertain";
            task.archived.detail =
              "Native archive outcome unknown after restart";
            task.issue = "native-archive-unknown";
          }
      });
      for (const task of this.store.current.tasks.filter((t) => t.binding)) {
        try {
          await this.bind(task.id);
        } catch {
          await this.issue(task.id, "label-sync-incomplete");
        }
      }
      await this.reconcile();
      await this.scan();
    });
    if (!this.stopped)
      this.timer = setInterval(() => {
        void this.refresh().catch(() => undefined);
      }, this.interval);
  }
  private async load() {
    await this.store.load();
    const serverId = this.store.current.serverId;
    if (serverId && serverId !== this.host.identity.serverId)
      throw new Error("Workboard storage belongs to another Paseo host");
    if (!serverId)
      await this.store.update((data) => {
        data.serverId = this.host.identity.serverId;
      });
  }
  refresh(): Promise<void> {
    this.pendingRefresh = null;
    return this.flushRefresh();
  }
  private flushRefresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.serial(async () => {
      const scope = this.pendingRefresh ?? undefined;
      this.pendingRefresh = undefined;
      try {
        if (!this.connected) await this.load();
        await this.reconcile(scope);
        await this.scan(scope);
      } catch (error) {
        this.connected = false;
        this.error = message(error);
        throw error;
      }
    }).finally(() => {
      this.refreshing = undefined;
      if (this.pendingRefresh !== undefined) this.scheduleRefresh();
    });
    return this.refreshing;
  }
  private observation(id: string): string {
    return `${this.epoch}:${this.workspaceEpochs.get(id) ?? 0}`;
  }
  agentChanged(id: string): void {
    this.changed(this.inventory.agents.find((a) => a.id === id)?.workspaceId);
  }
  changed(workspaceId?: string): void {
    if (workspaceId)
      this.workspaceEpochs.set(
        workspaceId,
        (this.workspaceEpochs.get(workspaceId) ?? 0) + 1,
      );
    else this.epoch++;
    if (!workspaceId) this.pendingRefresh = null;
    else if (this.pendingRefresh !== null) {
      this.pendingRefresh ??= new Set();
      this.pendingRefresh.add(workspaceId);
    }
    this.scheduleRefresh();
  }
  private scheduleRefresh(): void {
    if (this.stopped || this.debounce || this.refreshing) return;
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      if (this.pendingRefresh !== undefined)
        void this.flushRefresh().catch(() => undefined);
    }, 300);
  }
  disconnected(reason = "Paseo disconnected"): void {
    this.epoch++;
    this.connectionGeneration++;
    this.connected = false;
    this.error = reason;
  }
  snapshot(): Board {
    const data = this.store.current;
    return {
      revision: data.revision,
      ...this.host.identity,
      connected: this.connected,
      error: this.error,
      refreshedAt: this.refreshedAt,
      settings: data.settings,
      projects: this.inventory.projects,
      cards: data.tasks.map((task) => {
        const workspace = this.inventory.workspaces.find(
          (w) => w.id === task.workspaceId,
        );
        const agents = this.inventory.agents.filter(
          (a) => a.workspaceId === task.workspaceId,
        );
        const activities = agents
          .filter((a) => !a.archivedAt)
          .map((a) => a.activity);
        const activity: Card["activity"] =
          (["waiting", "error", "attention", "running"] as const).find((a) =>
            activities.includes(a),
          ) ?? "idle";
        const stage = task.workspaceId
          ? workspace
            ? resolveStage(workspace.labels, data.settings.groups)
            : task.lastStage
          : task.draftStage;
        return {
          ...task,
          stage,
          labels: workspace?.labels ?? [],
          managedLabels: statusLabels(
            workspace?.labels ?? [],
            data.settings.groups,
          ),
          activity,
          changeRequest: projectChangeRequest(workspace),
          changeRequestUnavailable: !!workspace?.githubRuntime?.error,
          pinState:
            workspace?.pinnedAt == null
              ? "none"
              : data.autoPins[workspace.id] === workspace.pinnedAt
                ? "automatic"
                : "manual",
          dueAt:
            task.workspaceId && isTerminalGroup(stage, data.settings.groups)
              ? archiveDueAt(archiveGate(task))
              : null,
          agents: agents.map((a) => ({
            id: a.id,
            title: a.title ?? a.id,
            activity: a.activity,
            archived: !!a.archivedAt,
          })),
        };
      }),
    };
  }
  private async reconcile(scope?: ReadonlySet<string>): Promise<void> {
    const connection = this.connectionGeneration;
    const inventory = await this.host.inventory();
    await this.syncPins(inventory, connection);
    const prior = this.store.current;
    const observations = new Map<string, WorkspaceConversation>();
    for (const workspace of inventory.workspaces) {
      const agents = inventory.agents.filter(
        (agent) => agent.workspaceId === workspace.id,
      );
      const previous = prior.tasks.find(
        (task) => task.workspaceId === workspace.id,
      );
      if (scope && !scope.has(workspace.id) && previous) continue;
      observations.set(
        workspace.id,
        await this.observe(agents, previous, this.now()),
      );
    }
    if (this.stopped) throw new Error("Workboard stopped");
    this.inventory = inventory;
    await this.store.update((data) => {
      for (const workspace of inventory.workspaces) {
        let task = data.tasks.find((t) => t.workspaceId === workspace.id);
        if (!task) {
          task = {
            ...newTask(
              randomUUID(),
              workspace.name,
              this.stamp(),
              defaultWorkspaceGroup(data.settings.groups),
            ),
            workspaceId: workspace.id,
          };
          data.tasks.push(task);
        }
        if (task.archived?.status === "external") task.archived = null;
        task.title = workspace.name;
        task.projectId = workspace.projectId;
        task.projectName = workspace.projectDisplayName;
        task.lastStage = resolveStage(workspace.labels, data.settings.groups);
        const observation = observations.get(workspace.id);
        if (observation) {
          task.lastConversationAt = observation.displayAt;
          task.conversationDisplayEvidence = observation.display;
          task.conversationStatus = conversationStatusFor(observation.display);
          task.conversationGateAt = observation.gateAt;
          task.conversationGateEvidence = observation.gate;
          task.conversationReason = observation.reason;
          task.conversationAgents = observation.agents;
        }
        task.issue =
          task.archived?.status === "uncertain"
            ? "native-archive-unknown"
            : task.binding
              ? "label-sync-incomplete"
              : task.lastStage === "conflict"
                ? "labels-conflict"
                : task.conversationStatus === "unknown"
                  ? "conversation-unknown"
                  : task.conversationStatus === "none"
                    ? "no-conversation"
                    : null;
      }
      for (const task of data.tasks) {
        if (
          task.workspaceId &&
          !inventory.workspaces.some((w) => w.id === task.workspaceId) &&
          !task.archived &&
          !task.binding
        ) {
          task.archived = {
            operationId: randomUUID(),
            kind: "external",
            status: "external",
            stage: task.lastStage,
            group:
              data.settings.groups.find(
                (group) => group.id === task.lastStage,
              ) ?? null,
            startedAt: this.stamp(),
            archivedAt: null,
            lastConversationAt: task.lastConversationAt,
            detail:
              "No longer in Paseo active workspaces; native archive time and cleanup unknown",
          };
        }
      }
    });
    if (connection !== this.connectionGeneration)
      throw new Error(this.error ?? "Paseo disconnected during refresh");
    this.connected = true;
    this.error = null;
    this.refreshedAt = this.stamp();
  }
  /**
   * Combine every agent's evidence into one display time and one archive gate. Only a full
   * exact read of every agent and every provider child can claim an exact time; anything
   * else keeps the newest observed bound so a task never loses its card time, while the gate
   * stays an upper bound that can only delay archiving.
   */
  private async observe(
    agents: readonly Agent[],
    previous: Task | undefined,
    now: number,
    options: { archivedTimeline?: boolean } = {},
  ): Promise<WorkspaceConversation> {
    const readings: Array<{
      agent: Agent;
      conversation: ConversationEvidence;
    }> = [];
    for (const agent of agents) {
      const isChild = Boolean(agent.parentAgentId && agent.subagentId);
      let conversation: ConversationEvidence;
      try {
        conversation = await this.host.conversation(agent, now, options);
      } catch {
        // One unreadable agent degrades its own evidence instead of the whole workspace.
        const bound = isChild ? null : (agent.updatedAt ?? null);
        conversation = {
          displayAt: bound,
          display: bound === null ? "unknown" : "upper-bound",
          gateAt: bound,
          gate: bound === null ? "unknown" : "upper-bound",
          reason: isChild ? "child-timeline-unreadable" : "timeline-unreadable",
        };
      }
      readings.push({ agent, conversation });
    }
    const reasons = new Set<ConversationReason>();
    let lower: number | null = null;
    let upper: number | null = null;
    for (const { agent, conversation } of readings) {
      if (conversation.reason) reasons.add(conversation.reason);
      if (
        agent.childEnumeration === "refused" ||
        agent.childEnumeration === "unavailable"
      )
        reasons.add("child-enumeration-unavailable");
      const time = conversation.displayAt
        ? Date.parse(conversation.displayAt)
        : null;
      if (time !== null) {
        // An upper-bound display value never counts as a lower bound of the conversation.
        if (conversation.display === "upper-bound")
          upper = Math.max(upper ?? time, time);
        else lower = Math.max(lower ?? time, time);
      }
      const isChild = Boolean(agent.parentAgentId && agent.subagentId);
      const activity = isChild ? null : Date.parse(agent.updatedAt);
      if (activity !== null && Number.isFinite(activity))
        upper = Math.max(upper ?? activity, activity);
    }
    const recorded = previous?.conversationAgents ?? [];
    const live = new Set(
      readings
        .filter(({ agent }) => agent.childEnumeration === "complete")
        .map(({ agent }) => agent.id),
    );
    const agentsEvidence: ConversationAgent[] = readings
      .filter(({ agent }) => Boolean(agent.parentAgentId && agent.subagentId))
      .map(({ agent, conversation }) => ({
        id: agent.id,
        lastObservedAt: conversation.displayAt,
        seenWhileLive: live.has(agent.parentAgentId!),
      }));
    const current = new Set(readings.map(({ agent }) => agent.id));
    let blocked = false;
    for (const entry of recorded) {
      if (current.has(entry.id)) continue;
      agentsEvidence.push(entry);
      // A vanished child cannot be re-read, so this workspace can no longer claim an exact
      // time. Its recorded observation still participates in both bounds; without one nothing
      // bounds its conversation any more.
      reasons.add("child-enumeration-unavailable");
      const time = entry.lastObservedAt
        ? Date.parse(entry.lastObservedAt)
        : null;
      if (time === null || !Number.isFinite(time)) {
        blocked = true;
        continue;
      }
      lower = Math.max(lower ?? time, time);
      upper = Math.max(upper ?? time, time);
    }
    if (lower !== null) upper = Math.max(upper ?? lower, lower);
    // Derived after the vanished children folded in: their reasons and their time decide whether
    // this workspace can claim an exact time or the absence of any conversation at all.
    const exact =
      readings.length > 0 &&
      reasons.size === 0 &&
      readings.every(({ conversation }) => conversation.gate === "exact");
    const noConversation =
      readings.length > 0 &&
      reasons.size === 0 &&
      readings.every(({ conversation }) => conversation.display === "none");
    const reason =
      REASON_ORDER.find((candidate) => reasons.has(candidate)) ?? null;
    const bounded =
      lower === null
        ? upper === null
          ? ({ display: "unknown", gate: "unknown" } as const)
          : ({ display: "upper-bound", gate: "upper-bound" } as const)
        : ({
            display: "lower-bound",
            gate: upper === null ? "unknown" : "upper-bound",
          } as const);
    const boundAt = lower ?? upper;
    const display: ConversationDisplay = exact
      ? "exact"
      : noConversation
        ? "none"
        : bounded.display;
    const gate: ConversationGate = exact
      ? "exact"
      : blocked || noConversation || upper === null
        ? "unknown"
        : "upper-bound";
    const gateAt =
      gate === "exact" ? boundAt : blocked || noConversation ? null : upper;
    return {
      displayAt:
        noConversation || boundAt === null
          ? null
          : new Date(boundAt).toISOString(),
      display,
      gateAt: gateAt === null ? null : new Date(gateAt).toISOString(),
      gate,
      reason: exact || noConversation ? null : reason,
      agents: agentsEvidence,
    };
  }
  /**
   * Re-read one candidate's conversation before archiving it. Returns the gate that the
   * archive decision may use, or null when no bound can be proven right now.
   */
  private async verifyConversation(
    candidate: Task,
    agents: readonly Agent[],
  ): Promise<string | null> {
    let gate: number | null = null;
    try {
      // The archive candidate is the one place that pays for an archived agent's timeline,
      // and a vanished child without a recorded time already forces an unknown gate.
      const evidence = await this.observe(agents, candidate, this.now(), {
        archivedTimeline: true,
      });
      const at = archiveGate({
        conversationGateAt: evidence.gateAt,
        conversationGateEvidence: evidence.gate,
      });
      if (at === null) return null;
      gate = Date.parse(at);
    } catch {
      return null;
    }
    return gate === null || !Number.isFinite(gate)
      ? null
      : new Date(gate).toISOString();
  }
  private async syncPins(
    inventory: Inventory,
    connection: number,
  ): Promise<void> {
    const connected = () =>
      !this.stopped && connection === this.connectionGeneration;
    const wantsPin = (workspace: Workspace) => {
      const settings = this.store.current.settings;
      return (
        settings.pinInProgressWorkspaces &&
        !workspace.archivingAt &&
        groupKind(
          resolveStage(workspace.labels, settings.groups),
          settings.groups,
        ) === "in-progress"
      );
    };
    for (const listed of inventory.workspaces) {
      if (!connected()) return;
      const id = listed.id;
      const owned = this.store.current.autoPins[id];
      if (owned === undefined && !wantsPin(listed)) continue;
      const observation = this.observation(id);
      const current = () => connected() && observation === this.observation(id);
      const workspace = await this.host.workspace(id);
      if (!workspace || !current()) continue;
      if (!wantsPin(workspace)) {
        if (owned && workspace.pinnedAt === owned)
          await this.host.setPinned(id, false);
        if (owned !== undefined)
          await this.store.update((data) => {
            delete data.autoPins[id];
          });
      } else if (owned === undefined) {
        // Persist before the native write. A lost receipt must not claim a manual pin.
        await this.store.update((data) => {
          data.autoPins[id] = null;
        });
        if (workspace.pinnedAt) continue;
        if (!current()) {
          await this.store.update((data) => {
            delete data.autoPins[id];
          });
          continue;
        }
        const pinnedAt = await this.host.setPinned(id, true);
        await this.store.update((data) => {
          data.autoPins[id] = pinnedAt;
        });
      } else if (owned !== null && workspace.pinnedAt !== owned) {
        await this.store.update((data) => {
          data.autoPins[id] = null;
        });
      }
    }
    if (!connected()) return;
    const active = new Set(
      inventory.workspaces.map((workspace) => workspace.id),
    );
    await this.store.update((data) => {
      for (const id of Object.keys(data.autoPins))
        if (!active.has(id)) delete data.autoPins[id];
    });
  }
  private async saveSettings(
    settings: Settings,
    revision: number,
    expectedSettings?: Settings,
  ): Promise<void> {
    const previous = this.store.current;
    const unchanged = (data: typeof previous) =>
      expectedSettings
        ? isDeepStrictEqual(data.settings, expectedSettings)
        : data.revision === revision;
    if (!unchanged(previous))
      throw new Error("Settings changed; refresh before saving");
    const next = settingsSchema.parse(settings);
    const previousIds = previous.settings.groups.map((group) => group.id);
    const nextIds = next.groups.map((group) => group.id);
    const retained = nextIds.filter((id) => previousIds.includes(id));
    if (
      !sameOrder(
        retained,
        previousIds.filter((id) => nextIds.includes(id)),
      )
    )
      throw new Error("Groups cannot be reordered here");
    if (nextIds.slice(retained.length).some((id) => previousIds.includes(id)))
      throw new Error("Groups cannot be reordered here");
    if (!sameOrder(next.groupOrder, previous.settings.groupOrder))
      throw new Error("Group order changed; refresh before saving");
    next.groupOrder = previous.settings.groupOrder.length
      ? orderedGroups({
          groups: next.groups,
          groupOrder: previous.settings.groupOrder,
        }).map((group) => group.id)
      : [];
    const removed = previous.settings.groups.filter(
      (group) => !next.groups.some((candidate) => candidate.id === group.id),
    );
    for (const task of previous.tasks.filter((task) => !hidden(task))) {
      if (task.binding) {
        const oldGroup = previous.settings.groups.find(
          (group) => group.id === task.binding!.stage,
        )!;
        const newGroup = next.groups.find(
          (group) => group.id === task.binding!.stage,
        );
        if (
          !newGroup ||
          newGroup.kind !== oldGroup.kind ||
          newGroup.label !== oldGroup.label
        )
          throw new Error(
            "A workspace binding still uses this group; finish binding first",
          );
      }
      if (!task.workspaceId && !isDraftGroup(task.draftStage, next.groups))
        throw new Error(
          "Move the drafts out before deleting this group or changing its type",
        );
    }
    if (removed.length) {
      const epoch = this.epoch;
      const inventory = await this.host.inventory();
      if (epoch !== this.epoch || !this.connected)
        throw new Error("Workspaces changed; refresh before deleting a group");
      for (const group of removed) {
        const missingTasks = previous.tasks.some(
          (task) =>
            !hidden(task) &&
            task.workspaceId &&
            task.lastStage === group.id &&
            !inventory.workspaces.some(
              (workspace) => workspace.id === task.workspaceId,
            ),
        );
        if (
          missingTasks ||
          inventory.workspaces.some(
            (workspace) =>
              workspace.labels.some(
                (label) => labelKey(label) === labelKey(group.label),
              ) ||
              resolveStage(workspace.labels, previous.settings.groups) ===
                group.id,
          )
        )
          throw new Error(
            "Only empty groups can be deleted; move their tasks first",
          );
      }
    }
    await this.store.update((data) => {
      if (!unchanged(data))
        throw new Error("Settings changed; refresh before saving");
      data.settings = next;
    });
  }
  async mutate(input: Mutation): Promise<Board> {
    this.epoch++;
    this.pendingMutations++;
    return this.serial(async () => {
      if (!this.connected)
        throw new Error(this.error ?? "Paseo is disconnected");
      try {
        if (input.action === "create") {
          const stage =
            input.stage ?? defaultGroup(this.store.current.settings.groups);
          if (groupKind(stage, this.store.current.settings.groups) !== "todo")
            throw new Error("Choose a To do group for a new draft");
          await this.store.update((data) => {
            const task = newTask(
              randomUUID(),
              input.title,
              this.stamp(),
              stage,
            );
            task.description = input.description;
            task.projectId = input.projectId;
            task.projectName =
              this.inventory.projects.find((p) => p.id === input.projectId)
                ?.name ?? "";
            data.tasks.push(task);
          });
        } else if (input.action === "settings") {
          await this.saveSettings(
            input.settings,
            input.revision,
            input.expectedSettings,
          );
          await this.reconcile();
          this.changed();
        } else if (input.action === "reorder-groups") {
          const current = orderedGroups(this.store.current.settings).map(
            (group) => group.id,
          );
          const groups = this.store.current.settings.groups;
          if (!sameOrder(input.expectedGroupOrder, current))
            throw new Error("Group order changed; refresh before reordering");
          if (
            input.groupOrder.length !== groups.length ||
            input.groupOrder.some(
              (id) => !groups.some((group) => group.id === id),
            )
          )
            throw new Error("Group order is invalid");
          await this.store.update((data) => {
            const fresh = orderedGroups(data.settings).map((group) => group.id);
            if (!sameOrder(input.expectedGroupOrder, fresh))
              throw new Error("Group order changed; refresh before reordering");
            data.settings.groupOrder = input.groupOrder;
          });
        } else {
          const task = this.task(input.taskId);
          if (hidden(task)) throw new Error("Task is archived");
          if (input.action === "edit") {
            await this.store.update((data) => {
              const current = data.tasks.find((t) => t.id === task.id)!;
              if (current.updatedAt !== input.updatedAt)
                throw new Error("Task changed; refresh before saving");
              if (!current.workspaceId) {
                current.title = input.title;
                current.projectId = input.projectId;
                current.projectName =
                  this.inventory.projects.find((p) => p.id === input.projectId)
                    ?.name ?? "";
              }
              current.description = input.description;
              current.updatedAt = this.stamp(current.updatedAt);
            });
          } else if (input.action === "start") {
            if (!task.binding && task.workspaceId)
              throw new Error("Task already has a workspace");
            const stage =
              input.stage ??
              task.binding?.stage ??
              this.store.current.settings.groups.find(
                (group) => group.kind === "in-progress",
              )?.id;
            if (
              !stage ||
              !this.store.current.settings.groups.some(
                (group) => group.id === stage,
              )
            )
              throw new Error("Add an In progress group before starting work");
            if (isDraftGroup(stage, this.store.current.settings.groups))
              throw new Error(
                "Choose a working or completed group for the workspace",
              );
            if (
              task.binding &&
              (JSON.stringify(task.binding.target) !==
                JSON.stringify(input.target) ||
                task.binding.stage !== stage)
            )
              throw new Error(
                "A previous binding is pending; retry its original target",
              );
            if (!task.binding)
              await this.store.update((data) => {
                data.tasks.find((t) => t.id === task.id)!.binding = {
                  operationId: randomUUID(),
                  target: input.target,
                  workspaceId: null,
                  stage,
                };
              });
            await this.bind(task.id);
            await this.reconcile();
          } else if (input.action === "stage") {
            if (
              !this.store.current.settings.groups.some(
                (group) => group.id === input.stage,
              )
            )
              throw new Error("Group no longer exists");
            if (task.binding)
              throw new Error("Workspace binding is still pending");
            if (task.workspaceId) {
              const workspace = await this.transition(
                task.workspaceId,
                input.stage,
                input.expectedLabels,
              );
              this.inventory.workspaces = this.inventory.workspaces.map((w) =>
                w.id === workspace.id ? workspace : w,
              );
              await this.store.update((data) => {
                const current = data.tasks.find((t) => t.id === task.id)!;
                current.lastStage = input.stage;
                current.updatedAt = this.stamp(current.updatedAt);
                if (current.issue === "labels-conflict") current.issue = null;
              });
              this.changed(workspace.id);
            } else {
              if (
                !isDraftGroup(input.stage, this.store.current.settings.groups)
              )
                throw new Error("Start work and bind a workspace first");
              await this.store.update((data) => {
                const current = data.tasks.find((t) => t.id === task.id)!;
                current.draftStage = input.stage;
                current.lastStage = input.stage;
                current.updatedAt = this.stamp(current.updatedAt);
              });
            }
          } else if (input.action === "archive-draft") {
            if (
              task.workspaceId ||
              groupKind(task.draftStage, this.store.current.settings.groups) !==
                "canceled" ||
              task.binding
            )
              throw new Error(
                "Only canceled, unbound drafts can be archived here",
              );
            await this.store.update((data) => {
              data.tasks.find((t) => t.id === task.id)!.archived = {
                operationId: randomUUID(),
                kind: "draft",
                status: "archived",
                stage: task.draftStage,
                group:
                  data.settings.groups.find(
                    (group) => group.id === task.draftStage,
                  ) ?? null,
                startedAt: this.stamp(),
                archivedAt: this.stamp(),
                lastConversationAt: null,
                detail: "Draft archived; no native workspace",
              };
            });
          }
        }
        return this.snapshot();
      } catch (error) {
        try {
          await this.load();
        } catch (storageError) {
          this.disconnected(message(storageError));
        }
        throw error;
      }
    }).finally(() => {
      this.pendingMutations--;
    });
  }
  private async bind(id: string): Promise<void> {
    const draft = this.task(id);
    const binding = draft.binding;
    if (!binding) return;
    const workspaceId =
      binding.workspaceId ??
      (binding.target.kind === "existing"
        ? binding.target.workspaceId
        : await this.host.create(
            binding.target.source,
            draft.title,
            `workboard:${binding.operationId}`,
          ));
    const workspace = await this.host.workspace(workspaceId);
    if (!workspace) throw new Error("Binding workspace is unavailable");
    let survivorId = id;
    await this.store.update((data) => {
      const current = data.tasks.find((t) => t.id === id)!;
      const imported = data.tasks.find(
        (t) => t.workspaceId === workspaceId && t.id !== id,
      );
      if (binding.target.kind === "existing" && imported) {
        imported.description = [
          imported.description,
          `[${current.title}]\n${current.description}`,
        ]
          .filter(Boolean)
          .join("\n\n");
        imported.binding = { ...binding, workspaceId };
        imported.updatedAt = this.stamp(imported.updatedAt);
        survivorId = imported.id;
        data.tasks = data.tasks.filter((t) => t.id !== id);
      } else {
        if (imported) {
          current.description = [current.description, imported.description]
            .filter(Boolean)
            .join("\n\n");
          data.tasks = data.tasks.filter((t) => t.id !== imported.id);
        }
        if (binding.target.kind === "existing" && !binding.workspaceId)
          current.description = `[${current.title}]\n${current.description}`;
        current.workspaceId = workspaceId;
        current.binding = { ...binding, workspaceId };
        current.updatedAt = this.stamp(current.updatedAt);
      }
    });
    try {
      await this.transition(
        workspaceId,
        binding.stage,
        statusLabels(workspace.labels, this.store.current.settings.groups),
      );
      await this.store.update((data) => {
        const task = data.tasks.find((t) => t.id === survivorId)!;
        task.binding = null;
        task.issue = null;
      });
    } catch (error) {
      await this.issue(survivorId, "label-sync-incomplete");
      throw error;
    }
  }
  private async transition(
    id: string,
    stage: Stage,
    expected: string[],
  ): Promise<Workspace> {
    const mapping = this.store.current.settings.groups;
    const group = mapping.find((group) => group.id === stage);
    if (!group) throw new Error("Group no longer exists");
    let workspace = await this.host.workspace(id);
    if (!workspace || workspace.archivingAt)
      throw new Error("Workspace is unavailable or archiving");
    if (!labelsEqual(statusLabels(workspace.labels, mapping), expected))
      throw new Error(
        "Workspace labels changed; refresh before changing stage",
      );
    const target = group.label;
    let observed = workspace.labels;
    const operations: Array<{ name: string; assigned: boolean }> = [];
    if (!observed.some((name) => labelKey(name) === labelKey(target)))
      operations.push({ name: target, assigned: true });
    for (const name of statusLabels(observed, mapping))
      if (labelKey(name) !== labelKey(target))
        operations.push({ name, assigned: false });
    for (const operation of operations) {
      workspace = await this.host.workspace(id);
      if (
        !workspace ||
        !labelsEqual(
          statusLabels(workspace.labels, mapping),
          statusLabels(observed, mapping),
        )
      )
        throw new Error("Workspace labels changed during synchronization");
      const intended = operation.assigned
        ? [...observed, operation.name]
        : observed.filter(
            (name) => labelKey(name) !== labelKey(operation.name),
          );
      observed = await this.host.setLabel(
        id,
        operation.name,
        STAGE_COLORS[group.kind],
        operation.assigned,
      );
      if (
        !labelsEqual(
          statusLabels(observed, mapping),
          statusLabels(intended, mapping),
        )
      )
        throw new Error("Workspace labels changed during synchronization");
    }
    workspace = await this.host.workspace(id);
    if (!workspace || resolveStage(workspace.labels, mapping) !== stage)
      throw new Error("Label synchronization could not be verified");
    return workspace;
  }
  private issue(id: string, issue: string | null): Promise<void> {
    return this.store.update((data) => {
      const task = data.tasks.find((t) => t.id === id);
      if (task) task.issue = issue;
    });
  }
  private async scan(scope?: ReadonlySet<string>): Promise<void> {
    if (!this.connected || !this.store.current.settings.autoArchive) return;
    for (const candidate of this.store.current.tasks) {
      if (this.stopped || this.pendingMutations > 0) return;
      if (
        !candidate.workspaceId ||
        (scope && !scope.has(candidate.workspaceId)) ||
        candidate.archived ||
        candidate.binding ||
        archiveGate(candidate) === null ||
        !isArchiveDue(
          groupKind(candidate.lastStage, this.store.current.settings.groups),
          archiveGate(candidate),
          this.now(),
        )
      )
        continue;
      const id = candidate.workspaceId;
      const epoch = this.observation(id);
      const inventory = await this.host.inventory();
      const workspace = inventory.workspaces.find((w) => w.id === id);
      if (!workspace || workspace.archivingAt) continue;
      const stage = resolveStage(
        workspace.labels,
        this.store.current.settings.groups,
      );
      const agents = inventory.agents.filter(
        (agent) => agent.workspaceId === id,
      );
      if (
        agents.some(
          (a) =>
            !a.archivedAt &&
            (a.activity === "running" || a.activity === "waiting"),
        ) ||
        workspace.status === "running" ||
        workspace.status === "needs_input"
      ) {
        await this.issue(candidate.id, "agent-busy");
        continue;
      }
      const gate = await this.verifyConversation(candidate, agents);
      if (gate === null) {
        await this.issue(candidate.id, "conversation-unknown");
        continue;
      }
      if (
        !isArchiveDue(
          groupKind(stage, this.store.current.settings.groups),
          gate,
          this.now(),
        )
      )
        continue;
      const safety = await this.host.safety(workspace);
      if (safety) {
        await this.issue(candidate.id, safety);
        continue;
      }
      if (this.stopped || epoch !== this.observation(id)) {
        if (!this.stopped)
          await this.issue(candidate.id, "changed-during-check");
        continue;
      }
      const operationId = randomUUID();
      await this.store.update((data) => {
        data.tasks.find((t) => t.id === candidate.id)!.archived = {
          operationId,
          kind: "automatic",
          status: "pending",
          stage,
          group:
            data.settings.groups.find((group) => group.id === stage) ?? null,
          startedAt: this.stamp(),
          archivedAt: null,
          lastConversationAt: candidate.lastConversationAt,
          detail: "Archive intent persisted; native result not yet known",
        };
      });
      // Storage and safety checks can take time. Re-read membership, labels and Agent state before sending.
      let finalIssue: string | null = null;
      try {
        const fresh = await this.host.inventory();
        const current = fresh.workspaces.find((w) => w.id === id);
        const currentAgents = fresh.agents.filter((a) => a.workspaceId === id);
        const fingerprint = (items: typeof agents) =>
          JSON.stringify(
            items
              .map((a) => [
                a.id,
                a.updatedAt,
                a.lastUserMessageAt,
                a.activity,
                a.archivedAt,
                a.childEnumeration,
              ])
              .sort(),
          );
        if (
          !current ||
          current.archivingAt ||
          current.status === "running" ||
          current.status === "needs_input" ||
          // A refused child listing for an archived parent keeps the gate on its recorded
          // bounds, so it must not defer the archive forever as a state change would.
          resolveStage(current.labels, this.store.current.settings.groups) !==
            stage ||
          !labelsEqual(current.labels, workspace.labels) ||
          fingerprint(currentAgents) !== fingerprint(agents)
        )
          finalIssue = "changed-during-check";
        else finalIssue = await this.host.safety(current);
      } catch {
        finalIssue = "changed-during-check";
      }
      if (this.stopped) return; // Keep the persisted intent uncertain on the next startup.
      if (epoch !== this.observation(id)) finalIssue = "changed-during-check";
      if (finalIssue) {
        await this.store.update((data) => {
          const task = data.tasks.find((t) => t.id === candidate.id)!;
          task.archived = null;
          task.issue = finalIssue;
        });
        continue;
      }
      try {
        const result = await this.host.archive(id);
        if (result.error || !result.archivedAt)
          throw new Error(
            result.error ?? "Native archive returned no timestamp",
          );
        const active = await this.host.inventory();
        this.inventory = active;
        if (active.workspaces.some((w) => w.id === id))
          throw new Error(
            "Native workspace still active after archive response",
          );
        await this.store.update((data) => {
          const task = data.tasks.find((t) => t.id === candidate.id)!;
          task.archived = {
            ...task.archived!,
            status: "archived",
            archivedAt: result.archivedAt,
            detail:
              "Native archive confirmed; worktree cleanup is not independently verified",
          };
          task.issue = null;
        });
      } catch (error) {
        await this.store.update((data) => {
          const task = data.tasks.find((t) => t.id === candidate.id)!;
          task.archived = {
            ...task.archived!,
            status: "uncertain",
            detail: message(error),
          };
          task.issue = "native-archive-unknown";
        });
      }
    }
  }
  dispose(): void {
    this.stopped = true;
    this.epoch++;
    clearInterval(this.timer);
    clearTimeout(this.debounce);
    this.host.dispose();
  }
}
