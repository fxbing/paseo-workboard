import type { QueryClient } from "@tanstack/react-query";
import type { Board } from "../shared/model";
import type { Mutation, WatchInput, WatchResult } from "../shared/rpc";

export interface BoardTransport {
  snapshot(input: { refresh?: boolean }): Promise<Board>;
  watch(input: WatchInput): Promise<WatchResult>;
  mutate(input: Mutation): Promise<Board>;
}

const clientId = Math.random().toString(36).slice(2);
let nextWatcher = 0;

/** One observation per host, shared by the board and settings surfaces. */
export class BoardSync {
  readonly key: readonly [string, string];
  private readonly watcherId = `${clientId}:${++nextWatcher}`;
  private consumers = new Map<object, BoardTransport>();
  private listeners = new Set<() => void>();
  private generation = 0;
  private status: "pending" | "ready" | "error" = "pending";
  private retry: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;

  constructor(
    private cache: QueryClient,
    hostId: string,
  ) {
    this.key = ["workboard", hostId];
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getStatus = () => this.status;

  retain(transport: BoardTransport): () => void {
    const owner = {};
    this.consumers.set(owner, transport);
    if (this.consumers.size === 1) void this.refresh(false);
    return () => {
      this.consumers.delete(owner);
      if (!this.consumers.size) this.pause();
    };
  }

  private transport(): BoardTransport {
    const transport = this.consumers.values().next().value;
    if (!transport) throw new Error("Paseo is disconnected");
    return transport;
  }

  private current(): Board | undefined {
    return this.cache.getQueryData<Board>(this.key);
  }

  private setStatus(status: "pending" | "ready" | "error"): void {
    if (this.status === status) return;
    this.status = status;
    for (const listener of this.listeners) listener();
  }

  private active(generation: number): boolean {
    return this.consumers.size > 0 && generation === this.generation;
  }

  private accept(next: Board, instanceId: string | undefined): boolean {
    const current = this.current();
    if (current) {
      if (current.viewVersion.instanceId === next.viewVersion.instanceId) {
        if (current.viewVersion.revision > next.viewVersion.revision)
          return false;
      } else if (current.viewVersion.instanceId !== instanceId) return false;
    }
    this.cache.setQueryData(this.key, next);
    return true;
  }

  async refresh(force = true): Promise<void> {
    if (!this.consumers.size) return;
    clearTimeout(this.retry);
    const generation = ++this.generation;
    const instanceId = this.current()?.viewVersion.instanceId;
    this.setStatus("pending");
    try {
      const board = await this.transport().snapshot(
        force ? { refresh: true } : {},
      );
      if (!this.active(generation)) return;
      this.accept(board, instanceId);
      this.setStatus("ready");
      void this.follow(generation);
    } catch {
      this.reconnect(generation);
    }
  }

  private async follow(generation: number): Promise<void> {
    while (this.active(generation)) {
      const board = this.current();
      if (!board) return;
      try {
        const result = await this.transport().watch({
          after: board.viewVersion,
          watcherId: this.watcherId,
        });
        if (!this.active(generation)) return;
        if (result.status === "changed")
          this.accept(result.board, board.viewVersion.instanceId);
        this.failures = 0;
        this.setStatus("ready");
      } catch {
        this.reconnect(generation);
        return;
      }
    }
  }

  private reconnect(generation: number): void {
    if (!this.active(generation)) return;
    this.setStatus("error");
    const delay = Math.min(1_000 * 2 ** this.failures++, 10_000);
    this.retry = setTimeout(() => {
      if (this.active(generation)) void this.refresh(false);
    }, delay);
  }

  async mutate(input: Mutation): Promise<Board> {
    const generation = this.generation;
    const instanceId = this.current()?.viewVersion.instanceId;
    const next = await this.transport().mutate(input);
    if (this.active(generation)) {
      const currentInstance = this.current()?.viewVersion.instanceId;
      if (
        currentInstance !== instanceId &&
        currentInstance !== next.viewVersion.instanceId
      )
        throw new Error("Workboard connection changed");
      this.accept(next, instanceId);
    }
    return next;
  }

  private pause(): void {
    this.generation++;
    clearTimeout(this.retry);
  }

  dispose(): void {
    this.consumers.clear();
    this.pause();
    this.listeners.clear();
  }
}

const clients = new WeakMap<QueryClient, Map<string, BoardSync>>();
export function workboardSync(cache: QueryClient, hostId: string): BoardSync {
  let hosts = clients.get(cache);
  if (!hosts) clients.set(cache, (hosts = new Map()));
  let sync = hosts.get(hostId);
  if (!sync) hosts.set(hostId, (sync = new BoardSync(cache, hostId)));
  return sync;
}

export function disposeWorkboardSync(cache: QueryClient): void {
  for (const sync of clients.get(cache)?.values() ?? []) sync.dispose();
  clients.delete(cache);
}
