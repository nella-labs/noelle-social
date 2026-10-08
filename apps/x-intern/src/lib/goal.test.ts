import { describe, expect, it, vi } from "vitest";
import { effectiveDraftsCap, enforceGoal, goalTarget } from "./goal.js";
import type { ActiveInstance } from "./activation.js";

const base: ActiveInstance = { id: "i", org_id: "o" };
const withGoal = (target: number, cap?: number | null): ActiveInstance => ({
  ...base,
  goal_target: target,
  goal_started_at: "2026-05-30T00:00:00.000Z",
  pending_drafts_cap: cap ?? null,
});

describe("goalTarget / effectiveDraftsCap", () => {
  it("goalTarget is null unless both goal fields are set", () => {
    expect(goalTarget(base)).toBeNull();
    expect(goalTarget({ ...base, goal_target: 20 })).toBeNull(); // no started_at
    expect(goalTarget(withGoal(20))).toBe(20);
  });

  it("uses the configured cap when no goal-run is active", () => {
    expect(effectiveDraftsCap({ ...base, pending_drafts_cap: 5 })).toBe(5);
    expect(effectiveDraftsCap({ ...base, pending_drafts_cap: null })).toBeNull();
  });

  it("raises the cap to the target during a goal-run", () => {
    expect(effectiveDraftsCap(withGoal(20, 5))).toBe(20); // cap 5 < target 20 → 20
    expect(effectiveDraftsCap(withGoal(20, 50))).toBe(50); // cap already above target
    expect(effectiveDraftsCap(withGoal(20, null))).toBeNull(); // no cap stays unbounded
  });
});

describe("enforceGoal", () => {
  const sql = vi.fn().mockResolvedValue([]) as never;

  it("no-ops when no goal is active", async () => {
    expect(await enforceGoal(sql, base, { countApprovalsSince: vi.fn() })).toBeNull();
  });

  // A run that IS making progress: the last reply landed a minute ago.
  const started = "2026-05-30T00:00:00.000Z";
  const progressing = {
    now: new Date("2026-05-30T01:00:00.000Z"),
    lastApprovalAtSince: async () => "2026-05-30T00:59:00.000Z",
  };

  it("does not pause while below target and still producing", async () => {
    const count = vi.fn().mockResolvedValue(12);
    const r = await enforceGoal(sql, withGoal(20), { countApprovalsSince: count, ...progressing });
    expect(r).toEqual({ paused: false, produced: 12, target: 20, stalled: false });
  });

  it("pauses + clears the goal once the target is reached", async () => {
    const update = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(20);
    const r = await enforceGoal(update as never, withGoal(20), {
      countApprovalsSince: count,
      ...progressing,
    });
    expect(r).toEqual({ paused: true, produced: 20, target: 20, stalled: false });
    expect(update).toHaveBeenCalledTimes(1); // ran the pause UPDATE
  });

  // STALL GUARD (#134 port). Without it an unreachable target polls Apify forever.
  it("auto-pauses a STALLED run that can never reach its target", async () => {
    const update = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(3); // far below target
    const r = await enforceGoal(update as never, withGoal(500), {
      countApprovalsSince: count,
      // Nothing has landed for 3h against a 2h stall window.
      now: new Date("2026-05-30T03:00:00.000Z"),
      lastApprovalAtSince: async () => started,
    });
    expect(r).toEqual({ paused: true, produced: 3, target: 500, stalled: true });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("does NOT stall-pause a slow run that is still delivering", async () => {
    const update = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(3);
    const r = await enforceGoal(update as never, withGoal(500), {
      countApprovalsSince: count,
      // 3h since the goal started, but a reply landed 30 min ago.
      now: new Date("2026-05-30T03:00:00.000Z"),
      lastApprovalAtSince: async () => "2026-05-30T02:30:00.000Z",
    });
    expect(r).toEqual({ paused: false, produced: 3, target: 500, stalled: false });
    expect(update).not.toHaveBeenCalled();
  });

  it("measures the stall from the goal start when nothing has EVER landed", async () => {
    const update = vi.fn().mockResolvedValue([]);
    const r = await enforceGoal(update as never, withGoal(500), {
      countApprovalsSince: async () => 0,
      now: new Date("2026-05-30T02:30:00.000Z"),
      lastApprovalAtSince: async () => null, // no approvals at all
    });
    expect(r?.stalled).toBe(true);
    expect(r?.paused).toBe(true);
  });

  it("honours a custom stall window", async () => {
    const r = await enforceGoal(vi.fn().mockResolvedValue([]) as never, withGoal(500), {
      countApprovalsSince: async () => 1,
      now: new Date("2026-05-30T00:30:00.000Z"),
      lastApprovalAtSince: async () => started,
      stallMs: 60 * 60_000, // 1h window, only 30 min elapsed
    });
    expect(r?.stalled).toBe(false);
    expect(r?.paused).toBe(false);
  });
});
