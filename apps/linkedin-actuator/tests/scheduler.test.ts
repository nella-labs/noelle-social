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
    for (let seed = 1; seed <= 30; seed++) {
      const a = planDrainTimeline({ approvedComments: 12, startMs: 0, rng: makeRng(seed), patternWeights: cooldownHeavy });
      const b = planDrainTimeline({ approvedComments: 12, startMs: 0, rng: makeRng(seed), patternWeights: fullHeavy });
      quietUnderCooldown += likesPerGap(a).filter((n) => n === 0).length;
      quietUnderFull += likesPerGap(b).filter((n) => n === 0).length;
      // Never exceeds the 0-3 per-gap like envelope regardless of the vector.
      for (const n of likesPerGap(a).concat(likesPerGap(b))) expect(n).toBeLessThanOrEqual(3);
    }
    expect(quietUnderCooldown).toBeGreaterThan(quietUnderFull);
  });

  it("a widened gapMaxMs only slows the drain — floor stays 60s, gaps run slower than the default band", () => {
    const gapsOf = (rngSeed: number, gapMaxMs?: number) => {
      const t = planDrainTimeline({ approvedComments: 60, startMs: 0, rng: makeRng(rngSeed), ...(gapMaxMs ? { gapMaxMs } : {}) })
        .filter((a) => a.kind === "comment").map((a) => a.atMs);
      return t.slice(1).map((v, i) => v - t[i]!);
    };
    const wide = gapsOf(9, 255_000);
    const def = gapsOf(9); // same rng stream, default 150s band
    for (const g of wide) expect(g).toBeGreaterThanOrEqual(60_000); // floor never lowered
    const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
    // A wider band is same-or-slower everywhere and strictly slower on average.
    expect(mean(wide)).toBeGreaterThan(mean(def));
  });

  it("longBreakMs inserts exactly one quiet long pause that shifts the rest later", () => {
    const seedsWithBreak: number[] = [];
    // The break decision derives from (startMs, approvedComments) via a separate
    // rng (in production startMs is a fresh wall-clock ms), so vary startMs here.
    for (let seed = 1; seed <= 20; seed++) {
      const startMs = seed * 100_000;
      const withBreak = planDrainTimeline({ approvedComments: 8, startMs, rng: makeRng(seed), longBreakMs: 600_000 });
      const comments = withBreak.filter((a) => a.kind === "comment").map((a) => a.atMs).sort((x, y) => x - y);
      const gaps = comments.slice(1).map((v, i) => v - comments[i]!);
      // Non-break gaps use the default 150s band (tail ≤ 315s), so only the break
      // gap can reach 600s — exactly one when a break fires.
      const longGaps = gaps.filter((g) => g >= 600_000);
      if (longGaps.length > 0) {
        seedsWithBreak.push(seed);
        expect(longGaps).toHaveLength(1); // exactly one break per batch
        const idx = gaps.findIndex((g) => g >= 600_000);
        const lo = comments[idx]!;
        const hi = comments[idx + 1]!;
        // The break gap is QUIET: no like slots inside it → idle-likes stay out.
        const likesInBreak = withBreak.filter((a) => a.kind === "like" && a.atMs > lo && a.atMs < hi).length;
        expect(likesInBreak).toBe(0);
        expect(inQuietDrainGap(withBreak, lo + Math.floor((hi - lo) / 2))).toBe(true);
      }
    }
    expect(seedsWithBreak.length).toBeGreaterThan(0); // breaks actually fire across sessions
  });

  it("an all-frontload vector puts every like in the first ~40%; all-backload in the last ~40%", () => {
    // Forcing the pattern via the weight vector makes the placement UNAMBIGUOUS
    // (an existence check can't tell a frontload gap from a light gap that lands
    // early by chance). [full,cooldown,light,frontload,backload,cluster].
    const front = planDrainTimeline({ approvedComments: 20, startMs: 0, rng: makeRng(3), patternWeights: [0, 0, 0, 1, 0, 0] });
    const back = planDrainTimeline({ approvedComments: 20, startMs: 0, rng: makeRng(3), patternWeights: [0, 0, 0, 0, 1, 0] });
    const fracs = (plan: ReturnType<typeof planDrainTimeline>) => {
      const comments = plan.filter((a) => a.kind === "comment").map((a) => a.atMs).sort((x, y) => x - y);
      const out: number[] = [];
      for (const like of plan.filter((a) => a.kind === "like")) {
        const lo = Math.max(...comments.filter((c) => c <= like.atMs));
        const hi = Math.min(...comments.filter((c) => c > like.atMs));
        if (Number.isFinite(hi)) out.push((like.atMs - lo) / (hi - lo));
      }
      return out;
    };
    const ff = fracs(front);
    const bf = fracs(back);
    expect(ff.length).toBeGreaterThan(10); // frontload actually places likes
    expect(bf.length).toBeGreaterThan(10);
    for (const f of ff) expect(f).toBeLessThanOrEqual(0.45); // every frontload like in the first ~40%
    for (const f of bf) expect(f).toBeGreaterThanOrEqual(0.55); // every backload like in the last ~40%
  });

  it("explicit like knobs disable the pattern-weight draw (weights ignored, every gap full-fills)", () => {
    // patternWeights alongside like knobs: patterns are OFF (patterned=false), so
    // the weights are ignored. An all-cooldown vector WOULD zero every gap's likes
    // if it applied — asserting every gap carries exactly the knob count proves it
    // does not.
    const plan = planDrainTimeline({
      approvedComments: 20, startMs: 0, rng: makeRng(4),
      patternWeights: [0, 1, 0, 0, 0, 0], // all-cooldown, i.e. zero likes — IF it applied
      likesPerGapMin: 5, likesPerGapMax: 5,
    });
    for (const n of likesPerGap(plan)) expect(n).toBe(5); // knobs win; weights ignored
  });

  it("handles tiny queues and the long-break eligibility boundary (n<3 never breaks)", () => {
    expect(planDrainTimeline({ approvedComments: 0, startMs: 0, rng: makeRng(1), longBreakMs: 600_000 })).toEqual([]);
    const one = planDrainTimeline({ approvedComments: 1, startMs: 0, rng: makeRng(1), longBreakMs: 600_000 });
    expect(one.filter((a) => a.kind === "comment")).toHaveLength(1);
    // n=2 is below the break-eligibility floor (approvedComments >= 3): no 600s
    // break can appear at any startMs (non-break gaps use the default band, ≤315s).
    for (let seed = 1; seed <= 40; seed++) {
      const two = planDrainTimeline({ approvedComments: 2, startMs: seed * 100_000, rng: makeRng(seed), longBreakMs: 600_000 });
      const c = two.filter((a) => a.kind === "comment").map((a) => a.atMs).sort((x, y) => x - y);
      expect(c[1]! - c[0]!).toBeLessThan(600_000);
    }
    // n=3 is the minimum eligible; a break (index ∈ {0,1}) can fire.
    let sawBreakAt3 = false;
    for (let seed = 1; seed <= 60 && !sawBreakAt3; seed++) {
      const three = planDrainTimeline({ approvedComments: 3, startMs: seed * 100_000, rng: makeRng(seed), longBreakMs: 600_000 });
      const c = three.filter((a) => a.kind === "comment").map((a) => a.atMs).sort((x, y) => x - y);
      if (c.some((_, i) => i > 0 && c[i]! - c[i - 1]! >= 600_000)) sawBreakAt3 = true;
    }
    expect(sawBreakAt3).toBe(true);
  });

  it("is deterministic for a fixed seed + opts", () => {
    const opts = { approvedComments: 8, startMs: 0, patternWeights: [0.3, 0.3, 0.1, 0.1, 0.1, 0.1], gapMaxMs: 200_000, longBreakMs: 500_000 };
    const a = planDrainTimeline({ ...opts, rng: makeRng(7) });
    const b = planDrainTimeline({ ...opts, rng: makeRng(7) });
    expect(a).toEqual(b);
  });

  it("scales the cooldown pause with the session tempo — no archetype-independent 180s ceiling", () => {
    // With cooldown the modal draw, a FIXED 180s cap made every temperament's
    // quiet gap the same uniform[60s,180s] and sped slow archetypes up on mean
    // (the #471 "floor+ceiling intact ≠ same velocity" trap). The cap is now
    // gapMax × 1.2: byte-identical at the default 150s band, longer for slow
    // sessions. Forced all-cooldown vector isolates the cooldown draw.
    const allCooldown = [0, 1, 0, 0, 0, 0];
    const gapsUnder = (gapMaxMs?: number) => {
      const out: number[] = [];
      for (let seed = 1; seed <= 40; seed++) {
        const t = planDrainTimeline({
          approvedComments: 8, startMs: 0, rng: makeRng(seed),
          patternWeights: allCooldown, ...(gapMaxMs ? { gapMaxMs } : {}),
        }).filter((a) => a.kind === "comment").map((a) => a.atMs);
        for (let i = 1; i < t.length; i++) out.push(t[i]! - t[i - 1]!);
      }
      return out;
    };
    const slow = gapsUnder(255_000); // lurker's slowest tempo
    const def = gapsUnder();         // default 150s band
    const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
    for (const g of def) {
      expect(g).toBeGreaterThanOrEqual(60_000);
      expect(g).toBeLessThanOrEqual(180_000); // default band: exactly the old cap
    }
    for (const g of slow) {
      expect(g).toBeGreaterThanOrEqual(60_000);
      expect(g).toBeLessThanOrEqual(306_000); // 255s × 1.2
    }
    expect(Math.max(...slow)).toBeGreaterThan(200_000); // a flat 180s cap would forbid this
    expect(mean(slow)).toBeGreaterThan(mean(def)); // quiet-pause tempo tracks the archetype
  });

  it("keeps drain gaps mostly quiet — mean ≤ ~1 like/gap, median ≤ 1, max 3 (2026-07-23 re-tune)", () => {
    // The production path: an archetype drawn per session, its jittered weight
    // vector + tempo + break fed into the planner. Distribution asserted on
    // mean AND median (a reshaped distribution can keep its floor/ceiling while
    // its mean drifts — the #471 lesson), against the old baseline of ~3.4
    // likes/gap under the 4-9 full fill.
    const perGap: number[] = [];
    for (let seed = 1; seed <= 200; seed++) {
      const style = pickDrainArchetype(makeRng(seed + 1000));
      const actions = planDrainTimeline({
        approvedComments: 8, startMs: seed * 100_000, rng: makeRng(seed),
        patternWeights: style.patternWeights, gapMaxMs: style.gapMaxMs, longBreakMs: style.longBreakMs,
      });
      perGap.push(...likesPerGap(actions));
    }
    const sorted = perGap.slice().sort((a, b) => a - b);
    const mean = perGap.reduce((s, v) => s + v, 0) / perGap.length;
    const median = sorted[Math.floor(sorted.length / 2)]!;
    expect(mean).toBeGreaterThan(0.2);      // still SOME liking — the account isn't dead
    expect(mean).toBeLessThanOrEqual(1.2);  // was ~3.4 before the re-tune
    expect(median).toBeLessThanOrEqual(1);  // the typical wait shows 0-1 likes
    expect(Math.max(...perGap)).toBeLessThanOrEqual(3); // never a like-burst before a reply
  });
});

