import { describe, it, expect } from "vitest";
import {
  rollUpPersonInteractions,
  type HandleInteractionStats,
} from "./queries";

const stat = (over: Partial<HandleInteractionStats> = {}): HandleInteractionStats => ({
  repliesSent: 0,
  pendingReplies: 0,
  lastInteractionAt: null,
  ...over,
});

describe("rollUpPersonInteractions", () => {
  it("is empty when a contact has no handles", () => {
    expect(rollUpPersonInteractions([], new Map(), new Map())).toEqual({
      repliesSent: 0,
      pendingReplies: 0,
      lastInteractionAt: null,
      watchedBy: [],
    });
  });

  it("reads a single handle's stats + watchers", () => {
    const stats = new Map([["jane", stat({ repliesSent: 3, pendingReplies: 1 })]]);
    const watchers = new Map([["jane", ["Vega"]]]);
    expect(rollUpPersonInteractions(["jane"], stats, watchers)).toEqual({
      repliesSent: 3,
      pendingReplies: 1,
      lastInteractionAt: null,
      watchedBy: ["Vega"],
    });
  });

  it("sums reply counts across a contact's X + LinkedIn handles", () => {
    const stats = new Map([
      ["jane", stat({ repliesSent: 3, pendingReplies: 1 })],
      ["jane-doe", stat({ repliesSent: 2, pendingReplies: 4 })],
    ]);
    const rollup = rollUpPersonInteractions(["jane", "jane-doe"], stats, new Map());
    expect(rollup.repliesSent).toBe(5);
    expect(rollup.pendingReplies).toBe(5);
  });

  it("takes the most-recent interaction across handles", () => {
    const stats = new Map([
      ["jane", stat({ lastInteractionAt: "2026-01-01T00:00:00Z" })],
      ["jane-doe", stat({ lastInteractionAt: "2026-06-01T00:00:00Z" })],
    ]);
    const rollup = rollUpPersonInteractions(["jane", "jane-doe"], stats, new Map());
    expect(rollup.lastInteractionAt).toBe("2026-06-01T00:00:00Z");
  });

  it("unions watchers across handles and dedupes the same agent", () => {
    const watchers = new Map([
      ["jane", ["Vega"]],
      ["jane-doe", ["Lyra", "Vega"]],
    ]);
    const rollup = rollUpPersonInteractions(["jane", "jane-doe"], new Map(), watchers);
    expect([...rollup.watchedBy].sort()).toEqual(["Lyra", "Vega"]);
  });

  it("ignores handles with no stats or watchers", () => {
    const stats = new Map([["jane", stat({ repliesSent: 1 })]]);
    const rollup = rollUpPersonInteractions(["jane", "ghost"], stats, new Map());
    expect(rollup.repliesSent).toBe(1);
    expect(rollup.watchedBy).toEqual([]);
  });
});
