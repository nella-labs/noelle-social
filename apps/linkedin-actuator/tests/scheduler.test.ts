import { describe, it, expect } from "vitest";
import { planTimeline, planDrainTimeline, inQuietDrainGap, pickDrainArchetype } from "../src/lib/scheduler.js";
import { makeRng } from "../src/lib/rng.js";
import { WRITE_CURFEW_ENABLED } from "../src/lib/curfew.js";

// Per-gap like counts for a plan: for each comment, the likes that land between
// it and the next comment (the last gap runs to +Infinity).
function likesPerGap(actions: ReturnType<typeof planDrainTimeline>): number[] {
  const comments = actions.filter((a) => a.kind === "comment").map((a) => a.atMs).sort((a, b) => a - b);
  return comments.map((lo, i) => {
    const hi = comments[i + 1] ?? Infinity;
    return actions.filter((a) => a.kind === "like" && a.atMs > lo && a.atMs < hi).length;
  });
}

describe("planDrainTimeline", () => {
  it("schedules one comment per approved draft + 0-3 likes per gap", () => {
    // 2026-07-23 quiet re-tune: no gap pattern places more than 3 likes (the
    // old full fill was 4-9 — the "10 likes before a reply" shape).
    for (let seed = 1; seed <= 40; seed++) {
      const actions = planDrainTimeline({ approvedComments: 5, startMs: 1_000_000, rng: makeRng(seed) });
      expect(actions.filter((a) => a.kind === "comment")).toHaveLength(5);
      for (const n of likesPerGap(actions)) {
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(3);
      }
    }
  });

  it("spaces replies ≥1 min apart with a widened, heavy-tailed gap, monotonically", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const t = planDrainTimeline({ approvedComments: 6, startMs: 0, rng: makeRng(seed) })
        .filter((a) => a.kind === "comment")
        .map((a) => a.atMs);
      for (let i = 1; i < t.length; i++) {
        const gap = t[i]! - t[i - 1]!;
        // Never below the 60s floor; the widened body (≤150s×1.5) plus an
        // occasional "stepped away" pause (≤+90s) caps the tail at 315s.
        // (Cooldown gaps sit inside this band too: flat 60-180s.)
        expect(gap).toBeGreaterThanOrEqual(60_000);
        expect(gap).toBeLessThanOrEqual(315_000);
      }
    }
  });

  it("varies the gap shape — quiet gaps dominate but single likes and multi-like fills still occur", () => {
    let quiet = 0;
    let single = 0;
    let multi = 0;
    let total = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const actions = planDrainTimeline({ approvedComments: 8, startMs: 0, rng: makeRng(seed) });
      for (const n of likesPerGap(actions)) {
        total++;
        if (n === 0) quiet++;
        else if (n === 1) single++;
        else multi++;
      }
    }
    // All three shapes occur — the gap mix still varies…
    expect(quiet).toBeGreaterThan(0);
    expect(single).toBeGreaterThan(0);
    expect(multi).toBeGreaterThan(0);
    // …but the 2026-07-23 quiet re-tune makes the like-free gap the modal one
    // (cooldown weight 0.46), so most waits before a reply show ZERO likes.
    expect(quiet / total).toBeGreaterThan(0.35);
    expect(quiet).toBeGreaterThan(multi);
  });

  it("produces front-loaded and back-loaded gaps across seeds", () => {
    let sawFront = false;
    let sawBack = false;
    for (let seed = 1; seed <= 120 && !(sawFront && sawBack); seed++) {
      const actions = planDrainTimeline({ approvedComments: 8, startMs: 0, rng: makeRng(seed) });
      const comments = actions.filter((a) => a.kind === "comment").map((a) => a.atMs).sort((a, b) => a - b);
      for (let i = 0; i < comments.length - 1; i++) {
        const lo = comments[i]!;
        const gap = comments[i + 1]! - lo;
        const fracs = actions
          .filter((a) => a.kind === "like" && a.atMs > lo && a.atMs < lo + gap)
          .map((a) => (a.atMs - lo) / gap);
        if (fracs.length < 2) continue;
        if (fracs.every((f) => f <= 0.45)) sawFront = true;
        if (fracs.every((f) => f >= 0.55)) sawBack = true;
      }
    }
    expect(sawFront).toBe(true);
    expect(sawBack).toBe(true);
  });

  it("keeps every like inside its gap's placement band", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const actions = planDrainTimeline({ approvedComments: 6, startMs: 0, rng: makeRng(seed) });
      const comments = actions.filter((a) => a.kind === "comment").map((a) => a.atMs).sort((a, b) => a - b);
      for (const like of actions.filter((a) => a.kind === "like")) {
        const prev = Math.max(...comments.filter((c) => c <= like.atMs));
        expect(like.atMs - prev).toBeGreaterThanOrEqual(10_000); // room to return to the feed
        const next = Math.min(...comments.filter((c) => c > like.atMs));
        if (Number.isFinite(next)) expect(next - like.atMs).toBeGreaterThanOrEqual(5_000);
      }
    }
  });

  it("is deterministic for a fixed seed", () => {
    const a = planDrainTimeline({ approvedComments: 5, startMs: 0, rng: makeRng(7) });
    const b = planDrainTimeline({ approvedComments: 5, startMs: 0, rng: makeRng(7) });
    expect(a).toEqual(b);
  });

  it("is empty for zero approved comments", () => {
    expect(planDrainTimeline({ approvedComments: 0, startMs: 0, rng: makeRng(1) })).toEqual([]);
  });

  it("honors custom gap + like knobs (explicit knobs disable the pattern draw)", () => {
    const actions = planDrainTimeline({
      approvedComments: 3, startMs: 0, rng: makeRng(2),
      gapMinMs: 30_000, gapMaxMs: 30_000, likesPerGapMin: 2, likesPerGapMax: 2,
    });
    expect(actions.filter((a) => a.kind === "like")).toHaveLength(6); // 3 gaps × 2, every gap
    const ct = actions.filter((a) => a.kind === "comment").map((a) => a.atMs);
    expect(ct[1]! - ct[0]!).toBe(30_000);
  });
});

