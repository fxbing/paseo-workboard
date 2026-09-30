import { defineSettings } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { dataSchema } from "./shared/model";
import { migrateData } from "./shared/migrations";
import { mutateRpc, snapshotRpc } from "./shared/rpc";
import { PaseoCompat } from "./server/paseo-compat";
import { PaseoHost } from "./server/host";
import { Store } from "./server/store";
import { Workboard } from "./server/workboard";

export default function contribute(server: PluginServerContext) {
  const compat = new PaseoCompat();
  const bootstrap = compat.installBootstrap(server);
  const settings = server.registerSettings(
    defineSettings({
      id: "workboard-data",
      version: 6,
      scope: "host",
      schema: dataSchema,
      migrate: migrateData,
    }),
  );
  const store = new Store({
    read: () => settings.read(),
    write: (revision, values) =>
      compat.invoke("settings.workboard-data.write", { revision, values }),
  });
  let board: Workboard | undefined;
  let disposed = false;
  let error = "Workboard is starting";
  let retry: ReturnType<typeof setTimeout> | undefined;
  const stopChange = compat.onChange((type, payload) => {
    if (type === "disconnected") board?.disconnected();
    else if (typeof payload?.agentId === "string")
      board?.agentChanged(payload.agentId);
    else
      board?.changed(
        typeof payload?.workspaceId === "string"
          ? payload.workspaceId
          : undefined,
      );
  });
  const boot = async () => {
    try {
      const api = await bootstrap();
      if (disposed) return;
      const identity = await compat.identity();
      board?.dispose();
      const host = new PaseoHost(api, compat, identity, (id) =>
        board?.changed(id),
      );
      board = new Workboard(host, store);
      await board.start();
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
      board?.disconnected(error);
      console.error("Workboard startup failed:", error);
      if (!disposed)
        retry = setTimeout(() => {
          void boot();
        }, 10000);
    }
  };
  server.handle(snapshotRpc, () => {
    if (!board) throw new Error(error);
    return board.snapshot();
  });
  server.handle(mutateRpc, (input) => {
    if (!board) throw new Error(error);
    return board.mutate(input);
  });
  // The host must mark this contribution ready before it can dispatch the bootstrap self-RPC.
  const immediate = setImmediate(() => {
    void boot();
  });
  return () => {
    disposed = true;
    clearImmediate(immediate);
    clearTimeout(retry);
    stopChange();
    board?.dispose();
    compat.dispose();
  };
}
