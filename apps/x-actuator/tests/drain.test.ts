import { describe, it, expect } from "vitest";
import { planDrainTimeline, drainGapMs, inQuietDrainGap } from "../src/lib/scheduler.js";
import { makeRng } from "../src/lib/rng.js";

// Per-gap like counts for a plan: for each comment, the likes that land between
// it and the next comment (the last gap runs to +Infinity).
function likesPerGap(plan: ReturnType<typeof planDrainTimeline>): number[] {
  const comments = plan.filter((a) => a.kind === "comment").map((a) => a.atMs).sort((a, b) => a - b);
  return comments.map((lo, i) => {
    const hi = comments[i + 1] ?? Infinity;
    return plan.filter((a) => a.kind === "like" && a.atMs > lo && a.atMs < hi).length;
  });
}

// Inter-reply gaps for a plan (ms).
function replyGaps(plan: ReturnType<typeof planDrainTimeline>): number[] {
  const t = plan.filter((a) => a.kind === "comment").map((a) => a.atMs).sort((a, b) => a - b);
  return t.slice(1).map((v, i) => v - t[i]!);
}

describe("planDrainTimeline (Drain all approvals)", () => {
  it("emits exactly one comment slot per approved reply", () => {
    const rng = makeRng(12345);
    const plan = planDrainTimeline({ approvedComments: 7, startMs: 1_000_000, rng });
    expect(plan.filter((a) => a.kind === "comment")).toHaveLength(7);
  });

  it("first reply lands soon (3-9s), not instantly", () => {
    const rng = makeRng(999);
    const start = 1_000_000;
    const plan = planDrainTimeline({ approvedComments: 3, startMs: start, rng });
    const firstComment = plan.filter((a) => a.kind === "comment").sort((a, b) => a.atMs - b.atMs)[0]!;
    expect(firstComment.atMs - start).toBeGreaterThanOrEqual(3_000);
    expect(firstComment.atMs - start).toBeLessThanOrEqual(9_000);
  });

  it("inter-reply gaps stay within the 1s-2min variety envelope", () => {
    const rng = makeRng(2026);
    const plan = planDrainTimeline({ approvedComments: 40, startMs: 0, rng });
    const commentTimes = plan.filter((a) => a.kind === "comment").map((a) => a.atMs).sort((x, y) => x - y);
    for (let i = 1; i < commentTimes.length; i++) {
      const gap = commentTimes[i]! - commentTimes[i - 1]!;
      expect(gap).toBeGreaterThanOrEqual(1_000);
      expect(gap).toBeLessThanOrEqual(120_000);
    }
  });

  it("shows real time variety — not a fixed cadence (some short, some long gaps)", () => {
    const rng = makeRng(7);
    const plan = planDrainTimeline({ approvedComments: 60, startMs: 0, rng });
    const t = plan.filter((a) => a.kind === "comment").map((a) => a.atMs).sort((x, y) => x - y);
    const gaps = t.slice(1).map((v, i) => v - t[i]!);
    const short = gaps.filter((g) => g < 60_000).length; // 1-60s band
    const long = gaps.filter((g) => g >= 60_000).length; // 1-2min band
    expect(short).toBeGreaterThan(0);
    expect(long).toBeGreaterThan(0);
  });

  it("every like slot lands strictly before the next reply (no overlap into the next tweet)", () => {
    const rng = makeRng(4242);
    const plan = planDrainTimeline({ approvedComments: 20, startMs: 0, rng });
    const comments = plan.filter((a) => a.kind === "comment").map((a) => a.atMs).sort((x, y) => x - y);
    const likes = plan.filter((a) => a.kind === "like").map((a) => a.atMs);
    for (const likeAt of likes) {
      // the like must sit inside SOME [comment_i, comment_{i+1}) gap
      let idx = -1;
      for (let i = 0; i < comments.length; i++) if (comments[i]! <= likeAt) idx = i;
      expect(idx).toBeGreaterThanOrEqual(0);
      const nextComment = comments[idx + 1];
      if (nextComment != null) expect(likeAt).toBeLessThan(nextComment);
    }
  });

  it("shortBandProb=1 keeps gaps in the envelope; cooldown still forces quiet pauses", () => {
    const rng = makeRng(11);
    const plan = planDrainTimeline({ approvedComments: 60, startMs: 0, rng, shortBandProb: 1 });
    const gaps = replyGaps(plan);
    // Every gap stays inside the [20s,120s] envelope. Cooldown gaps are the quiet
    // exception: they draw the NORMAL band (60-120s) even under shortBandProb=1,
    // so the ceiling is the envelope (120s), not 60s.
    for (const g of gaps) expect(g).toBeLessThanOrEqual(120_000);
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(20_000);
    // Even with the operator forcing the short band, cooldown is modal since the
    // #497 port, so a solid share of gaps are still full 60s+ pauses. (Before the
    // re-tune the short band dominated outright here; that is now by design not
    // the case — the account is meant to look idle between replies.)
    const quiet = gaps.filter((g) => g >= 60_000).length;
    expect(quiet).toBeGreaterThan(gaps.length * 0.3);
    const shortish = gaps.filter((g) => g <= 60_000).length;
    expect(shortish).toBeGreaterThan(gaps.length * 0.3);
  });

  it("drainGapMs stays in [20s,120s]", () => {
    const rng = makeRng(88);
    for (let i = 0; i < 500; i++) {
      const g = drainGapMs(rng);
      expect(g).toBeGreaterThanOrEqual(20_000);
      expect(g).toBeLessThanOrEqual(120_000);
    }
  });
});