describe("inQuietDrainGap", () => {
  const plan = [
    { kind: "comment" as const, atMs: 10_000 },
    { kind: "like" as const, atMs: 40_000 },   // gap 1 has a like → not quiet
    { kind: "comment" as const, atMs: 100_000 },
    // gap 2 (100k → 200k) has NO likes → quiet (the cooldown pattern)
    { kind: "comment" as const, atMs: 200_000 },
    { kind: "like" as const, atMs: 230_000 },  // tail gap has a like → not quiet
  ];

  it("is false inside a gap that carries scheduled likes", () => {
    expect(inQuietDrainGap(plan, 50_000)).toBe(false);
  });

  it("is true inside a like-free cooldown gap", () => {
    expect(inQuietDrainGap(plan, 150_000)).toBe(true);
  });

  it("handles the tail gap after the last comment", () => {
    expect(inQuietDrainGap(plan, 220_000)).toBe(false);
    const quietTail = plan.slice(0, 4); // last comment with nothing after it
    expect(inQuietDrainGap(quietTail, 220_000)).toBe(true);
  });

  it("agrees with planDrainTimeline: quiet exactly where a gap has no likes", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const actions = planDrainTimeline({ approvedComments: 6, startMs: 0, rng: makeRng(seed) });
      const comments = actions.filter((a) => a.kind === "comment").map((a) => a.atMs).sort((a, b) => a - b);
      for (let i = 0; i < comments.length - 1; i++) {
        const lo = comments[i]!;
        const hi = comments[i + 1]!;
        const hasLikes = actions.some((a) => a.kind === "like" && a.atMs > lo && a.atMs < hi);
        const mid = lo + Math.floor((hi - lo) / 2);
        expect(inQuietDrainGap(actions, mid)).toBe(!hasLikes);
      }
    }
  });
});

describe("pickDrainArchetype — per-session temperament", () => {
  it("is deterministic per seed and varies across seeds", () => {
    expect(pickDrainArchetype(makeRng(5))).toEqual(pickDrainArchetype(makeRng(5)));
    const styles = Array.from({ length: 40 }, (_, i) => pickDrainArchetype(makeRng(i + 1)));
    // Different sessions get materially different pattern mixes + tempos.
    const uniqueTempos = new Set(styles.map((s) => s.gapMaxMs));
    expect(uniqueTempos.size).toBeGreaterThan(10);
    const firstWeights = styles.map((s) => s.patternWeights[0]!.toFixed(4));
    expect(new Set(firstWeights).size).toBeGreaterThan(10);
  });

  it("never draws a tempo faster than the 150s default and always a full 6-weight vector", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const s = pickDrainArchetype(makeRng(seed));
      expect(s.gapMaxMs).toBeGreaterThanOrEqual(150_000); // never faster than default
      expect(s.gapMaxMs).toBeLessThanOrEqual(255_000);
      expect(s.patternWeights).toHaveLength(6);
      for (const w of s.patternWeights) expect(w).toBeGreaterThan(0); // every pattern reachable
      // No break, or a real multi-minute one bounded by the widest archetype band.
      expect(s.longBreakMs === 0 || (s.longBreakMs >= 300_000 && s.longBreakMs <= 720_000)).toBe(true);
    }
  });

  it("some sessions are break-prone and some never break (temperament varies)", () => {
    const styles = Array.from({ length: 120 }, (_, i) => pickDrainArchetype(makeRng(i + 1)));
    expect(styles.some((s) => s.longBreakMs > 0)).toBe(true);
    expect(styles.some((s) => s.longBreakMs === 0)).toBe(true);
  });
});

describe("planDrainTimeline — session archetype opts", () => {
  it("a per-session pattern-weight vector shifts the gap mix without exceeding the like envelope", () => {
    // A cooldown-heavy vector yields many more zero-like gaps than a full-heavy one.
    const cooldownHeavy = [0.1, 0.6, 0.15, 0.05, 0.05, 0.05];
    const fullHeavy = [0.7, 0.05, 0.1, 0.05, 0.05, 0.05];
    let quietUnderCooldown = 0;
    let quietUnderFull = 0;
