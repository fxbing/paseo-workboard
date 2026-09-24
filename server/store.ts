import { dataSchema, type Data } from "../shared/model";
import { z } from "zod";
export interface SettingsBacking {
  read(): Promise<unknown>;
  write(revision: string, values: Data): Promise<unknown>;
}
const readResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    revision: z.string(),
    values: dataSchema,
  }),
  z.object({ status: z.literal("invalid"), error: z.string() }),
]);
const writeResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("saved"),
    revision: z.string(),
    values: dataSchema,
  }),
  z.object({ status: z.literal("invalid"), error: z.string() }),
  z.object({ status: z.literal("conflict"), error: z.string() }),
]);
export class Store {
  private value: Data = dataSchema.parse({});
  private revision: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private backing: SettingsBacking) {}
  get current(): Data {
    return structuredClone(this.value);
  }
  load(): Promise<void> {
    const work = this.queue.then(async () => {
      const loaded = readResult.parse(await this.backing.read());
      if (loaded.status !== "ready") throw new Error(loaded.error);
      this.value = loaded.values;
      this.revision = loaded.revision;
    });
    this.queue = work.catch(() => undefined);
    return work;
  }
  update(change: (data: Data) => void): Promise<void> {
    const work = this.queue.then(async () => {
      if (this.revision === null) throw new Error("Storage is unavailable");
      const next = this.current;
      change(next);
      if (JSON.stringify(next) === JSON.stringify(this.value)) return;
      next.revision = this.value.revision + 1;
      const parsed = dataSchema.parse(next);
      try {
        const saved = writeResult.parse(
          await this.backing.write(this.revision, parsed),
        );
        if (saved.status !== "saved") throw new Error(saved.error);
        this.value = saved.values;
        this.revision = saved.revision;
      } catch (error) {
        // The host may have saved even if the reply was lost. Require a read before more writes.
        this.revision = null;
        throw error;
      }
    });
    this.queue = work.catch(() => undefined);
    return work;
  }
}
