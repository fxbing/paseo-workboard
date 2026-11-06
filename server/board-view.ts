import { randomUUID } from "node:crypto";
import type { Board, ViewVersion } from "../shared/model";
import type { WatchInput, WatchResult } from "../shared/rpc";

export const WATCH_TIMEOUT_MS = 20_000;

/** Publishes complete views; waiting clients never occupy the mutation queue. */
export class BoardView {
  private version: ViewVersion = { instanceId: randomUUID(), revision: 0 };
  private value: Board | undefined;
  private signature: string | undefined;
  private closed = false;
  private waiters = new Map<string, (result: WatchResult) => void>();

  publish(board: Omit<Board, "viewVersion">): Board {
    const { refreshedAt: _refreshedAt, ...content } = board;
    const signature = JSON.stringify(content);
    const changed = signature !== this.signature;
    if (changed) {
      this.version = { ...this.version, revision: this.version.revision + 1 };
      this.signature = signature;
    }
    this.value = structuredClone({ ...board, viewVersion: this.version });
    if (changed)
      for (const finish of [...this.waiters.values()])
        finish({ status: "changed", board: this.snapshot() });
    return this.snapshot();
  }

  snapshot(): Board {
    if (!this.value) throw new Error("Workboard is starting");
    return structuredClone(this.value);
  }

  watch({ after, watcherId }: WatchInput): Promise<WatchResult> {
    if (this.closed) return Promise.reject(new Error("Workboard stopped"));
    // A reconnect may replace an outstanding call whose response was lost.
    this.waiters.get(watcherId)?.(this.unchanged());
    if (
      after.instanceId !== this.version.instanceId ||
      after.revision !== this.version.revision
    )
      return Promise.resolve({ status: "changed", board: this.snapshot() });
    if (this.waiters.size >= 128)
      return Promise.reject(new Error("Too many Workboard observers"));
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => finish(this.unchanged()),
        WATCH_TIMEOUT_MS,
      );
      const finish = (result: WatchResult) => {
        clearTimeout(timer);
        this.waiters.delete(watcherId);
        resolve(result);
      };
      this.waiters.set(watcherId, finish);
    });
  }

  private unchanged(): WatchResult {
    return { status: "unchanged", viewVersion: { ...this.version } };
  }

  dispose(): void {
    this.closed = true;
    for (const finish of [...this.waiters.values()]) finish(this.unchanged());
  }
}
