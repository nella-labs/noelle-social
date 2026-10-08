import { describe, expect, it, vi } from "vitest";
import { enforceGoal } from "./goal.js";

// Tagged-template sql mock that records the UPDATE (pause) without a DB.
function makeSql() {
  const calls: string[] = [];
  const sql = vi.fn(async (strings: TemplateStringsArray) => {
    calls.push(strings.join("?"));
    return [];
  }) as never;
  return { sql, calls };
}

const inst = (over: Record<string, unknown> = {}) =>
  ({
    id: "i",
    org_id: "o",
    goal_target: 20,
    goal_started_at: "2026-06-10T00:00:00.000Z",
    ...over,
  }) as never;

const STALL_MS = 2 * 60 * 60_000;

describe("enforceGoal", () => {
  it("returns null when no goal-run is active", async () => {
    const { sql } = makeSql();
    expect(await enforceGoal(sql, inst({ goal_target: null }))).toBeNull();
  });

  it("pauses (reached) when produced >= target", async () => {
    const { sql, calls } = makeSql();
    const r = await enforceGoal(sql, inst(), {
      countApprovalsSince: async () => 20,
      lastApprovalAtSince: async () => "2026-06-10T00:30:00.000Z",
      now: new Date("2026-06-10T01:00:00.000Z"),
    });
    expect(r).toEqual({ paused: true, produced: 20, target: 20, stalled: false });
    expect(calls.some((c) => /update.*agent_instances/is.test(c))).toBe(true);
  });

  it("keeps running when below target and recently made progress", async () => {
    const { sql } = makeSql();
    const r = await enforceGoal(sql, inst(), {
      countApprovalsSince: async () => 4,
      lastApprovalAtSince: async () => "2026-06-10T01:50:00.000Z", // 10m ago
      now: new Date("2026-06-10T02:00:00.000Z"),
      stallMs: STALL_MS,
    });
    expect(r).toEqual({ paused: false, produced: 4, target: 20, stalled: false });
  });

  it("pauses (stalled) when no new leads for stallMs (watchlist exhausted)", async () => {
    const { sql, calls } = makeSql();
    const r = await enforceGoal(sql, inst(), {
      countApprovalsSince: async () => 4, // far below 20
      lastApprovalAtSince: async () => null, // none since goal start
      now: new Date("2026-06-10T03:00:00.000Z"), // 3h after goal_started_at
      stallMs: STALL_MS,
    });
    expect(r).toEqual({ paused: true, produced: 4, target: 20, stalled: true });
    expect(calls.some((c) => /update.*agent_instances/is.test(c))).toBe(true);
  });
});
