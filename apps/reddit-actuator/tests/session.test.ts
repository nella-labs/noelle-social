import { describe, it, expect } from "vitest";
import { makeRng } from "../src/lib/rng.js";
import {
  makeSessionPersona,
  warmupScale,
  warmupSuppressWritesMs,
  engagementDecay,
  microBreakDue,
} from "../src/lib/session.js";

describe("makeSessionPersona", () => {
  it("is deterministic for the same seed", () => {
    const a = makeSessionPersona(42);
    const b = makeSessionPersona(42);
    expect(a).toEqual(b);
  });

  it("produces different personas for different seeds", () => {
    const a = makeSessionPersona(1);
    const b = makeSessionPersona(2);
    // They should differ in at least one field
    const same =
      a.baseGapMs === b.baseGapMs &&
      a.wpm === b.wpm &&
      a.tremorAmp === b.tremorAmp &&
      a.rho === b.rho &&
      a.clickBiasSide === b.clickBiasSide &&
      a.readHeavy === b.readHeavy;
    expect(same).toBe(false);
  });

  it("baseGapMs is in [150000, 280000] range (median-target; sampled values within wide log-normal spread)", () => {
    // logNormal with median in [150000, 280000] means many individual samples
    // can fall outside, but the median over many draws must be in range.
    // Check that the median of 1000 draws is within [100000, 400000].
    const samples = Array.from({ length: 1000 }, (_, i) =>
      makeSessionPersona(i).baseGapMs
    );
    const sorted = [...samples].sort((a, b) => a - b);
    const median = sorted[500]!;
    expect(median).toBeGreaterThan(100000);
    expect(median).toBeLessThan(400000);
  });

  it("wpm is clamped to [115, 400]", () => {
    for (let seed = 0; seed < 500; seed++) {
      const { wpm } = makeSessionPersona(seed);
      expect(wpm).toBeGreaterThanOrEqual(115);
      expect(wpm).toBeLessThanOrEqual(400);
    }
  });

  it("tremorAmp is clamped to [0.12, 1.6]", () => {
    for (let seed = 0; seed < 500; seed++) {
      const { tremorAmp } = makeSessionPersona(seed);
      expect(tremorAmp).toBeGreaterThanOrEqual(0.12);
      expect(tremorAmp).toBeLessThanOrEqual(1.6);
    }
  });

  it("rho is clamped to [0.15, 0.78]", () => {
    for (let seed = 0; seed < 500; seed++) {
      const { rho } = makeSessionPersona(seed);
      expect(rho).toBeGreaterThanOrEqual(0.15);
      expect(rho).toBeLessThanOrEqual(0.78);
    }
  });

  it("clickBiasSide is exactly 1 or -1", () => {
    for (let seed = 0; seed < 500; seed++) {
      const { clickBiasSide } = makeSessionPersona(seed);
      expect(clickBiasSide === 1 || clickBiasSide === -1).toBe(true);
    }
  });

  it("readHeavy is a boolean", () => {
    for (let seed = 0; seed < 500; seed++) {
      const { readHeavy } = makeSessionPersona(seed);
      expect(typeof readHeavy).toBe("boolean");
    }
  });

  it("readHeavy true-rate is ~40% (±8%) over 2000 seeds", () => {
    const N = 2000;
    let trueCount = 0;
    for (let seed = 0; seed < N; seed++) {
      if (makeSessionPersona(seed).readHeavy) trueCount++;
    }
    const rate = trueCount / N;
    expect(rate).toBeGreaterThan(0.32);
    expect(rate).toBeLessThan(0.48);
  });
});

describe("warmupScale", () => {
  it("returns 1.4 at t=0", () => {
    expect(warmupScale(0)).toBeCloseTo(1.4, 5);
  });

  it("returns ~1.0 by 4 minutes (240000ms)", () => {
    expect(warmupScale(240000)).toBeCloseTo(1.0, 3);
  });

  it("never returns less than 1.0", () => {
    for (const t of [0, 60000, 120000, 180000, 240000, 300000, 600000]) {
      expect(warmupScale(t)).toBeGreaterThanOrEqual(1.0);
    }
  });

  it("is monotonic non-increasing", () => {
    const times = [0, 30000, 60000, 90000, 120000, 150000, 180000, 210000, 240000, 300000];
    for (let i = 0; i < times.length - 1; i++) {
      expect(warmupScale(times[i]!)).toBeGreaterThanOrEqual(warmupScale(times[i + 1]!));
    }
  });

  it("returns values between 1.0 and 1.4 inclusive during warm-up", () => {
    for (let ms = 0; ms <= 240000; ms += 10000) {
      const v = warmupScale(ms);
      expect(v).toBeGreaterThanOrEqual(1.0);
      expect(v).toBeLessThanOrEqual(1.4);
    }
  });
});

describe("engagementDecay", () => {
  it("returns 1.0 at t=0", () => {
    expect(engagementDecay(0)).toBeCloseTo(1.0, 5);
  });

  it("is monotonically decreasing before floor", () => {
    let prev = engagementDecay(0);
    for (const t of [5 * 60000, 15 * 60000, 30 * 60000, 45 * 60000]) {
      const curr = engagementDecay(t);
      expect(curr).toBeLessThanOrEqual(prev + 1e-10);
      prev = curr;
    }
  });

  it("floors at 0.4 for very large t", () => {
    expect(engagementDecay(10 * 60 * 60000)).toBeCloseTo(0.4, 5);
    expect(engagementDecay(24 * 60 * 60000)).toBeCloseTo(0.4, 5);
  });

  it("value at T=35min is at the floor (exp(-1) ≈ 0.368 < 0.4, so clamped)", () => {
    const v = engagementDecay(35 * 60000);
    // exp(-1) ≈ 0.368 < floor 0.4, so result is exactly 0.4
    expect(v).toBeCloseTo(0.4, 5);
  });

  it("value at T=10min is still above floor", () => {
    const v = engagementDecay(10 * 60000);
    // exp(-10/35) ≈ 0.752 > 0.4
    expect(v).toBeGreaterThan(0.4);
    expect(v).toBeLessThan(1.0);
  });
});

describe("warmupSuppressWritesMs", () => {
  it("is deterministic for same rng seed", () => {
    const a = warmupSuppressWritesMs(makeRng(1));
    const b = warmupSuppressWritesMs(makeRng(1));
    expect(a).toBe(b);
  });

  it("is within [30000, 300000]", () => {
    for (let seed = 0; seed < 500; seed++) {
      const v = warmupSuppressWritesMs(makeRng(seed));
      expect(v).toBeGreaterThanOrEqual(30000);
      expect(v).toBeLessThanOrEqual(300000);
    }
  });

  it("typical value is around 2 minutes (120000ms)", () => {
    const N = 1000;
    const samples = Array.from({ length: N }, (_, i) =>
      warmupSuppressWritesMs(makeRng(i))
    );
    const mean = samples.reduce((a, b) => a + b, 0) / N;
    // normal(120000, 40000) mean should be near 120000
    expect(mean).toBeGreaterThan(80000);
    expect(mean).toBeLessThan(160000);
  });
});

describe("microBreakDue", () => {
  it("is not due at near-zero activity", () => {
    const rng = makeRng(42);
    const result = microBreakDue(0, rng);
    expect(result.due).toBe(false);
  });

  it("is not due at 1 second of activity", () => {
    const rng = makeRng(99);
    const result = microBreakDue(1000, rng);
    expect(result.due).toBe(false);
  });

  it("breakMs is within [20000, 600000] when due", () => {
    // Find a seed that triggers a break at high activity