describe("planDrainTimeline — gap patterns (X)", () => {
  it("varies the gap shape — cooldowns (zero likes), light fills, and full fills all occur", () => {
    let sawCooldown = false;
    let sawLight = false;
    let sawFull = false;
    for (let seed = 1; seed <= 60; seed++) {
      const plan = planDrainTimeline({ approvedComments: 10, startMs: 0, rng: makeRng(seed) });
      const gaps = replyGaps(plan);
      likesPerGap(plan).forEach((n, i) => {
        // A 0-like gap that is a genuine pause (60-120s) is a cooldown.
        // Since the #497 port every liking pattern lands 1-3 likes (full was
        // 4-8), so the count alone no longer separates "full" from "light" —
        // what still must vary is: quiet gaps, single-like gaps, and busier
        // (2-3 like) gaps all occur.
        if (n === 0 && (gaps[i] ?? 0) >= 60_000) sawCooldown = true;
        else if (n === 1) sawLight = true;
        else if (n >= 2) sawFull = true;
        expect(n).toBeLessThanOrEqual(3);
      });
    }
    expect(sawCooldown).toBe(true);
    expect(sawLight).toBe(true);
    expect(sawFull).toBe(true);
  });

  it("never bursts likes into a cluster — at most 8 likes in any gap (no cluster pattern on X)", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const plan = planDrainTimeline({ approvedComments: 20, startMs: 0, rng: makeRng(seed) });
      for (const n of likesPerGap(plan)) expect(n).toBeLessThanOrEqual(8);
    }
  });

  it("cooldown gaps are a real 60-120s quiet pause — no 0-like gap sits in [15s,60s)", () => {
    let sawQuietPause = false;
    for (let seed = 1; seed <= 40; seed++) {
      const plan = planDrainTimeline({ approvedComments: 20, startMs: 0, rng: makeRng(seed) });
      const gaps = replyGaps(plan);
      likesPerGap(plan).forEach((n, i) => {
        const g = gaps[i] ?? 0;
        if (n === 0) {
          // 0-like gaps are only ever a short (<15s) gap or a cooldown pause
          // (60-120s) — a cooldown must never come from the 1-60s short band.
          expect(g < 15_000 || g >= 60_000).toBe(true);
          if (g >= 60_000) sawQuietPause = true;
        }
      });
    }
    expect(sawQuietPause).toBe(true);
  });

  it("produces front-loaded and back-loaded gaps across seeds", () => {
    let sawFront = false;
    let sawBack = false;
    for (let seed = 1; seed <= 120 && !(sawFront && sawBack); seed++) {
      const plan = planDrainTimeline({ approvedComments: 12, startMs: 0, rng: makeRng(seed) });
      const comments = plan.filter((a) => a.kind === "comment").map((a) => a.atMs).sort((a, b) => a - b);
      for (let i = 0; i < comments.length - 1; i++) {
        const lo = comments[i]!;
        const gap = comments[i + 1]! - lo;
        const fracs = plan
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

  it("is deterministic for a fixed seed", () => {
    const a = planDrainTimeline({ approvedComments: 8, startMs: 0, rng: makeRng(7) });
    const b = planDrainTimeline({ approvedComments: 8, startMs: 0, rng: makeRng(7) });
    expect(a).toEqual(b);
  });

  it("explicit like knobs disable the pattern draw (every ample gap full-fills)", () => {
    // With like knobs set, patterns are off: every gap >=15s carries exactly the
    // requested 5 likes, none are cooldown-zeroed.
    const plan = planDrainTimeline({
      approvedComments: 30, startMs: 0, rng: makeRng(3),
      shortBandProb: 0, likesPerGapMin: 5, likesPerGapMax: 5,
    });
    const gaps = replyGaps(plan);
    likesPerGap(plan).forEach((n, i) => {
      if ((gaps[i] ?? 0) >= 15_000) expect(n).toBe(5);
    });
  });
});

describe("inQuietDrainGap (X)", () => {
  it("is false inside a gap that carries scheduled likes, true in a like-free gap", () => {
    const plan = [
      { kind: "comment" as const, atMs: 10_000 },
      { kind: "like" as const, atMs: 40_000 },
      { kind: "comment" as const, atMs: 100_000 },
      // gap 2 (100k -> 200k) has NO likes -> quiet (cooldown)
