import { defineSettings } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { DATA_SCHEMA_VERSION, dataSchema } from "./shared/model";
import {
  migrateData,
  InvalidStorageDataError,
  UNSUPPORTED_STORAGE_VERSION_ERROR_CODE,
  UnsupportedStorageVersionError,
} from "./shared/migrations";
import { mutateRpc, snapshotRpc, watchRpc } from "./shared/rpc";
import { PaseoCompat } from "./server/paseo-compat";
import { PaseoHost } from "./server/host";
import { Store } from "./server/store";
import { workboardClock } from "./server/test-clock";
import { Workboard } from "./server/workboard";

export function classifyBootFailure(failure: unknown): {
  deterministic: boolean;
  error: string;
} {
  const deterministic =
    failure instanceof UnsupportedStorageVersionError ||
    failure instanceof InvalidStorageDataError;
  return {
    deterministic,
    error: failure instanceof Error ? failure.message : String(failure),
  };
}

export default function contribute(server: PluginServerContext) {
  const compat = new PaseoCompat();
  const bootstrap = compat.installBootstrap(server);
  const settings = server.registerSettings(
    defineSettings({
      id: "workboard-data",
      version: DATA_SCHEMA_VERSION,
      scope: "host",
      schema: dataSchema,
      migrate: migrateData,
    }),
  );
  const store = new Store({
    read: async () => {
      const result = await settings.read();
      if (result.status === "invalid") {
        if (result.error.includes(UNSUPPORTED_STORAGE_VERSION_ERROR_CODE))
          throw new UnsupportedStorageVersionError();
        throw new InvalidStorageDataError();
      }
      const version =
        result.values &&
        typeof result.values === "object" &&
        "schemaVersion" in result.values
          ? result.values.schemaVersion
          : undefined;
      if (typeof version === "number" && version !== DATA_SCHEMA_VERSION)
        throw new UnsupportedStorageVersionError();
      if (!dataSchema.safeParse(result.values).success)
        throw new InvalidStorageDataError();
      return result;
    },
    write: (revision, values) =>
      compat.invoke("settings.workboard-data.write", { revision, values }),
  });
  let board: Workboard | undefined;
  let disposed = false;
  let error = "Workboard is starting";
  let retry: ReturnType<typeof setTimeout> | undefined;
  const stopSettings = settings.subscribe((state) => {
    if (state.status === "invalid") board?.disconnected(state.error);
    else
      void board?.settingsChanged(state.revision).catch((failure) => {
        board?.disconnected(
          failure instanceof Error ? failure.message : String(failure),
        );
      });
  });
  const stopChange = compat.onChange((type) => {
    if (type === "disconnected") board?.disconnected();
    else board?.changed();
  });
  const boot = async () => {
    try {
      const api = await bootstrap();
      if (disposed) return;
      const identity = await compat.identity();
      board?.dispose();
      const host = new PaseoHost(
        api,
        compat,
        identity,
        (id, agentsChanged, conversationChanged) =>
          agentsChanged
            ? board?.agentsChanged(id)
            : board?.changed(id, conversationChanged),
      );
      const clock = workboardClock();
      board = new Workboard(
        host,
        store,
        clock.now,
        undefined,
        () => clock.offsetMs,
      );
      await board.start();
    } catch (failure) {
      const classified = classifyBootFailure(failure);
      error = classified.error;
      board?.disconnected(error);
      if (classified.deterministic) {
        stopChange();
        board?.dispose();
      }
      console.error(
        "Workboard startup failed:",
        failure instanceof Error ? failure.message : String(failure),
      );
      if (!disposed && !classified.deterministic)
        retry = setTimeout(() => {
          void boot();
        }, 10000);
    }
  };
  server.handle(snapshotRpc, (input = {}) => {
    if (!board) throw new Error(error);
    const current = board;
    return input.refresh
      ? current.refresh().then(() => current.snapshot())
      : current.snapshot();
  });
  server.handle(watchRpc, (input) => {
    if (!board) throw new Error(error);
    return board.watch(input);
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
    stopSettings();
    board?.dispose();
    compat.dispose();
  };
}
