import { describe, it, expect } from "vitest";
import { planDrainTimeline, drainGapMs, pickDrainArchetype, inQuietDrainGap } from "../src/lib/scheduler.js";
import { makeRng } from "../src/lib/rng.js";

// Reddit's drain is REPLY-ONLY: startDrain calls planDrainTimeline with
// likesPerGap*=0 (and defensively filters to comment slots), so the drain plan
// NEVER contains a like/vote slot — automated voting is bannable. These tests
// pin the exact inputs the Reddit background uses.
const REDDIT_DRAIN = { likesPerGapMin: 0, likesPerGapMax: 0 } as const;

describe("planDrainTimeline — Reddit reply-only drain", () => {
  it("emits exactly one comment slot per approved reply", () => {
    const rng = makeRng(12345);
    const plan = planDrainTimeline({ approvedComments: 7, startMs: 1_000_000, rng, ...REDDIT_DRAIN });
    expect(plan.filter((a) => a.kind === "comment")).toHaveLength(7);
  });

  it("emits ZERO like slots (no voting, ever) across many replies + all gap bands", () => {
    for (const seed of [7, 11, 2026, 4242, 99999]) {
      const rng = makeRng(seed);
      const plan = planDrainTimeline({ approvedComments: 60, startMs: 0, rng, ...REDDIT_DRAIN });
      expect(plan.every((a) => a.kind === "comment")).toBe(true);
      expect(plan.filter((a) => a.kind === "like")).toHaveLength(0);
    }
  });

  it("first reply lands soon (3-9s), not instantly", () => {
    const rng = makeRng(999);
    const start = 1_000_000;
    const plan = planDrainTimeline({ approvedComments: 3, startMs: start, rng, ...REDDIT_DRAIN });
    const first = plan.filter((a) => a.kind === "comment").sort((a, b) => a.atMs - b.atMs)[0]!;
    expect(first.atMs - start).toBeGreaterThanOrEqual(3_000);
    expect(first.atMs - start).toBeLessThanOrEqual(9_000);
  });

  it("inter-reply gaps are the new 4 min + 0–900s band ∈ [240000, 1140000]", () => {
    const rng = makeRng(2026);
    const plan = planDrainTimeline({ approvedComments: 40, startMs: 0, rng, ...REDDIT_DRAIN });
    const times = plan.filter((a) => a.kind === "comment").map((a) => a.atMs).sort((x, y) => x - y);
    expect(times.length).toBe(40);
    for (let i = 1; i < times.length; i++) {
      const gap = times[i]! - times[i - 1]!;
      expect(gap).toBeGreaterThanOrEqual(240_000);
      expect(gap).toBeLessThanOrEqual(1_140_000); // 240000 + 900000
    }
  });

  it("shows real spacing variety within the band (not a fixed cadence)", () => {
    const rng = makeRng(7);
    const plan = planDrainTimeline({ approvedComments: 60, startMs: 0, rng, ...REDDIT_DRAIN });
    const t = plan.filter((a) => a.kind === "comment").map((a) => a.atMs).sort((x, y) => x - y);
    const gaps = t.slice(1).map((v, i) => v - t[i]!);
    // some near the 4-min floor, some well above it — genuinely random rates
    expect(gaps.filter((g) => g < 500_000).length).toBeGreaterThan(0);
    expect(gaps.filter((g) => g >= 700_000).length).toBeGreaterThan(0);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(240_000);
  });

  it("drainGapMs stays in [240000, 1140000] (4 min + 0–900s) and covers the spread", () => {
    const rng = makeRng(88);
    let sawLow = false, sawHigh = false;
    for (let i = 0; i < 500; i++) {
      const g = drainGapMs(rng);
      expect(g).toBeGreaterThanOrEqual(240_000);
      expect(g).toBeLessThanOrEqual(1_140_000);
      if (g < 400_000) sawLow = true;
      if (g > 900_000) sawHigh = true;
    }
    expect(sawLow && sawHigh).toBe(true); // spread, not a constant
  });
});

describe("drainGapMs — quick/normal/cooldown timing archetypes", () => {
  it("is a non-uniform mixture that is NEVER faster than the legacy flat uniform", () => {
    // Legacy: flat uniform on [240000, 1140000] ⇒ mean 690000ms. The archetype
    // mixture must (a) break the flat-uniform shape and (b) hold the mean
    // equal-or-SLOWER — a quick-heavy mixture would raise reply velocity even
    // with the 240s floor intact, and drain is the sole spacing backstop.
    const LEGACY_MEAN = 690_000;
    const rng = makeRng(2027);
    const N = 20_000;
    let quick = 0, normal = 0, cooldown = 0, sum = 0;
    for (let i = 0; i < N; i++) {
      const g = drainGapMs(rng);
      expect(g).toBeGreaterThanOrEqual(240_000); // 240s floor — the sole drain-mode backstop
      expect(g).toBeLessThanOrEqual(1_140_000);  // 19-min ceiling
      sum += g;
      if (g < 456_000) quick++;        // base + 0.24*rand
      else if (g < 798_000) normal++;  // base + 0.62*rand
      else cooldown++;
    }
    // Every archetype occurs — the mixture is real, not degenerate to one band.
    expect(quick).toBeGreaterThan(0);
    expect(normal).toBeGreaterThan(0);
    expect(cooldown).toBeGreaterThan(0);
    // Upper-tail-heavy (breaks the flat-uniform fingerprint the safe way): the
    // long "stepped away" cooldown is more likely than a quick succession.
    expect(cooldown).toBeGreaterThan(quick);
    // And the central tendency never rises: mean stays ≥ the legacy uniform mean.
    expect(sum / N).toBeGreaterThanOrEqual(LEGACY_MEAN);
  });

  it("accepts an explicit band-weight vector and honors it (drainGapMs weights arg)", () => {
    // A cooldown-only vector must draw ONLY cooldown-band gaps (≥ 798000).
    const rng = makeRng(31);
    for (let i = 0; i < 300; i++) {
      const g = drainGapMs(rng, [0, 0, 1]); // force the cooldown band
      expect(g).toBeGreaterThanOrEqual(240_000 + Math.round(900_000 * 0.62)); // 798000
      expect(g).toBeLessThanOrEqual(1_140_000);
    }
    // A quick-only vector must draw ONLY quick-band gaps (≤ 456000).
    for (let i = 0; i < 300; i++) {
      const g = drainGapMs(rng, [1, 0, 0]);
      expect(g).toBeGreaterThanOrEqual(240_000);
      expect(g).toBeLessThanOrEqual(240_000 + Math.round(900_000 * 0.24)); // 456000
    }
  });
});