const caps = { likes: 120, comments: 80, dms: 10 };
const start = 1_750_000_000_000; // fixed epoch ms

function plan(over?: Partial<Parameters<typeof planTimeline>[0]>) {
  return planTimeline({
    params: { windowHours: 8, targetComments: 30, targetLikes: 60 },
    approvedDms: 2,
    caps,
    startMs: start,
    deepNightTaper: false,
    rng: makeRng(123),
    ...over,
  });
}

// Helpers
function computeCV(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function lag1Autocorrelation(values: number[]): number {
  if (values.length < 3) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < values.length - 1; i++) {
    num += (values[i]! - mean) * (values[i + 1]! - mean);
  }
  for (const v of values) den += (v - mean) ** 2;
  if (den === 0) return 0;
  return num / den;
}

describe("planTimeline", () => {
  // ── PRESERVED: non-exact (±20%) counts ──────────────────────────────────────
  it("emits action counts within the volume band (0.72x–1.2x of target)", () => {
    const { actions } = plan();
    const comments = actions.filter((a) => a.kind === "comment").length;
    const likes = actions.filter((a) => a.kind === "like").length;
    const dms = actions.filter((a) => a.kind === "dm").length;
    // targets: comments=30, likes=60, dms=2. Volume factor widened DOWN to 0.72
    // floor (fewer on average = safer) with the 1.2 cap unchanged (never more).
    expect(comments).toBeGreaterThanOrEqual(Math.floor(0.72 * 30));
    expect(comments).toBeLessThanOrEqual(Math.ceil(1.2 * 30));
    expect(likes).toBeGreaterThanOrEqual(Math.floor(0.72 * 60));
    expect(likes).toBeLessThanOrEqual(Math.ceil(1.2 * 60));
    expect(dms).toBeGreaterThanOrEqual(Math.floor(0.72 * 2));
    expect(dms).toBeLessThanOrEqual(Math.ceil(1.2 * 2));
  });

  // ── PRESERVED: window bounds ─────────────────────────────────────────────────
  it("keeps every action inside [start, start+window]", () => {
    const { actions } = plan();
    const end = start + 8 * 3600_000;
    for (const a of actions) {
      expect(a.atMs).toBeGreaterThanOrEqual(start);
      expect(a.atMs).toBeLessThanOrEqual(end);
    }
  });

  // ── PRESERVED: sorted ascending ──────────────────────────────────────────────
  it("returns actions sorted ascending by time", () => {
    const { actions } = plan();
    for (let i = 1; i < actions.length; i++) {
      expect(actions[i]!.atMs).toBeGreaterThanOrEqual(actions[i - 1]!.atMs);
    }
  });

  // ── PRESERVED: first action fires quickly ────────────────────────────────────
  it("fires the first action within 8s of startMs", () => {
    const { actions } = plan();
    expect(actions[0]!.atMs).toBeLessThanOrEqual(start + 8_000);
  });

  // ── UPDATED: clamp is tested against the post-volume-variation actual value ──
  it("clamps targets above caps and records the clamp", () => {
    const { actions, clamps } = plan({
      params: { windowHours: 8, targetComments: 200, targetLikes: 60 },
    });
    // 200 * up-to-1.2 = 240, still above cap 80 → clamped
    expect(actions.filter((a) => a.kind === "comment").length).toBeLessThanOrEqual(80);
    // A ClampNote must appear for comment
    expect(clamps.some((c) => c.kind === "comment")).toBe(true);
  });

  // ── PRESERVED: determinism per seed ─────────────────────────────────────────
  it("is deterministic for a fixed seed", () => {
    expect(plan().actions).toEqual(plan().actions);
  });

  // ── NEW: inter-action CV in human band [0.8, 2.0] ───────────────────────────
  it("inter-action CV is in the human band [0.8, 2.0]", () => {
    // Use a large action set over 8h daytime to get a meaningful CV sample.
    // Start at noon UTC so no curfew interference.
    const noonStart = new Date("2025-01-15T12:00:00.000Z").getTime();
    const { actions } = planTimeline({
      params: { windowHours: 8, targetComments: 30, targetLikes: 60 },
      approvedDms: 0,
      caps,
      startMs: noonStart,
      deepNightTaper: false,
      rng: makeRng(42),
    });
    const gaps: number[] = [];
    for (let i = 1; i < actions.length; i++) {
      gaps.push(actions[i]!.atMs - actions[i - 1]!.atMs);
    }
    const cv = computeCV(gaps);
    expect(cv).toBeGreaterThanOrEqual(0.8);
    expect(cv).toBeLessThanOrEqual(2.0);
  });

  // ── overnight curfew [23:00, 06:00) — toggle-aware ─────────────────────────
  // The curfew is a single switch (src/lib/curfew.ts, WRITE_CURFEW_ENABLED).
  // When ON, the scheduler shifts writes out of the band; when OFF (current
  // operator setting), actions may land at any hour.
  it("honors the WRITE_CURFEW_ENABLED switch for the overnight band", () => {
    // Window that spans local 22:00→08:00 (10h), crossing midnight.
    const eveningStart = (() => {
      const d = new Date("2025-01-15T12:00:00.000Z"); // noon UTC as base
      const localHour = d.getHours();
      d.setTime(d.getTime() + (22 - localHour) * 3600_000);
      return d.getTime();
    })();
    const { actions } = planTimeline({
      params: { windowHours: 10, targetComments: 20, targetLikes: 40 },
      approvedDms: 2,
      caps,
      startMs: eveningStart,
      deepNightTaper: false,
      rng: makeRng(99),
    });
    const anyInCurfew = actions.some((a) => {
      const h = new Date(a.atMs).getHours();
      return h >= 23 || h < 6;
    });
    if (WRITE_CURFEW_ENABLED) {
      expect(anyInCurfew).toBe(false); // curfew ON → nothing in the band
    } else {
      // curfew OFF (current) → the 10h window straddling midnight DOES place
      // writes overnight; the point of disabling it is exactly this.
      expect(anyInCurfew).toBe(true);
    }
  });

  // ── AR(1) fingerprint — lag-1 autocorrelation of gaps ──────────────────────
  // The per-action tempo is an AR(1) process (rho in [0.2,0.6]), so WITHIN a
  // burst gaps are positively autocorrelated. Any single session also mixes in
  // between-burst idle jumps (a long gap, then the next cluster resumes) that
  // offset that correlation, so ONE session's pooled lag-1 ACF is noisy and
  // centred near zero. The fingerprint shows up robustly as a POSITIVE MEAN
  // across sessions, while no single session is strongly anti-correlated (a
  // sawtooth would be the mechanical tell). Widening the schedule variance
  // widened the per-session ACF SPREAD but left the mean positive — so this
  // asserts the mean over many sessions (stronger than the old single-seed
  // check), plus a worst-case floor. Measured across seeds 1..80: mean ≈ +0.037,
  // worst ≈ -0.13.
  it("keeps a positive-mean AR(1) fingerprint with no strongly anti-correlated session", () => {
    const noonStart = new Date("2025-01-15T12:00:00.000Z").getTime();
    const N = 80;
    let sum = 0;
    let worst = 1;
    for (let seed = 1; seed <= N; seed++) {
      const { actions } = planTimeline({
        params: { windowHours: 8, targetComments: 30, targetLikes: 60 },
        approvedDms: 0,
        caps,
        startMs: noonStart,
        deepNightTaper: false,
        rng: makeRng(seed),
      });
      const gaps: number[] = [];
      for (let i = 1; i < actions.length; i++) {
        gaps.push(actions[i]!.atMs - actions[i - 1]!.atMs);
      }
      const acf = lag1Autocorrelation(gaps);
      sum += acf;
      worst = Math.min(worst, acf);
    }
    // AR(1) tempo present on average, and no session is a mechanical sawtooth.
    expect(sum / N).toBeGreaterThan(0.01); // measured ≈ +0.037
    expect(worst).toBeGreaterThan(-0.2); // measured floor ≈ -0.13
  });

  // ── NEW: ±20% volume variation — multiple seeds never all produce the same count ─
  it("total action count varies across seeds (±20% volume jitter)", () => {
    const counts = [1, 2, 3, 4, 5].map((seed) =>
      planTimeline({
        params: { windowHours: 8, targetComments: 30, targetLikes: 60 },
        approvedDms: 2,
        caps,
        startMs: start,
        deepNightTaper: false,
        rng: makeRng(seed),
      }).actions.length,
    );
    // Not all identical
    const allSame = counts.every((c) => c === counts[0]);
    expect(allSame).toBe(false);
  });

  // ── NEW: ClampNote emitted when volume variation pushes over cap ─────────────
  it("records a ClampNote when ±20% volume variation would exceed a cap", () => {
    // Set target = cap so +20% always exceeds
    const tightCaps = { likes: 60, comments: 30, dms: 2 };
    // Run many seeds; at least one should exceed and record a clamp
    const clampSeen = [10, 20, 30, 40, 50].some((seed) => {
      const { clamps } = planTimeline({
        params: { windowHours: 8, targetComments: 30, targetLikes: 60 },
        approvedDms: 2,
        caps: tightCaps,
        startMs: start,
        deepNightTaper: false,
        rng: makeRng(seed),
      });
      return clamps.length > 0;
    });
    expect(clampSeen).toBe(true);
  });
});

