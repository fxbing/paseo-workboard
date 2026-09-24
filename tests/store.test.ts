import { describe, expect, it } from "vitest";
import { Store } from "../server/store";
import { dataSchema, newTask } from "../shared/model";

function backing() {
  let raw = {
    status: "ready" as const,
    revision: "missing",
    values: dataSchema.parse({}),
  };
  return {
    read: async () => structuredClone(raw),
    write: async (revision: string, values: unknown) => {
      if (revision !== raw.revision)
        return { status: "conflict", error: "Another writer" };
      raw = {
        status: "ready",
        revision: String(
          Number(raw.revision === "missing" ? 0 : raw.revision) + 1,
        ),
        values: dataSchema.parse(values),
      };
      return {
        status: "saved",
        revision: raw.revision,
        values: structuredClone(raw.values),
      };
    },
  };
}
describe("host settings persistence", () => {
  it("preserves drafts and settings when the server restarts", async () => {
    const transport = backing();
    const first = new Store(transport);
    await first.load();
    await first.update((data) => {
      data.tasks.push(newTask("draft-1", "An idea", "2026-09-23T00:00:00Z"));
      data.settings.pinInProgressWorkspaces = false;
    });
    const restarted = new Store(transport);
    await restarted.load();
    expect(restarted.current.tasks.map((t) => t.title)).toEqual(["An idea"]);
    expect(restarted.current.settings.pinInProgressWorkspaces).toBe(false);
  });
  it("serializes updates without dropping a second draft", async () => {
    const store = new Store(backing());
    await store.load();
    await Promise.all(
      ["a", "b"].map((id) =>
        store.update((data) => {
          data.tasks.push(newTask(id, id, "2026-09-23T00:00:00Z"));
        }),
      ),
    );
    expect(store.current.tasks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(store.current.revision).toBe(2);
  });
  it("does not replace corrupt or newer data with empty defaults", async () => {
    let writes = 0;
    const store = new Store({
      read: async () => ({
        status: "ready",
        revision: "v2",
        values: { schemaVersion: dataSchema.parse({}).schemaVersion + 1 },
      }),
      write: async () => {
        writes++;
        return {};
      },
    });
    await expect(store.load()).rejects.toThrow();
    expect(writes).toBe(0);
  });
  it("queues recovery after an in-flight write whose successful response is lost", async () => {
    const transport = backing();
    let rejectWrite: (error: Error) => void = () => {};
    const store = new Store({
      ...transport,
      write: async (revision, values) => {
        await transport.write(revision, values);
        await new Promise<void>((_resolve, reject) => {
          rejectWrite = reject;
        });
      },
    });
    await store.load();
    const write = store.update((data) => {
      data.tasks.push(newTask("a", "Saved", "2026-09-23T00:00:00Z"));
    });
    await new Promise((resolve) => setImmediate(resolve));
    const reload = store.load();
    rejectWrite(new Error("Lost response"));
    await expect(write).rejects.toThrow("Lost response");
    await reload;
    expect(store.current.tasks[0].title).toBe("Saved");
    // A no-op still checks that the store has a usable revision after recovery.
    await expect(store.update(() => {})).resolves.toBeUndefined();
  });
});
