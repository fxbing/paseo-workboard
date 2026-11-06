import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useHosts, useRpc } from "@getpaseo/plugin/client";
import type { Board } from "../shared/model";
import { mutateRpc, snapshotRpc, watchRpc, type Mutation } from "../shared/rpc";
import { workboardSync } from "./board-sync";

declare const document: {
  visibilityState: string;
  addEventListener(name: string, callback: () => void): void;
  removeEventListener(name: string, callback: () => void): void;
};
const visible = () =>
  typeof document === "undefined" || document.visibilityState !== "hidden";

export function nextBoardClockDelay(
  board: Board | undefined,
  now: number,
): number {
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  let next = midnight.getTime();
  for (const card of board?.cards ?? []) {
    for (const at of [card.dueAt, card.recheckAt]) {
      if (!at) continue;
      const time = Date.parse(at) - (board?.clockOffsetMs ?? 0);
      if (time >= now && time < next) next = time;
    }
  }
  return Math.max(1, next - now + 1);
}

export function useWorkboard(hostId: string) {
  const cache = useQueryClient();
  const sync = workboardSync(cache, hostId);
  const snapshot = useRpc(snapshotRpc);
  const watch = useRpc(watchRpc);
  const mutation = useRpc(mutateRpc);
  const transport = useMemo(
    () => ({ snapshot, watch, mutate: mutation }),
    [snapshot, watch, mutation],
  );
  const online = useHosts().some(
    (host) => host.serverId === hostId && host.status === "online",
  );
  const [isVisible, setVisible] = useState(visible);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const changed = () => setVisible(visible());
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  useEffect(() => {
    if (!online || !isVisible) return;
    return sync.retain(transport);
  }, [sync, transport, online, isVisible]);
  const status = useSyncExternalStore(
    sync.subscribe,
    sync.getStatus,
    sync.getStatus,
  );
  const query = useQuery<Board>({
    queryKey: sync.key,
    queryFn: () => snapshot({}),
    enabled: false,
  });
  const [clockTick, setClockTick] = useState(0);
  useEffect(() => {
    if (!isVisible) return;
    const timer = setTimeout(
      () => setClockTick((value) => value + 1),
      nextBoardClockDelay(query.data, Date.now()),
    );
    return () => clearTimeout(timer);
  }, [query.data, clockTick, isVisible]);
  const mutate = useCallback((input: Mutation) => sync.mutate(input), [sync]);
  const refetch = useCallback(() => sync.refresh(), [sync]);
  return {
    data: query.data,
    isPending: !query.data && online && status !== "error",
    isError: status !== "ready" || !online || !isVisible,
    refetch,
    mutate,
  };
}
