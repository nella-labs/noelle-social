import { describe, expect, it } from "vitest";
import { pagerNeighbors, arrowTarget } from "./review-pager.js";

describe("pagerNeighbors", () => {
  const ids = ["a", "b", "c"];

  it("returns both neighbors in the middle of the queue", () => {
    expect(pagerNeighbors(ids, "b")).toEqual({
      index: 1,
      total: 3,
      prevId: "a",
      nextId: "c",
    });
  });

  it("has no prev on the first lead", () => {
    expect(pagerNeighbors(ids, "a")).toEqual({
      index: 0,
      total: 3,
      prevId: null,
      nextId: "b",
    });
  });

  it("has no next on the last lead", () => {
    expect(pagerNeighbors(ids, "c")).toEqual({
      index: 2,
      total: 3,
      prevId: "b",
      nextId: null,
    });
  });

  it("reports index -1 and no neighbors when the lead isn't in the queue", () => {
    // e.g. an already-actioned approval reached by deeplink — the pager hides.
    expect(pagerNeighbors(ids, "zzz")).toEqual({
      index: -1,
      total: 3,
      prevId: null,
      nextId: null,
    });
  });

  it("handles a single-lead queue", () => {
    expect(pagerNeighbors(["only"], "only")).toEqual({
      index: 0,
      total: 1,
      prevId: null,
      nextId: null,
    });
  });

  it("handles an empty queue", () => {
    expect(pagerNeighbors([], "a")).toEqual({
      index: -1,
      total: 0,
      prevId: null,
      nextId: null,
    });
  });
});

describe("arrowTarget", () => {
  it("maps ← to prev and → to next", () => {
    expect(arrowTarget("ArrowLeft", "/p", "/n")).toBe("/p");
    expect(arrowTarget("ArrowRight", "/p", "/n")).toBe("/n");
  });

  it("returns null at an end where the neighbor is missing", () => {
    expect(arrowTarget("ArrowLeft", null, "/n")).toBeNull();
    expect(arrowTarget("ArrowRight", "/p", null)).toBeNull();
  });

  it("ignores other keys", () => {
    expect(arrowTarget("Enter", "/p", "/n")).toBeNull();
    expect(arrowTarget("a", "/p", "/n")).toBeNull();
  });
});
