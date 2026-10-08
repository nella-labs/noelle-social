import { describe, it, expect } from "vitest";
import {
  rollLikeSkip,
  LIKE_SKIP_BASE,
  LIKE_SKIP_MIN,
  LIKE_SKIP_MAX,
  LIKE_SKIP_REROLL_EVERY,
  type LikeSkipState,
} from "../src/lib/like-skip.js";

// A rand() that yields a fixed queue of values, then repeats the last one.
function seq(...vals: number[]): () => number {
  let i = 0;
  return () => vals[Math.min(i++, vals.length - 1)]!;
}

describe("rollLikeSkip", () => {
  it("starts at the 2% base rate on a fresh run", () => {
    // rand=0.5 (>0.02) → keep the like; state initialised to base/1.
    const { skip, next } = rollLikeSkip(undefined, seq(0.5));
    expect(skip).toBe(false);
    expect(next.prob).toBe(LIKE_SKIP_BASE);
    expect(next.count).toBe(1);
  });

  it("skips when the draw is under the current probability", () => {
    const { skip } = rollLikeSkip(undefined, seq(0.001)); // 0.001 < 0.02
    expect(skip).toBe(true);
  });

  it("keeps the like when the draw is at or above the probability", () => {
    const { skip } = rollLikeSkip({ prob: 0.02, count: 5 }, seq(0.02));
    expect(skip).toBe(false);
  });

  it("holds the rate steady between re-rolls (off-cadence counts don't re-roll)", () => {
    const { next } = rollLikeSkip({ prob: 0.037, count: 5 }, seq(0.9));
    expect(next.prob).toBe(0.037); // unchanged
    expect(next.count).toBe(6);
  });

  it("re-rolls the rate every 123rd reply-reaction, into [MIN, MAX]", () => {
    // count 122 → 123 triggers a re-roll; first draw feeds the re-roll, second the skip.
    const hi = rollLikeSkip({ prob: 0.02, count: LIKE_SKIP_REROLL_EVERY - 1 }, seq(1, 0.9));
    expect(hi.next.count).toBe(LIKE_SKIP_REROLL_EVERY);
    expect(hi.next.prob).toBeCloseTo(LIKE_SKIP_MAX, 10); // rand=1 → ceiling

    const lo = rollLikeSkip({ prob: 0.02, count: LIKE_SKIP_REROLL_EVERY - 1 }, seq(0, 0.9));
    expect(lo.next.prob).toBeCloseTo(LIKE_SKIP_MIN, 10); // rand=0 → floor
  });

  it("keeps the drifting rate within [MIN, MAX] across many re-rolls", () => {
    let st: LikeSkipState | undefined;
    const rand = (() => {
      // deterministic pseudo-values in [0,1)
      let x = 0.123;
      return () => (x = (x * 9301 + 0.49297) % 1);
    })();
    for (let i = 0; i < LIKE_SKIP_REROLL_EVERY * 5; i++) {
      st = rollLikeSkip(st, rand).next;
      expect(st.prob).toBeGreaterThanOrEqual(LIKE_SKIP_MIN);
      expect(st.prob).toBeLessThanOrEqual(LIKE_SKIP_MAX);
    }
  });
});
