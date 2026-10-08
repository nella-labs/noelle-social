import { describe, it, expect } from "vitest";
import { planTimeline } from "../src/lib/scheduler.js";
import { makeRng } from "../src/lib/rng.js";

const HOUR = 3600_000;

// Every 6 consecutive write actions (comment/dm) must span at least an hour,
// i.e. no rolling-hour window holds more than maxWritesPerHour=5 writes.
describe("scheduler hourly write ceiling", () => {
  it("keeps write actions under maxWritesPerHour in any rolling hour", () => {
    const start = 1_700_000_000_000; // fixed daytime-ish epoch
    for (let seed = 1; seed <= 20; seed++) {
      const { actions } = planTimeline({
        params: { windowHours: 24, targetComments: 30, targetLikes: 12 },
        approvedDms: 0,
        caps: { likes: 100, comments: 100, dms: 100 },
        startMs: start,
        deepNightTaper: false,
        maxWritesPerHour: 5,
        rng: makeRng(seed),
      });
      const writes = actions
        .filter((a) => a.kind !== "like")
        .map((a) => a.atMs)
        .sort((a, b) => a - b);
      for (let i = 5; i < writes.length; i++) {
        expect(writes[i]! - writes[i - 5]!).toBeGreaterThanOrEqual(HOUR);
      }
    }
  });

  it("is a no-op when maxWritesPerHour is omitted (back-compat)", () => {
    const { actions } = planTimeline({
      params: { windowHours: 8, targetComments: 20, targetLikes: 0 },
      approvedDms: 0,
      caps: { likes: 100, comments: 100, dms: 100 },
      startMs: 1_700_000_000_000,
      deepNightTaper: false,
      rng: makeRng(1),
    });
    expect(actions.length).toBeGreaterThan(0);
  });
});