// ── Per-session TIMING archetype (Reddit reply-only: no like knobs) ───────────
describe("pickDrainArchetype — per-session TIMING archetype (equal-or-slower)", () => {
  // drainGapMs band midpoints: quick [240000,456000], normal [456000,798000],
  // cooldown [798000,1140000]. The default mix [0.2,0.38,0.42] has this mean gap.
  const BAND_MID = [348_000, 627_000, 969_000];
  const DEFAULT_MEAN = 0.2 * BAND_MID[0]! + 0.38 * BAND_MID[1]! + 0.42 * BAND_MID[2]!; // 714840
  const bandMean = (w: number[]): number => {
    const sum = w[0]! + w[1]! + w[2]!;
    return (w[0]! * BAND_MID[0]! + w[1]! * BAND_MID[1]! + w[2]! * BAND_MID[2]!) / sum;
  };

  it("is deterministic per seed and varies across seeds", () => {
    expect(pickDrainArchetype(makeRng(5))).toEqual(pickDrainArchetype(makeRng(5)));
    const styles = Array.from({ length: 60 }, (_, i) => pickDrainArchetype(makeRng(i + 1)));
    const firstWeights = new Set(styles.map((s) => s.bandWeights[0]!.toFixed(5)));
    expect(firstWeights.size).toBeGreaterThan(10); // materially different mixes
  });

  it("EVERY archetype mixture keeps a mean gap ≥ the default (~11.9 min), never faster", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const s = pickDrainArchetype(makeRng(seed));
      expect(s.bandWeights).toHaveLength(3);
      for (const w of s.bandWeights) expect(w).toBeGreaterThan(0); // every band reachable
      // The equal-or-slower invariant, per archetype (the jitter is mean-monotone).
      expect(bandMean(s.bandWeights)).toBeGreaterThanOrEqual(DEFAULT_MEAN - 0.5);
      // No break, or a real one INSIDE the [240s, 1140s] spacing envelope.
      expect(s.longBreakMs === 0 || (s.longBreakMs >= 240_000 && s.longBreakMs <= 1_140_000)).toBe(true);
    }
  });

  it("some sessions are break-prone and some never break (temperament varies)", () => {
    const styles = Array.from({ length: 160 }, (_, i) => pickDrainArchetype(makeRng(i + 1)));
    expect(styles.some((s) => s.longBreakMs > 0)).toBe(true);
    expect(styles.some((s) => s.longBreakMs === 0)).toBe(true);
  });
});

describe("planDrainTimeline — under a per-session archetype (bounds + equal-or-slower)", () => {
  it("all inter-reply gaps stay in [240000, 1140000] for every drawn archetype (incl. the break gap)", () => {
    for (let seed = 1; seed <= 80; seed++) {
      const style = pickDrainArchetype(makeRng(seed));
      const plan = planDrainTimeline({
        approvedComments: 25, startMs: seed * 137_000, rng: makeRng(seed * 7 + 1),
        ...REDDIT_DRAIN, ...style,
      });
      const t = plan.filter((a) => a.kind === "comment").map((a) => a.atMs).sort((x, y) => x - y);
      const gaps = t.slice(1).map((v, i) => v - t[i]!);
      for (const g of gaps) {
        expect(g).toBeGreaterThanOrEqual(240_000);
        expect(g).toBeLessThanOrEqual(1_140_000);
      }
    }
  });

  it("the full drain timeline (archetype + long break) stays equal-or-SLOWER than the default mean", () => {
    // Aggregate over many sessions so the assertion is on the true mean, not a
    // single-session sampling wobble. Every archetype is ≥ the default mean and the
    // long break only ADDS time, so the aggregate is comfortably ≥ the default.
    const DEFAULT_MEAN = 714_840;
    let total = 0, count = 0;
    for (let seed = 1; seed <= 250; seed++) {
      const style = pickDrainArchetype(makeRng(seed));
      const plan = planDrainTimeline({
        approvedComments: 20, startMs: seed * 100_003, rng: makeRng(seed * 13 + 3),
        ...REDDIT_DRAIN, ...style,
      });
      const t = plan.filter((a) => a.kind === "comment").map((a) => a.atMs).sort((x, y) => x - y);
      for (let i = 1; i < t.length; i++) { total += t[i]! - t[i - 1]!; count++; }
    }
    expect(total / count).toBeGreaterThanOrEqual(DEFAULT_MEAN);
  });

  it("emits ZERO like slots under any archetype (reply-only holds — no like knob)", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const style = pickDrainArchetype(makeRng(seed));
      const plan = planDrainTimeline({ approvedComments: 20, startMs: 0, rng: makeRng(seed + 9), ...REDDIT_DRAIN, ...style });
      expect(plan.filter((a) => a.kind === "like")).toHaveLength(0);
    }
  });
});

