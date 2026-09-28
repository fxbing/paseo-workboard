import { EventEmitter } from "node:events";
import { expect, it } from "vitest";
import { PaseoCompat, type IpcPort } from "../server/paseo-compat";

function port() {
  const events = new EventEmitter();
  const sent: Record<string, unknown>[] = [];
  const value: IpcPort = {
    on: (_e, fn) => {
      events.on("message", fn);
    },
    off: (_e, fn) => {
      events.off("message", fn);
    },
    send: (m, cb) => {
      sent.push(m as Record<string, unknown>);
      cb(null);
    },
  };
  const respond = (
    index: number,
    type: string,
    extra: Record<string, unknown> = {},
  ) => {
    const request = JSON.parse(sent[index].data as string).message;
    events.emit("message", {
      type: "paseo_frame",
      isBinary: false,
      data: JSON.stringify({
        type: "session",
        message: { type, payload: { requestId: request.requestId, ...extra } },
      }),
    });
  };
  return { value, events, sent, respond };
}
it("correlates reversed replies without interfering with the host session", async () => {
  const p = port();
  const bridge = new PaseoCompat(p.value);
  const first = bridge.request("first.request", {}, "first.response");
  const second = bridge.request("second.request", {}, "second.response");
  p.respond(1, "second.response", { value: 2 });
  p.respond(0, "first.response", { value: 1 });
  expect((await first).value).toBe(1);
  expect((await second).value).toBe(2);
  bridge.dispose();
  expect(p.sent).toHaveLength(2);
  expect(p.events.listenerCount("message")).toBe(0);
});
it("accepts a newer daemon identity and propagates RPC permission errors", async () => {
  const p = port();
  const bridge = new PaseoCompat(p.value);
  const version = bridge.identity();
  p.respond(0, "daemon.get_status.response", {
    serverId: "test",
    version: "0.10.0-beta.1",
  });
  await expect(version).resolves.toEqual({
    serverId: "test",
    version: "0.10.0-beta.1",
  });
  const write = bridge.setLabel("w", "task:done", "emerald", true);
  p.respond(1, "rpc_error", { error: "Permission denied" });
  await expect(write).rejects.toThrow("Permission denied");
  bridge.dispose();
});
it("writes the native workspace pin frame and returns its timestamp", async () => {
  const p = port();
  const bridge = new PaseoCompat(p.value);
  const pin = bridge.setPinned("workspace-1", true);
  expect(JSON.parse(p.sent[0].data as string).message).toMatchObject({
    type: "workspace.pin.set.request",
    workspaceId: "workspace-1",
    pinned: true,
  });
  p.respond(0, "workspace.pin.set.response", {
    workspaceId: "workspace-1",
    accepted: true,
    pinnedAt: "2026-09-24T01:02:03.000Z",
    error: null,
  });
  await expect(pin).resolves.toBe("2026-09-24T01:02:03.000Z");
  bridge.dispose();
});
it("rejects a native pin response that the daemon declined", async () => {
  const p = port();
  const bridge = new PaseoCompat(p.value);
  const pin = bridge.setPinned("workspace-1", true);
  p.respond(0, "workspace.pin.set.response", {
    workspaceId: "workspace-1",
    accepted: false,
    pinnedAt: null,
    error: "Workspace not found",
  });
  await expect(pin).rejects.toThrow("Workspace not found");
  bridge.dispose();
});
it("rejects a pin response for another workspace", async () => {
  const p = port();
  const bridge = new PaseoCompat(p.value);
  const pin = bridge.setPinned("workspace-1", false);
  p.respond(0, "workspace.pin.set.response", {
    workspaceId: "workspace-2",
    accepted: true,
    pinnedAt: null,
    error: null,
  });
  await expect(pin).rejects.toThrow("workspace mismatch");
  bridge.dispose();
});
it("rejects a closed session request and resumes only after the host restores its session", async () => {
  const p = port();
  const bridge = new PaseoCompat(p.value);
  const events: string[] = [];
  bridge.onChange((type) => events.push(type));
  const pending = bridge.request("old", {}, "reply");
  p.events.emit("message", { type: "paseo_close" });
  await expect(pending).rejects.toThrow("disconnected");
  // The host DaemonClient owns hello/reconnect. The bridge observes its new server_info.
  p.events.emit("message", {
    type: "paseo_frame",
    data: JSON.stringify({
      type: "session",
      message: { type: "status", payload: { status: "server_info" } },
    }),
  });
  const next = bridge.request("new", {}, "reply");
  p.respond(1, "reply", { ok: true });
  expect(await next).toMatchObject({ ok: true });
  expect(events).toEqual(["disconnected", "connected"]);
  expect(p.sent).toHaveLength(2);
  bridge.dispose();
});
it("rejects pending operations on disposal without closing the shared IPC session", async () => {
  const p = port();
  const bridge = new PaseoCompat(p.value);
  const pending = bridge.request("read", {}, "response");
  bridge.dispose();
  await expect(pending).rejects.toThrow("closed");
  expect(p.sent).toHaveLength(1);
});
it("preserves the provider subagent identity and projected timestamps across raw RPC", async () => {
  const p = port();
  const bridge = new PaseoCompat(p.value);
  const listed = bridge.subagents("parent");
  expect(JSON.parse(p.sent[0].data as string).message).toMatchObject({
    type: "agent.provider_subagents.list.request",
    parentAgentId: "parent",
  });
  p.respond(0, "agent.provider_subagents.list.response", {
    parentAgentId: "parent",
    error: null,
    subagents: [
      {
        id: "child",
        title: "Worker",
        status: "completed",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-02T00:00:00.000Z",
        toolCallId: null,
      },
    ],
  });
  await expect(listed).resolves.toEqual([
    {
      id: "child",
      title: "Worker",
      status: "completed",
      updatedAt: "2026-08-02T00:00:00.000Z",
    },
  ]);

  const read = bridge.subagentTimeline("parent", "child");
  const page = read({ direction: "tail", limit: 200 });
  expect(JSON.parse(p.sent[1].data as string).message).toMatchObject({
    type: "agent.provider_subagents.timeline.get.request",
    parentAgentId: "parent",
    subagentId: "child",
    direction: "tail",
    limit: 200,
  });
  p.respond(1, "agent.provider_subagents.timeline.get.response", {
    parentAgentId: "parent",
    subagentId: "child",
    provider: "workboard-fixture",
    direction: "tail",
    epoch: "epoch-1",
    projection: "projected",
    startCursor: null,
    endCursor: null,
    reset: false,
    staleCursor: false,
    gap: false,
    window: { minSeq: 0, maxSeq: 2, nextSeq: 3 },
    hasOlder: false,
    hasNewer: false,
    error: null,
    rows: [
      {
        timestamp: "2026-08-02T00:00:00.000Z",
        seq: 2,
        seqStart: 2,
        seqEnd: 2,
        sourceSeqRanges: [],
        item: { type: "assistant_message" },
      },
    ],
  });
  await expect(page).resolves.toMatchObject({
    projection: "projected",
    entries: [
      {
        timestamp: "2026-08-02T00:00:00.000Z",
        item: { type: "assistant_message" },
      },
    ],
  });
  bridge.dispose();
});
