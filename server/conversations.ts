export interface TimelinePage {
  epoch: string;
  gap: boolean;
  staleCursor: boolean;
  error: string | null;
  hasOlder: boolean;
  startCursor: { epoch: string; seq: number } | null;
  window: { maxSeq: number };
  entries: Array<{ timestamp: string; item: { type: string } }>;
}
export type TimelineReader = (options: {
  direction: "tail" | "before";
  cursor?: { epoch: string; seq: number };
  limit: number;
}) => Promise<TimelinePage>;
export async function readConversationTime(
  read: TimelineReader,
  now: number,
  observedUpdatedAt?: string,
): Promise<string | null> {
  const observed =
    observedUpdatedAt === undefined ? now : Date.parse(observedUpdatedAt);
  if (!Number.isFinite(observed) || !Number.isFinite(now))
    throw new Error("Conversation observation time is invalid");
  let cursor: TimelinePage["startCursor"] = null;
  let epoch: string | undefined;
  let maxSeq: number | undefined;
  let latest: number | null = null;
  const cursors = new Set<number>();
  do {
    const page = await read(
      cursor
        ? { direction: "before", cursor, limit: 200 }
        : { direction: "tail", limit: 200 },
    );
    if (
      page.error ||
      page.gap ||
      page.staleCursor ||
      (epoch !== undefined &&
        (epoch !== page.epoch || maxSeq !== page.window.maxSeq))
    ) {
      throw new Error(
        "Conversation history is incomplete or changed during pagination",
      );
    }
    epoch = page.epoch;
    maxSeq = page.window.maxSeq;
    for (const entry of page.entries) {
      if (
        entry.item.type !== "user_message" &&
        entry.item.type !== "assistant_message"
      )
        continue;
      const timestamp = Date.parse(entry.timestamp);
      if (
        !Number.isFinite(timestamp) ||
        timestamp > now ||
        timestamp > observed
      ) {
        throw new Error("Conversation timestamp cannot be verified");
      }
      latest = latest === null ? timestamp : Math.max(latest, timestamp);
    }
    if (!page.hasOlder) break;
    const next = page.startCursor;
    if (
      !next ||
      next.epoch !== epoch ||
      cursors.has(next.seq) ||
      (cursor && next.seq >= cursor.seq)
    ) {
      throw new Error("Conversation history did not advance");
    }
    cursors.add(next.seq);
    cursor = next;
  } while (true);
  return latest === null ? null : new Date(latest).toISOString();
}
