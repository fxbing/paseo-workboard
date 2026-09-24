import { z } from "zod";
import type { Card } from "../shared/model";

export const ACTIVITY_FILTERS = [
  "all",
  "idle",
  "running",
  "waiting",
  "attention",
  "error",
] as const;
export const REQUEST_FILTERS = [
  "all",
  "none",
  "open",
  "draft",
  "merged",
  "closed",
  "unknown",
  "checks-failed",
  "changes-requested",
  "unavailable",
] as const;
const filterSchema = z.object({
  projectId: z.string().min(1).catch("all"),
  search: z.string().catch(""),
  attentionOnly: z.boolean().catch(false),
  activity: z.enum(ACTIVITY_FILTERS).catch("all"),
  changeRequest: z.enum(REQUEST_FILTERS).catch("all"),
});
export type BoardFilters = z.infer<typeof filterSchema>;
export const DEFAULT_FILTERS: BoardFilters = filterSchema.parse({});
export function parseFilters(raw: string | null): BoardFilters {
  try {
    return filterSchema.parse(JSON.parse(raw ?? "{}"));
  } catch {
    return DEFAULT_FILTERS;
  }
}
export function activeFilterCount(filters: BoardFilters): number {
  return [
    filters.projectId !== "all",
    !!filters.search.trim(),
    filters.attentionOnly,
    filters.activity !== "all",
    filters.changeRequest !== "all",
  ].filter(Boolean).length;
}

export function matchesRequest(
  card: Card,
  filter: BoardFilters["changeRequest"],
): boolean {
  if (filter === "all") return true;
  if (filter === "unavailable") return card.changeRequestUnavailable;
  if (card.changeRequestUnavailable) return false;
  const request = card.changeRequest;
  if (filter === "none") return request === null;
  if (!request) return false;
  if (filter === "checks-failed" || filter === "changes-requested") {
    return (
      (request.state === "open" || request.state === "draft") &&
      (filter === "checks-failed"
        ? request.checksStatus === "failure"
        : request.reviewDecision === "changes_requested")
    );
  }
  return request.state === filter;
}
