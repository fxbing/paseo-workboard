import { describe, expect, it } from "vitest";
import { cardSchema, newTask, type Board, type Card } from "../shared/model";
import { visibleCards } from "../client/board-utils";
import {
  activeFilterCount,
  DEFAULT_FILTERS,
  parseFilters,
} from "../client/filters";

const card = (id: string, overrides: Partial<Card> = {}): Card =>
  cardSchema.parse({
    ...newTask(id, `Task ${id}`, "2026-01-01T00:00:00Z"),
    stage: "todo",
    labels: [],
    managedLabels: [],
    changeRequest: null,
    changeRequestUnavailable: false,
    activity: "idle",
    dueAt: null,
    agents: [],
    ...overrides,
  });
const request: NonNullable<Card["changeRequest"]> = {
  forge: "gitlab",
  number: 1,
  url: "https://example.com/mr/1",
  title: "Fix",
  state: "open",
  checksStatus: "failure",
  reviewDecision: "changes_requested",
};
const cards = [
  card("draft"),
  card("running", {
    workspaceId: "w1",
    projectId: "p1",
    activity: "running",
    changeRequest: request,
  }),
  card("waiting", {
    workspaceId: "w2",
    projectId: "p1",
    activity: "waiting",
    changeRequest: { ...request, state: "draft" },
  }),
  card("merged", { changeRequest: { ...request, state: "merged" } }),
  card("unavailable", {
    changeRequest: request,
    changeRequestUnavailable: true,
  }),
  card("missing-unavailable", { changeRequestUnavailable: true }),
  card("unknown", { changeRequest: { ...request, state: "unknown" } }),
];
const board = { cards } as Board;

describe("remembered board filters", () => {
  it("restores only supported values and recovers from corrupt storage", () => {
    expect(parseFilters(null)).toEqual(DEFAULT_FILTERS);
    expect(parseFilters("not json")).toEqual(DEFAULT_FILTERS);
    expect(parseFilters("[]")).toEqual(DEFAULT_FILTERS);
    expect(
      parseFilters(
        JSON.stringify({
          projectId: "p1",
          search: "test",
          attentionOnly: true,
          activity: "running",
          changeRequest: "merged",
        }),
      ),
    ).toEqual({
      projectId: "p1",
      search: "test",
      attentionOnly: true,
      activity: "running",
      changeRequest: "merged",
    });
    expect(
      parseFilters(JSON.stringify({ activity: "removed", search: "keep" })),
    ).toEqual({ ...DEFAULT_FILTERS, search: "keep" });
  });
  it("counts actual conditions without treating whitespace as a filter", () => {
    expect(activeFilterCount({ ...DEFAULT_FILTERS, search: "  " })).toBe(0);
    expect(
      activeFilterCount({
        ...DEFAULT_FILTERS,
        projectId: "none",
        activity: "idle",
        changeRequest: "none",
        attentionOnly: true,
        search: " x ",
      }),
    ).toBe(5);
  });
});

describe("combined board filters", () => {
  it("intersects agent, request, project, search, and attention filters", () => {
    expect(
      visibleCards(board, "p1", "RUNNING", true, {
        activity: "running",
        changeRequest: "open",
      }).map((card) => card.id),
    ).toEqual(["running"]);
    expect(
      visibleCards(board, "p1", "", false, {
        activity: "waiting",
        changeRequest: "open",
      }),
    ).toEqual([]);
    expect(
      visibleCards(board, "all", "", false, {
        activity: "waiting",
        changeRequest: "draft",
      }).map((card) => card.id),
    ).toEqual(["waiting"]);
  });
  it("distinguishes no request, unknown state, and unavailable stale data", () => {
    const ids = (changeRequest: "none" | "unknown" | "unavailable") =>
      visibleCards(board, "all", "", false, {
        activity: "all",
        changeRequest,
      }).map((card) => card.id);
    expect(ids("none")).toEqual(["draft"]);
    expect(ids("unknown")).toEqual(["unknown"]);
    expect(ids("unavailable")).toEqual(["unavailable", "missing-unavailable"]);
  });
  it("limits CI and review action filters to current open or draft requests", () => {
    for (const changeRequest of [
      "checks-failed",
      "changes-requested",
    ] as const) {
      expect(
        visibleCards(board, "all", "", false, {
          activity: "all",
          changeRequest,
        }).map((card) => card.id),
      ).toEqual(["running", "waiting"]);
    }
  });
});
