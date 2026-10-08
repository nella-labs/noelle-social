import { describe, expect, it } from "vitest";
import {
  resolveAutoCurateConfig,
  decideAutoCurate,
  nextPacedSlotAt,
  type AutoCurateConfig,
  type AutoCurateEnv,
} from "./content-autocurate.js";

const ENV: AutoCurateEnv = {
  NOELLE_POST_AUTOSCHEDULE: true,
  NOELLE_POST_AUTOSCHEDULE_MIN_SCORE: 70,
  NOELLE_POST_AUTOSCHEDULE_AUTOPUBLISH: true,
  NOELLE_POST_AUTOSCHEDULE_SPACING_MIN: 180,
  NOELLE_POST_AUTOSCHEDULE_LEAD_MIN: 15,
};

const CFG: AutoCurateConfig = resolveAutoCurateConfig(ENV);

describe("resolveAutoCurateConfig", () => {
  it("normalizes the 0-100 env score to the 0..1 scale", () => {
    expect(resolveAutoCurateConfig(ENV).minScore).toBeCloseTo(0.7, 6);
    expect(resolveAutoCurateConfig({ ...ENV, NOELLE_POST_AUTOSCHEDULE_MIN_SCORE: 85 }).minScore).toBeCloseTo(0.85, 6);
  });

  it("clamps an out-of-range score so a misconfig can't jam the gate open/shut", () => {
    expect(resolveAutoCurateConfig({ ...ENV, NOELLE_POST_AUTOSCHEDULE_MIN_SCORE: 150 }).minScore).toBe(1);
    expect(resolveAutoCurateConfig({ ...ENV, NOELLE_POST_AUTOSCHEDULE_MIN_SCORE: -5 }).minScore).toBe(0);
  });

  it("carries the on/off + autoPublish + pacing knobs through", () => {
    const cfg = resolveAutoCurateConfig({ ...ENV, NOELLE_POST_AUTOSCHEDULE: false, NOELLE_POST_AUTOSCHEDULE_AUTOPUBLISH: false });
    expect(cfg.enabled).toBe(false);
    expect(cfg.autoPublish).toBe(false);
    expect(cfg.spacingMinutes).toBe(180);
    expect(cfg.leadMinutes).toBe(15);
  });
});

describe("decideAutoCurate", () => {
  const base = { config: CFG, ownerRole: "x_intern", platform: "x", qualityScore: 0.8, qualityPassed: true };

  it("skips entirely when the master switch is off", () => {
    const d = decideAutoCurate({ ...base, config: { ...CFG, enabled: false } });
    expect(d.action).toBe("skip");
    expect(d.reason).toBe("disabled");
  });

  it("skips a non-x_intern owner (auto-curate is Vega-only)", () => {
    expect(decideAutoCurate({ ...base, ownerRole: "linkedin_intern" }).action).toBe("skip");
    expect(decideAutoCurate({ ...base, ownerRole: "linkedin_intern" }).reason).toBe("not_vega_x");
  });

  it("skips a non-x draft even for an x_intern owner (only X auto-publishes)", () => {
    expect(decideAutoCurate({ ...base, platform: "linkedin" }).action).toBe("skip");
  });

  it("skips when there is no score (verifier off) rather than blind-scheduling", () => {
    const d = decideAutoCurate({ ...base, qualityScore: null });
    expect(d.action).toBe("skip");
    expect(d.reason).toBe("no_score");
  });

  it("schedules a draft at/above the bar, carrying the configured autoPublish", () => {
    expect(decideAutoCurate({ ...base, qualityScore: 0.7 })).toEqual({
      action: "schedule",
      autoPublish: true,
      reason: "at_or_above_threshold",
    });
    expect(decideAutoCurate({ ...base, config: { ...CFG, autoPublish: false } }).autoPublish).toBe(false);
  });

  it("dismisses a draft below the bar", () => {
    const d = decideAutoCurate({ ...base, qualityScore: 0.69 });
    expect(d.action).toBe("dismiss");
    expect(d.reason).toBe("below_threshold");
  });

  it("dismisses a verifier-FAILED draft even when its mean cleared the bar (hard-rule veto)", () => {
    const d = decideAutoCurate({ ...base, qualityScore: 0.9, qualityPassed: false });
    expect(d.action).toBe("dismiss");
    expect(d.reason).toBe("verifier_failed");
  });

  it("treats a null qualityPassed as not-vetoed (score is the primary knob)", () => {
    expect(decideAutoCurate({ ...base, qualityScore: 0.75, qualityPassed: null }).action).toBe("schedule");
  });
});

describe("nextPacedSlotAt", () => {
  const now = new Date("2026-07-03T12:00:00.000Z");

  it("places the first slot at now + lead when nothing is scheduled", () => {
    const at = nextPacedSlotAt({ now, lastActiveSlotAt: null, leadMinutes: 15, spacingMinutes: 180 });
    expect(at.toISOString()).toBe("2026-07-03T12:15:00.000Z");
  });

  it("places the next slot spacing-minutes after the last active future slot", () => {
    const last = new Date("2026-07-03T18:00:00.000Z");
    const at = nextPacedSlotAt({ now, lastActiveSlotAt: last, leadMinutes: 15, spacingMinutes: 180 });
    expect(at.toISOString()).toBe("2026-07-03T21:00:00.000Z"); // 18:00 + 3h
  });

  it("never lands before now + lead, even if the last slot is about to fire", () => {
    const last = new Date("2026-07-03T12:05:00.000Z"); // last+spacing would be 15:05, > lead → uses that
    const at = nextPacedSlotAt({ now, lastActiveSlotAt: last, leadMinutes: 15, spacingMinutes: 180 });
    expect(at.toISOString()).toBe("2026-07-03T15:05:00.000Z");
  });

  it("uses the lead floor when last + spacing is still in the past", () => {
    const last = new Date("2026-07-03T09:00:00.000Z"); // +180m = 12:00, < now+lead (12:15) → floor wins
    const at = nextPacedSlotAt({ now, lastActiveSlotAt: last, leadMinutes: 15, spacingMinutes: 180 });
    expect(at.toISOString()).toBe("2026-07-03T12:15:00.000Z");
  });

  it("fans a burst out: each subsequent slot is spacing apart", () => {
    let last: Date | null = null;
    const times: string[] = [];
    for (let i = 0; i < 4; i++) {
      const at = nextPacedSlotAt({ now, lastActiveSlotAt: last, leadMinutes: 15, spacingMinutes: 180 });
      times.push(at.toISOString());
      last = at;
    }
    expect(times).toEqual([
      "2026-07-03T12:15:00.000Z",
      "2026-07-03T15:15:00.000Z",
      "2026-07-03T18:15:00.000Z",
      "2026-07-03T21:15:00.000Z",
    ]);
  });
});
