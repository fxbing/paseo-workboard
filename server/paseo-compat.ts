import { randomUUID } from "node:crypto";
import { defineRpc } from "@getpaseo/plugin";
import type {
  PluginHandlerContext,
  PluginServerContext,
} from "@getpaseo/plugin/server";
import { z } from "zod";
import type { TimelineReader } from "./conversations";

// Derive host types through the public SDK so a published plugin needs no client package at runtime.
export type PaseoApi = PluginHandlerContext["paseo"];

export const PLUGIN_ID = "paseo-workboard";
export interface IpcPort {
  on(event: "message", listener: (message: unknown) => void): void;
  off(event: "message", listener: (message: unknown) => void): void;
  send(message: unknown, callback: (error: Error | null) => void): void;
}
const processPort: IpcPort = {
  on: (_event, listener) => process.on("message", listener),
  off: (_event, listener) => {
    process.off("message", listener);
  },
  send: (message, callback) => {
    if (!process.send || !process.connected)
      throw new Error("Paseo plugin IPC unavailable");
    process.send(message as object, callback);
  },
};
type Reply = Record<string, unknown>;
type Pending = {
  type: string;
  resolve: (reply: Reply) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Borrow the host's authenticated session; never hello, reconnect or close it. */
export class PaseoCompat {
  private pending = new Map<string, Pending>();
  private closed = false;
  private listeners = new Set<(type: string, payload?: Reply) => void>();
  readonly nonce = randomUUID();
  constructor(
    private port: IpcPort = processPort,
    private timeout = 15000,
  ) {
    port.on("message", this.receive);
  }
  onChange(listener: (type: string, payload?: Reply) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private receive = (raw: unknown): void => {
    if (!raw || typeof raw !== "object") return;
    const outer = raw as Record<string, unknown>;
    if (outer.type === "paseo_close") {
      this.rejectAll("Paseo disconnected");
      this.notify("disconnected");
      return;
    }
    if (
      outer.type !== "paseo_frame" ||
      outer.isBinary ||
      typeof outer.data !== "string"
    )
      return;
    let frame: unknown;
    try {
      frame = JSON.parse(outer.data);
    } catch {
      return;
    }
    if (
      !frame ||
      typeof frame !== "object" ||
      (frame as Reply).type !== "session"
    )
      return;
    const message = (frame as Reply).message as Reply | undefined;
    if (!message || typeof message.type !== "string") return;
    const payload = message.payload as Reply | undefined;
    const id = payload?.requestId;
    const pending = typeof id === "string" ? this.pending.get(id) : undefined;
    if (pending && typeof id === "string") {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message.type === "rpc_error")
        pending.reject(
          new Error(String(payload?.error ?? "Paseo request failed")),
        );
      else if (message.type !== pending.type)
        pending.reject(new Error("Unexpected Paseo response type"));
      else pending.resolve(payload!);
    }
    if (
      [
        "agent_stream",
        "script_status_update",
        "workspace_setup_progress",
        "agent.timeline.replacement",
      ].includes(message.type)
    )
      this.notify(message.type, payload);
    if (message.type === "status" && payload?.status === "server_info")
      this.notify("connected");
  };
  private notify(type: string, payload?: Reply): void {
    for (const listener of this.listeners) listener(type, payload);
  }
  request(type: string, fields: Reply, responseType: string): Promise<Reply> {
    if (this.closed)
      return Promise.reject(new Error("Workboard bridge closed"));
    const requestId = `workboard:${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const fail = (error: Error) => {
        const item = this.pending.get(requestId);
        if (!item) return;
        clearTimeout(item.timer);
        this.pending.delete(requestId);
        reject(error);
      };
      const timer = setTimeout(
        () => fail(new Error(`Paseo request timed out: ${type}`)),
        this.timeout,
      );
      this.pending.set(requestId, {
        type: responseType,
        resolve,
        reject,
        timer,
      });
      try {
        this.port.send(
          {
            type: "paseo_frame",
            isBinary: false,
            data: JSON.stringify({
              type: "session",
              message: { ...fields, type, requestId },
            }),
          },
          (error) => {
            if (error) fail(error);
          },
        );
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  async invoke(method: string, input: unknown): Promise<unknown> {
    return (
      await this.request(
        "plugin.rpc.invoke.request",
        { pluginId: PLUGIN_ID, method, input },
        "plugin.rpc.invoke.response",
      )
    ).output;
  }
  async identity(): Promise<{ serverId: string; version: string }> {
    const info = z
      .object({ serverId: z.string(), version: z.string() })
      .parse(
        await this.request(
          "daemon.get_status.request",
          {},
          "daemon.get_status.response",
        ),
      );
    return info;
  }
  async setLabel(
    workspaceId: string,
    name: string,
    color: string,
    assigned: boolean,
  ): Promise<string[]> {
    const result = z
      .object({ workspaceLabels: z.array(z.string()) })
      .parse(
        await this.request(
          "workspace.label.assignment.set.request",
          { workspaceId, label: { name, color }, assigned },
          "workspace.label.assignment.set.response",
        ),
      );
    return result.workspaceLabels;
  }
  async setPinned(
    workspaceId: string,
    pinned: boolean,
  ): Promise<string | null> {
    const result = z
      .object({
        workspaceId: z.string(),
        accepted: z.boolean(),
        pinnedAt: z.string().nullable(),
        error: z.string().nullable(),
      })
      .parse(
        await this.request(
          "workspace.pin.set.request",
          { workspaceId, pinned },
          "workspace.pin.set.response",
        ),
      );
    if (result.workspaceId !== workspaceId)
      throw new Error("Paseo workspace pin response workspace mismatch");
    if (!result.accepted || result.error)
      throw new Error(result.error ?? "Paseo workspace pin rejected");
    if (pinned && !result.pinnedAt)
      throw new Error("Paseo did not apply the workspace pin");
    if (!pinned && result.pinnedAt !== null)
      throw new Error("Paseo did not remove the workspace pin");
    return result.pinnedAt;
  }
  async subagents(parentAgentId: string) {
    const result = z
      .object({
        error: z.string().nullable(),
        subagents: z.array(
          z.object({
            id: z.string(),
            title: z.string().nullable(),
            status: z.enum(["running", "completed", "failed", "canceled"]),
            updatedAt: z.string(),
          }),
        ),
      })
      .parse(
        await this.request(
          "agent.provider_subagents.list.request",
          { parentAgentId },
          "agent.provider_subagents.list.response",
        ),
      );
    if (result.error) throw new Error(result.error);
    return result.subagents;
  }
  subagentTimeline(parentAgentId: string, subagentId: string): TimelineReader {
    return async (options) => {
      const cursor = z.object({ epoch: z.string(), seq: z.number() });
      const result = z
        .object({
          epoch: z.string(),
          projection: z.literal("projected"),
          gap: z.boolean(),
          staleCursor: z.boolean(),
          error: z.string().nullable(),
          hasOlder: z.boolean(),
          startCursor: cursor.nullable(),
          window: z.object({ maxSeq: z.number() }),
          rows: z.array(
            z.object({
              timestamp: z.string(),
              item: z.object({ type: z.string() }),
            }),
          ),
        })
        .parse(
          await this.request(
            "agent.provider_subagents.timeline.get.request",
            { parentAgentId, subagentId, ...options },
            "agent.provider_subagents.timeline.get.response",
          ),
        );
      return { ...result, entries: result.rows };
    };
  }
  installBootstrap(server: PluginServerContext): () => Promise<PaseoApi> {
    let api: PaseoApi | undefined;
    server.handle(
      defineRpc({
        name: "workboard.bootstrap",
        input: z.object({ nonce: z.string() }),
        output: z.boolean(),
      }),
      (input, context) => {
        if (input.nonce !== this.nonce)
          throw new Error(
            "Workboard installation mismatch; use the manifest plugin ID",
          );
        api = context.paseo;
        return true;
      },
    );
    return async () => {
      await this.identity();
      await this.invoke("workboard.bootstrap", { nonce: this.nonce });
      if (!api) throw new Error("Paseo did not provide its plugin API");
      return api;
    };
  }
  private rejectAll(reason: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }
  dispose(): void {
    this.closed = true;
    this.port.off("message", this.receive);
    this.rejectAll("Workboard bridge closed");
    this.listeners.clear();
  }
}
