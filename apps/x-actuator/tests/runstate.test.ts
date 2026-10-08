import { describe, it, expect } from "vitest";
import { dueActionIndex, withinWindow, tickIsCurrent } from "../src/background/state.js";
import type { SlotAction } from "../src/background/state.js";

const acts: SlotAction[] = [
  { kind: "like", atMs: 1000, executed: false },
  { kind: "comment", atMs: 2000, executed: false },
  { kind: "like", atMs: 1500, executed: true },  // already executed → ignored
  { kind: "dm", atMs: 1800, executed: false },
];

describe("background state helpers", () => {
  it("returns the earliest unexecuted action whose time has passed", () => {
    // at 2500: candidates atMs<=2500 & !executed → like@1000, comment@2000, dm@1800 → earliest = like@1000 (idx 0)
    expect(dueActionIndex(acts, 2500)).toBe(0);
  });

  it("ignores executed slots and respects not-yet-due", () => {
    // at 1200: only like@1000 is due+unexecuted
    expect(dueActionIndex(acts, 1200)).toBe(0);
    // at 500: nothing due
    expect(dueActionIndex(acts, 500)).toBe(-1);
  });

  it("returns -1 when all due slots are executed", () => {
    const allDone: SlotAction[] = [{ kind: "like", atMs: 1000, executed: true }];
    expect(dueActionIndex(allDone, 5000)).toBe(-1);
  });

  it("withinWindow respects the window end", () => {
    expect(withinWindow(0, 1, 30 * 60_000)).toBe(true);
    expect(withinWindow(0, 1, 61 * 60_000)).toBe(false);
  });
});

describe("tickIsCurrent (stop/supersede guard)", () => {
  it("is true only when the loaded epoch matches the current epoch", () => {
    expect(tickIsCurrent(3, 3)).toBe(true);
    expect(tickIsCurrent(2, 3)).toBe(false); // superseded by a newer run / STOP
    expect(tickIsCurrent(4, 3)).toBe(false); // impossible-but-safe: newer than current
  });

  it("treats pre-upgrade state (undefined epoch) as epoch 0", () => {
    expect(tickIsCurrent(undefined, 0)).toBe(true);
    expect(tickIsCurrent(undefined, 1)).toBe(false); // a run has since started → stale
  });
});
