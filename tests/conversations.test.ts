import { expect, it } from "vitest";
import {
  readConversationTime,
  type TimelinePage,
} from "../server/conversations";

const now = Date.parse("2026-09-23T00:00:00Z");
const observed = "2026-09-22T23:00:00Z";

function page(
  items: Array<[string, string]>,
  hasOlder = false,
  seq = 1,
): TimelinePage {
  return {
    epoch: "e",
    gap: false,
    staleCursor: false,
    error: null,
    hasOlder,
    startCursor: { epoch: "e", seq },
    window: { maxSeq: 300 },
    entries: items.map(([type, timestamp]) => ({ item: { type }, timestamp })),
  };
}

it("reads past a tools-only tail and counts the later assistant response", async () => {
  const requests: string[] = [];
  const read = await readConversationTime(
    async (options) => {
      requests.push(options.direction);
      return options.direction === "tail"
        ? page([["tool_call", "2026-09-22T00:00:00Z"]], true, 200)
        : page([
            ["user_message", "2026-08-01T00:00:00Z"],
            ["assistant_message", "2026-08-02T00:00:00Z"],
          ]);
    },
    { now },
  );
  expect(read).toEqual({
    latest: "2026-08-02T00:00:00.000Z",
    messages: 2,
    replayStamped: 0,
    reproduced: false,
    pages: 2,
    truncated: false,
  });
  expect(requests).toEqual(["tail", "before"]);
});

it("stops at the tail page once it holds a message row", async () => {
  const requests: string[] = [];
  const read = await readConversationTime(
    async (options) => {
      requests.push(options.direction);
      return page(
        [
          ["tool_call", "2026-09-22T10:00:00Z"],
          ["assistant_message", "2026-09-22T09:00:00Z"],
          ["user_message", "2026-09-22T08:00:00Z"],
        ],
        true,
        200,
      );
    },
    { now },
  );
  expect(read.latest).toBe("2026-09-22T09:00:00.000Z");
  expect(read.pages).toBe(1);
  expect(requests).toEqual(["tail"]);
});

it("refuses a changed epoch, gaps, a failed history request and unusable timestamps", async () => {
  for (const bad of [
    { ...page([]), gap: true },
    { ...page([]), error: "Provider unavailable" },
    { ...page([]), staleCursor: true },
    page([["user_message", "2099-01-01T00:00:00Z"]]),
    page([["assistant_message", "broken"]]),
  ]) {
    await expect(
      readConversationTime(async () => bad, { now }),
    ).rejects.toThrow();
  }
  let n = 0;
  await expect(
    readConversationTime(
      async () => (++n === 1 ? page([], true) : { ...page([]), epoch: "new" }),
      { now },
    ),
  ).rejects.toThrow();
  await expect(
    readConversationTime(
      async () => page([["tool_call", "2026-09-22T00:00:00Z"]], true, 200),
      { now },
    ),
  ).rejects.toThrow();
});

it("drops hydration-stamped rows instead of failing the whole read", async () => {
  const hydrated = await readConversationTime(
    async () =>
      page([
        ["user_message", "2026-09-22T23:55:00Z"],
        ["assistant_message", "2026-09-22T23:56:00Z"],
      ]),
    { now, observedUpdatedAt: observed },
  );
  expect(hydrated).toEqual({
    latest: null,
    messages: 0,
    replayStamped: 2,
    reproduced: false,
    pages: 1,
    truncated: false,
  });

  const partial = await readConversationTime(
    async () =>
      page([
        ["assistant_message", "2026-09-22T23:56:00Z"],
        ["user_message", "2026-09-20T08:00:00Z"],
        ["assistant_message", "2026-09-20T09:00:00Z"],
      ]),
    { now, observedUpdatedAt: observed },
  );
  expect(partial.latest).toBe("2026-09-20T09:00:00.000Z");
  expect(partial.replayStamped).toBe(1);
  expect(partial.messages).toBe(2);
});

it("downgrades a rewind re-projection whose stamps match the record", async () => {
  const stamped = "2026-09-22T22:59:30Z";
  const read = await readConversationTime(
    async () =>
      page([
        ["user_message", stamped],
        ["assistant_message", stamped],
        ["assistant_message", stamped],
      ]),
    {
      now,
      observedUpdatedAt: stamped,
      // A live user row carries the recorded user-message time; this one does not.
      observedUserMessageAt: "2026-09-20T08:00:00Z",
    },
  );
  // Observed rows stay a bound for the display and the gate.
  expect(read).toEqual({
    latest: "2026-09-22T22:59:30.000Z",
    messages: 3,
    replayStamped: 0,
    reproduced: true,
    pages: 1,
    truncated: false,
  });
});

it("downgrades a per-row re-stamped batch with the recorded user message", async () => {
  const read = await readConversationTime(
    async () =>
      page([
        ["user_message", "2026-09-22T23:00:00.100Z"],
        ["assistant_message", "2026-09-22T23:00:00.400Z"],
      ]),
    {
      now,
      // Paseo stamps each replayed row with its own hydration moment.
      observedUpdatedAt: "2026-09-22T23:00:00.500Z",
      observedUserMessageAt: "2026-09-20T08:00:00Z",
    },
  );
  expect(read.reproduced).toBe(true);
  expect(read.replayStamped).toBe(0);
  expect(read.latest).toBe("2026-09-22T23:00:00.400Z");
});

it("keeps a live batch exact when its rows match the recorded user message", async () => {
  const read = await readConversationTime(
    async () =>
      page([
        ["user_message", "2026-09-20T08:00:00.000Z"],
        ["assistant_message", "2026-09-20T08:00:00.000Z"],
        ["assistant_message", "2026-09-20T08:00:00.000Z"],
      ]),
    {
      now,
      // Codex-style rows share one real stamp, so equal stamps alone cannot mean replay.
      observedUpdatedAt: "2026-09-20T08:00:00.600Z",
      observedUserMessageAt: "2026-09-20T08:00:00.000Z",
    },
  );
  expect(read.reproduced).toBe(false);
  expect(read.latest).toBe("2026-09-20T08:00:00.000Z");
});

it("keeps a single live row exact when its stamp matches the record", async () => {
  const read = await readConversationTime(
    async () => page([["assistant_message", observed]]),
    { now, observedUpdatedAt: observed },
  );
  expect(read.latest).toBe("2026-09-22T23:00:00.000Z");
  expect(read.replayStamped).toBe(0);
  expect(read.reproduced).toBe(false);
});

it("reports a truncated window instead of an empty history", async () => {
  const read = await readConversationTime(
    async (options) =>
      options.direction === "tail"
        ? page([["tool_call", "2026-09-22T00:00:00Z"]], true, 200)
        : page([["tool_call", "2026-09-21T00:00:00Z"]], true, 199),
    { now, maxPages: 2 },
  );
  expect(read).toEqual({
    latest: null,
    messages: 0,
    replayStamped: 0,
    reproduced: false,
    pages: 2,
    truncated: true,
  });
});

it("reports a complete history without user or assistant rows as empty", async () => {
  expect(await readConversationTime(async () => page([]), { now })).toEqual({
    latest: null,
    messages: 0,
    replayStamped: 0,
    reproduced: false,
    pages: 1,
    truncated: false,
  });
});
