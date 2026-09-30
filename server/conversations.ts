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

/**
 * What a bounded read of one conversation window proved.
 *
 * `latest` is only the newest accepted row. Paseo re-stamps replayed history rows with the
 * hydration moment, so rows newer than the recorded activity time are dropped as hydration
 * stamps instead of failing the whole read: what was dropped may be newer than what was kept,
 * which is exactly why a read with `replayStamped > 0` cannot claim an exact conversation time.
 */
export interface ConversationWindow {
  latest: string | null;
  messages: number;
  replayStamped: number;
  /** Accepted rows that look like a re-projected batch, so the read is not exact. */
  reproduced: boolean;
  pages: number;
  truncated: boolean;
}
export interface ConversationWindowOptions {
  now: number;
  /** Paseo's recorded last live activity; rows newer than this are hydration stamps. */
  observedUpdatedAt?: string;
  /**
   * Paseo's recorded last user message. Live user rows match it, while a re-projected
   * history stamps every row at the hydration moment, so a mismatch proves a replay.
   */
  observedUserMessageAt?: string;
  pageLimit?: number;
  /** Tail page plus this many look-back pages before the window counts as truncated. */
  maxPages?: number;
  /** Tolerance for rows stamped while this read was in flight. */
  skewMs?: number;
  /** A rewind re-projection stamps rows and `updatedAt` together inside this window. */
  hydrationMs?: number;
  /** How far a live user row may trail the recorded user message before it is a replay. */
  userMessageSkewMs?: number;
}

const DEFAULT_PAGE_LIMIT = 200;
const DEFAULT_MAX_PAGES = 3;
const DEFAULT_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_HYDRATION_MS = 15 * 60 * 1000;
const DEFAULT_USER_MESSAGE_SKEW_MS = 60 * 1000;
const MESSAGE_TYPES = new Set(["user_message", "assistant_message"]);

/**
 * Read the newest user or assistant message of one conversation without scanning its whole
 * history: the newest rows are on the tail page, so a look-back only happens when the tail
 * page holds no message row at all. `truncated` means the budget ran out before that
 * happened, and the caller must not read it as "this workspace never had a conversation".
 */
export async function readConversationTime(
  read: TimelineReader,
  options: ConversationWindowOptions,
): Promise<ConversationWindow> {
  const now = options.now;
  const observed =
    options.observedUpdatedAt === undefined
      ? now
      : Date.parse(options.observedUpdatedAt);
  const pageLimit = options.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const userMessageAt =
    options.observedUserMessageAt === undefined
      ? now
      : Date.parse(options.observedUserMessageAt);
  const hasUserMessage = options.observedUserMessageAt !== undefined;
  const skew = options.skewMs ?? DEFAULT_SKEW_MS;
  const hydration = options.hydrationMs ?? DEFAULT_HYDRATION_MS;
  const userMessageSkew =
    options.userMessageSkewMs ?? DEFAULT_USER_MESSAGE_SKEW_MS;
  if (
    !Number.isFinite(observed) ||
    !Number.isFinite(now) ||
    !Number.isFinite(userMessageAt)
  )
    throw new Error("Conversation observation time is invalid");
  const accepted: number[] = [];
  let acceptedUser: number | null = null;
  let replayStamped = 0;
  let seenMessages = 0;
  let pages = 0;
  let truncated = false;
  let cursor: TimelinePage["startCursor"] = null;
  let epoch: string | undefined;
  let maxSeq: number | undefined;
  for (;;) {
    const page = await read(
      cursor
        ? { direction: "before", cursor, limit: pageLimit }
        : { direction: "tail", limit: pageLimit },
    );
    pages += 1;
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
      if (!MESSAGE_TYPES.has(entry.item.type)) continue;
      seenMessages += 1;
      const timestamp = Date.parse(entry.timestamp);
      if (!Number.isFinite(timestamp) || timestamp > now + skew)
        throw new Error("Conversation timestamp cannot be verified");
      // A row newer than the recorded activity is a hydration stamp, not a message.
      if (timestamp > observed) {
        replayStamped += 1;
        continue;
      }
      accepted.push(timestamp);
      if (entry.item.type === "user_message")
        acceptedUser =
          acceptedUser === null ? timestamp : Math.max(acceptedUser, timestamp);
    }
    if (seenMessages > 0) break;
    if (!page.hasOlder) break;
    if (pages >= maxPages) {
      truncated = true;
      break;
    }
    const next = page.startCursor;
    if (!next || next.epoch !== epoch || (cursor && next.seq >= cursor.seq)) {
      throw new Error("Conversation history did not advance");
    }
    cursor = next;
  }
  // A rewind re-projects history and bumps `updatedAt` to the same hydration moment, so a
  // batch that shares one stamp matching the record is a replay, never live activity. The
  // recorded user message is the sharper check: a live user row carries its real time, while
  // a re-projection stamps it at the hydration moment. Paseo stamps replayed rows one at a
  // time, so equal stamps alone cannot identify a batch when no user message is recorded.
  // Observed rows stay a bound even when they cannot claim an exact time, so nothing is
  // dropped here: a session continued outside Paseo must still bound its own archive gate.
  const reproduced =
    acceptedUser !== null && hasUserMessage
      ? acceptedUser > userMessageAt + userMessageSkew
      : !hasUserMessage &&
        accepted.length >= 2 &&
        acceptedUser === null &&
        accepted.every((value) => value === accepted[0]) &&
        Math.abs(accepted[0] - observed) <= hydration;
  return {
    latest:
      accepted.length === 0
        ? null
        : new Date(Math.max(...accepted)).toISOString(),
    messages: accepted.length,
    replayStamped,
    reproduced,
    pages,
    truncated,
  };
}
