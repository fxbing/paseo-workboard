import { expect, it } from "vitest";
import {
  readConversationTime,
  type TimelinePage,
} from "../server/conversations";
const now = Date.parse("2026-09-23T00:00:00Z");
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
  const time = await readConversationTime(async (options) => {
    requests.push(options.direction);
    return options.direction === "tail"
      ? page([["tool_call", "2026-09-22T00:00:00Z"]], true, 200)
      : page([
          ["user_message", "2026-08-01T00:00:00Z"],
          ["assistant_message", "2026-08-02T00:00:00Z"],
        ]);
  }, now);
  expect(time).toBe("2026-08-02T00:00:00.000Z");
  expect(requests).toEqual(["tail", "before"]);
});
it("refuses a changed epoch, gaps, a failed history request and future timestamps", async () => {
  for (const bad of [
    { ...page([]), gap: true },
    { ...page([]), error: "Provider unavailable" },
    page([["user_message", "2099-01-01T00:00:00Z"]]),
  ]) {
    await expect(readConversationTime(async () => bad, now)).rejects.toThrow();
  }
  let n = 0;
  await expect(
    readConversationTime(
      async () => (++n === 1 ? page([], true) : { ...page([]), epoch: "new" }),
      now,
    ),
  ).rejects.toThrow();
});
it("does not replace missing timestamps or history with the current time", async () => {
  expect(await readConversationTime(async () => page([]), now)).toBeNull();
  await expect(
    readConversationTime(
      async () => page([["assistant_message", "broken"]]),
      now,
    ),
  ).rejects.toThrow();
  await expect(
    readConversationTime(
      async () => page([["assistant_message", "2026-09-22T00:00:00Z"]]),
      now,
      "2026-08-01T00:00:00Z",
    ),
  ).rejects.toThrow();
});
