import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  BoardSync,
  disposeWorkboardSync,
  workboardSync,
  type BoardTransport,
} from "../client/board-sync";
import { nextBoardClockDelay } from "../client/use-workboard";
import { boardSchema, type Board } from "../shared/model";
import type { WatchInput, WatchResult } from "../shared/rpc";

const caches: QueryClient[] = [];
const subscriptions: Array<() => void> = [];
function board(revision = 1, instanceId = "instance-a"): Board {
  return boardSchema.parse({
    viewVersion: { revision, instanceId },
    revision: 7,
    serverId: "host",
    version: "0.15.2",
    connected: true,
    error: null,
    refreshedAt: null,
    settings: {},
    cards: [],
    projects: [],
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(hostId = "host") {
  const cache = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity } },
  });
  caches.push(cache);
  const requests: Array<ReturnType<typeof deferred<WatchResult>>> = [];
  const transport = {
    snapshot: vi.fn(async () => board()),
    watch: vi.fn((_input: WatchInput) => {
      const call = deferred<WatchResult>();
      requests.push(call);
      return call.promise;
    }),
    mutate: vi.fn(async () => board()),
  } satisfies BoardTransport;
  const sync = workboardSync(cache, hostId);
  subscriptions.push(sync.retain(transport));
  return {
    cache,
    sync,
    transport,
    requests,
    current: () => cache.getQueryData<Board>(sync.key)!,
  };
}
const flush = () => vi.advanceTimersByTimeAsync(0);
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-06T12:00:00Z"));
});
afterEach(() => {
  for (const release of subscriptions.splice(0)) release();
  for (const cache of caches.splice(0)) {
    disposeWorkboardSync(cache);
    cache.clear();
  }
  vi.useRealTimers();
});

it("shares one host observation and follows unchanged replies without fetching another Board", async () => {
  const test = fixture();
  test.transport.watch.mockImplementation(
    (input) =>
      new Promise((resolve) => {
        setTimeout(
          () => resolve({ status: "unchanged", viewVersion: input.after }),
          20_000,
        );
      }),
  );
  const second = workboardSync(test.cache, "host");
  expect(second).toBe(test.sync);
  const releaseSecond = second.retain(test.transport);
  await flush();
  await vi.advanceTimersByTimeAsync(65_000);
  expect(test.transport.snapshot).toHaveBeenCalledExactlyOnceWith({});
  expect(test.transport.watch).toHaveBeenCalledTimes(4);
  expect(
    new Set(test.transport.watch.mock.calls.map(([input]) => input.watcherId))
      .size,
  ).toBe(1);
  releaseSecond();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(test.transport.watch).toHaveBeenCalledTimes(5);
  subscriptions.pop()!();
  await vi.advanceTimersByTimeAsync(40_000);
  expect(test.transport.watch).toHaveBeenCalledTimes(5);
});

it("accepts runtime-only versions and keeps newer watch data when mutations finish out of order", async () => {
  const test = fixture();
  await flush();
  const earlier = deferred<Board>();
  const later = deferred<Board>();
  test.transport.mutate
    .mockReturnValueOnce(earlier.promise)
    .mockReturnValueOnce(later.promise);
  const a = test.sync.mutate({
    action: "create",
    title: "A",
    description: "",
    projectId: null,
  });
  const b = test.sync.mutate({
    action: "create",
    title: "B",
    description: "",
    projectId: null,
  });
  const runtime = { ...board(4), connected: false, error: "Disconnected" };
  test.requests[0].resolve({ status: "changed", board: runtime });
  await flush();
  expect(test.current()).toEqual(runtime);
  later.resolve(board(3));
  await b;
  earlier.resolve(board(2));
  await a;
  expect(test.current()).toEqual(runtime);
  expect(test.current().revision).toBe(7);
});

