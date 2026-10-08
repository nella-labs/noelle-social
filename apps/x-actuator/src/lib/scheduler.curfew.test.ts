import { describe, it, expect } from "vitest";
import { planTimeline } from "./scheduler.js";
import { isWriteCurfew, CURFEW_START_HOUR, CURFEW_END_HOUR } from "./curfew.js";
import { makeRng } from "./rng.js";

// The REAL seeded Rng, not a stand-in — planTimeline uses rng.gamma(), which a
// hand-rolled fake silently lacked until it threw.
const rng = () => makeRng(12345);

/** Local midnight-anchored time on a fixed day, so the test is TZ-stable. */
function at(hour: number, minute = 0): number {
  const d = new Date(2026, 6, 12, hour, minute, 0, 0);
  return d.getTime();
}

const baseOpts = {
  // RunParams carries the TARGETS; caps are the ceilings. Both are needed or
  // planTimeline plans nothing at all.
  params: { windowHours: 12, targetComments: 8, targetLikes: 13 },
  approvedDms: 0,
  caps: { likes: 13, comments: 8, dms: 0 },
  deepNightTaper: false,
  maxWritesPerHour: 8,
};

describe("plan-time curfew avoidance", () => {
  it("keeps a run started inside curfew at the first allowed time", () => {
    const { actions } = planTimeline({
      ...baseOpts,
      startMs: at(3),
      curfewEnabled: true,
      rng: rng(),
    });
    expect(actions.length).toBeGreaterThan(0);
    expect(actions[0]!.atMs).toBeGreaterThanOrEqual(at(CURFEW_END_HOUR));
    for (const action of actions) {
      expect(isWriteCurfew(action.atMs, true)).toBe(false);
    }
  });

  it("never plans a write inside the curfew band, and never collapses them", () => {
    // The reviewer's repro: a run that starts at 00:30 spans the whole
    // 01:00-09:00 band. The old shift target was a hardcoded 06:00 — INSIDE
    // that band — so each shifted action re-entered the curfew and, because
    // planTimeline sets `cursor = atMs`, every subsequent one collapsed onto
    // 06:00:00.000 exactly. 12 of 21 actions landed on the same millisecond.
    const startMs = at(0, 30);
    const { actions } = planTimeline({
      ...baseOpts,
      startMs,
      curfewEnabled: true,
      rng: rng(),
    });

    expect(actions.length).toBeGreaterThan(0);

    // 1. Nothing survives inside the band.
    for (const a of actions) {
      expect(isWriteCurfew(a.atMs, true), new Date(a.atMs).toString()).toBe(false);
    }

    // 2. No two actions share a timestamp — the collapse signature.
    const stamps = actions.map((a) => a.atMs);
    expect(new Set(stamps).size).toBe(stamps.length);
  });

  it("leaves the timeline alone when the run has no curfew", () => {
    const startMs = at(0, 30);
    const { actions } = planTimeline({
      ...baseOpts,
      startMs,
      curfewEnabled: false,
      rng: rng(),
    });
    // Without a curfew, night slots are allowed — and still not collapsed.
    const stamps = actions.map((a) => a.atMs);
    expect(new Set(stamps).size).toBe(stamps.length);
    expect(actions.some((a) => isWriteCurfew(a.atMs, true))).toBe(true);
  });

  it("shifts forward to the END of the band, which is outside it by construction", () => {
    // The guarantee that makes the collapse impossible: the forward target is
    // the first ALLOWED instant, so target + gap cannot re-enter the band.
    const boundary = new Date(2026, 6, 12, CURFEW_END_HOUR, 0, 0, 0).getTime();
    expect(isWriteCurfew(boundary, true)).toBe(false);
    const inside = new Date(2026, 6, 12, CURFEW_START_HOUR, 30, 0, 0).getTime();
    expect(isWriteCurfew(inside, true)).toBe(true);
  });
});