it("does not restore an old instance when its mutation reply follows a restart notification", async () => {
  const test = fixture();
  await flush();
  const old = deferred<Board>();
  test.transport.mutate.mockReturnValueOnce(old.promise);
  const pending = test.sync.mutate({
    action: "create",
    title: "A",
    description: "",
    projectId: null,
  });
  const rejected = expect(pending).rejects.toThrow("connection changed");
  test.requests[0].resolve({
    status: "changed",
    board: board(1, "instance-b"),
  });
  await flush();
  old.resolve(board(99));
  await rejected;
  expect(test.current().viewVersion).toEqual({
    instanceId: "instance-b",
    revision: 1,
  });
});

it("ignores a late snapshot and watch after pause, then revalidates before following again", async () => {
  const test = fixture();
  await flush();
  subscriptions.pop()!();
  const resume = deferred<Board>();
  test.transport.snapshot.mockReturnValueOnce(resume.promise);
  subscriptions.push(test.sync.retain(test.transport));
  test.requests[0].resolve({ status: "changed", board: board(99) });
  await flush();
  expect(test.current().viewVersion.revision).toBe(1);
  expect(test.sync.getStatus()).toBe("pending");
  resume.resolve(board(1, "instance-b"));
  await flush();
  expect(test.current().viewVersion.instanceId).toBe("instance-b");
  expect(test.sync.getStatus()).toBe("ready");
  const refresh = deferred<Board>();
  test.transport.snapshot.mockReturnValueOnce(refresh.promise);
  void test.sync.refresh();
  subscriptions.pop()!();
  refresh.resolve(board(100));
  await flush();
  expect(test.current().viewVersion.instanceId).toBe("instance-b");
});

it("retains data on a failed watch and reconnects with bounded backoff", async () => {
  const test = fixture();
  await flush();
  test.requests[0].reject(new Error("Connection closed"));
  await flush();
  expect(test.sync.getStatus()).toBe("error");
  expect(test.current()).toEqual(board());
  expect(test.transport.snapshot).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(test.transport.snapshot).toHaveBeenCalledTimes(2);
  expect(test.sync.getStatus()).toBe("ready");
  expect(test.transport.watch.mock.calls[1][0].watcherId).toBe(
    test.transport.watch.mock.calls[0][0].watcherId,
  );
});

it("backs off repeated watch failures even when snapshots succeed, and resets after a healthy watch", async () => {
  const test = fixture();
  await flush();
  for (const [index, delay] of [1_000, 2_000, 4_000, 8_000, 10_000].entries()) {
    test.requests[index].reject(new Error("Observation unavailable"));
    await flush();
    expect(test.sync.getStatus()).toBe("error");
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(test.transport.snapshot).toHaveBeenCalledTimes(index + 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(test.transport.snapshot).toHaveBeenCalledTimes(index + 2);
  }
  test.requests[5].resolve({
    status: "unchanged",
    viewVersion: board().viewVersion,
  });
  await flush();
  test.requests[6].reject(new Error("Another disconnect"));
  await flush();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(test.transport.snapshot).toHaveBeenCalledTimes(7);
});

it("uses a fresh directory read for manual refresh and keeps host caches separate", async () => {
  const a = fixture("host-a");
  const b = new BoardSync(a.cache, "host-b");
  subscriptions.push(
    b.retain({ ...a.transport, snapshot: async () => board(1, "host-b") }),
  );
  await flush();
  await a.sync.refresh();
  expect(a.transport.snapshot).toHaveBeenLastCalledWith({ refresh: true });
  expect(a.cache.getQueryData<Board>(b.key)?.viewVersion.instanceId).toBe(
    "host-b",
  );
  expect(a.current().viewVersion.instanceId).toBe("instance-a");
});

it("schedules local date and due boundaries independently of network traffic", () => {
  const now = new Date(2026, 10, 6, 23, 59, 59).getTime();
  expect(nextBoardClockDelay(board(), now)).toBe(1_001);
  const due = {
    ...board(),
    clockOffsetMs: 1_000,
    cards: [{ dueAt: new Date(now + 1_500).toISOString() }],
  } as Board;
  expect(nextBoardClockDelay(due, now)).toBe(501);
  expect(nextBoardClockDelay(due, now + 501)).toBe(500);
});
