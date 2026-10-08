import { describe, it, expect } from "vitest";
import { shardRoundRobin, splitBudget, shardStaggerDelayMs, runWithConcurrency, plannedShardCount } from "./shard.js";

describe("funded shard planning", () => {
  it("keeps every target on exactly one funded shard without exceeding remaining budget", () => {
    const targets = Array.from({ length: 29 }, (_, i) => i);
    for (let tokens = 1; tokens <= 25; tokens++) {
      for (let budget = 1; budget <= 25; budget++) {
        const n = plannedShardCount(tokens, budget);
        const assigned = shardRoundRobin(targets, n).flat();
        const caps = splitBudget(budget, n);
        expect(n).toBeLessThanOrEqual(tokens);
        expect(assigned.slice().sort((a, b) => a - b)).toEqual(targets);
        expect(new Set(assigned).size).toBe(targets.length);
        expect(caps.every(cap => cap >= 1)).toBe(true);
        expect(caps.reduce((sum, cap) => sum + cap, 0)).toBe(budget);
      }
    }
    expect(plannedShardCount(0, 5)).toBe(0);
    expect(plannedShardCount(5, 0)).toBe(0);
  });
});

describe("shardRoundRobin", () => {
  it("distributes items round-robin with every item in exactly one shard", () => {
    const shards = shardRoundRobin([1, 2, 3, 4, 5], 2);
    expect(shards).toEqual([
      [1, 3, 5],
      [2, 4],
    ]);
    // no duplicates, nothing lost
    expect(shards.flat().sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("each target lands in exactly one shard (dedup guarantee)", () => {
    const people = Array.from({ length: 29 }, (_, i) => `p${i}`);
    const shards = shardRoundRobin(people, 5);
    const seen = new Set(shards.flat());
    expect(seen.size).toBe(29); // no person fetched by two tokens
    expect(shards.flat().length).toBe(29); // none duplicated
    expect(shards).toHaveLength(5);
  });

  it("more shards than items → some empty shards, no crash", () => {
    expect(shardRoundRobin([1, 2], 4)).toEqual([[1], [2], [], []]);
  });

  it("empty input → n empty shards", () => {
    expect(shardRoundRobin([], 3)).toEqual([[], [], []]);
  });

  it("n<=0 collapses to a single shard (single-token setup)", () => {
    expect(shardRoundRobin([1, 2, 3], 0)).toEqual([[1, 2, 3]]);
    expect(shardRoundRobin([1, 2, 3], 1)).toEqual([[1, 2, 3]]);
  });
});

describe("splitBudget", () => {
  it("splits evenly, remainder to shard 0, sum equals total", () => {
    const b = splitBudget(80, 3); // 27, 26, 27? floor=26, rem=2 → [28,26,26]
    expect(b.reduce((a, x) => a + x, 0)).toBe(80);
    expect(b).toEqual([28, 26, 26]);
  });

  it("single shard gets the whole budget", () => {
    expect(splitBudget(50, 1)).toEqual([50]);
  });

  it("never goes negative", () => {
    expect(splitBudget(-5, 2)).toEqual([0, 0]);
  });
});

describe("shardStaggerDelayMs", () => {
  it("shard 0 starts immediately; later shards are progressively delayed", () => {
    const rng = () => 0; // no jitter → pure i*base
    expect(shardStaggerDelayMs(0, 800, rng)).toBe(0);
    expect(shardStaggerDelayMs(1, 800, rng)).toBe(800);
    expect(shardStaggerDelayMs(3, 800, rng)).toBe(2400);
  });

  it("adds bounded jitter on top of the base offset (0..base)", () => {
    // rng=0.5 → +400 jitter on a base of 800.
    expect(shardStaggerDelayMs(1, 800, () => 0.5)).toBe(1200);
    // jitter is strictly < base (floor of rng*base, rng in [0,1)).
    expect(shardStaggerDelayMs(0, 800, () => 0.999)).toBe(799);
  });

  it("base<=0 disables the stagger entirely (old behaviour: all start at once)", () => {
    expect(shardStaggerDelayMs(0, 0)).toBe(0);
    expect(shardStaggerDelayMs(5, 0)).toBe(0);
    expect(shardStaggerDelayMs(5, -100)).toBe(0);
  });

  it("never negative for a negative index", () => {
    expect(shardStaggerDelayMs(-1, 800, () => 0)).toBe(0);
  });
});


describe("runWithConcurrency", () => {
  it("never exceeds the limit in flight and returns all results in order", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = [0, 1, 2, 3, 4];
    const res = await runWithConcurrency(items, 2, async (i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // yield a few times so overlap actually happens
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return i * 10;
    });
    expect(peak).toBeLessThanOrEqual(2);
    expect(res.map((r) => (r.status === "fulfilled" ? r.value : null))).toEqual([0, 10, 20, 30, 40]);
  });

  it("a throwing item becomes a rejected result, not a thrown pool", async () => {
    const res = await runWithConcurrency([0, 1, 2], 2, async (i) => {
      if (i === 1) throw new Error("boom");
      return i;
    });
    expect(res[0]).toEqual({ status: "fulfilled", value: 0 });
    expect(res[1]?.status).toBe("rejected");
    expect((res[1] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect(res[2]).toEqual({ status: "fulfilled", value: 2 });
  });

  it("limit >= item count runs them all without capping below the count", async () => {
    let peak = 0;
    let inFlight = 0;
    const res = await runWithConcurrency([0, 1, 2], 10, async (i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return i;
    });
    expect(peak).toBe(3);
    expect(res).toHaveLength(3);
  });

  it("limit<=0 is clamped to 1 (serial), never unlimited", async () => {
    let inFlight = 0;
    let peak = 0;
    await runWithConcurrency([0, 1, 2, 3], 0, async (i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return i;
    });
    expect(peak).toBe(1);
  });

  it("empty input → empty results, fn never called", async () => {
    let calls = 0;
    const res = await runWithConcurrency([], 3, async (i) => {
      calls++;
      return i;
    });
    expect(res).toEqual([]);
    expect(calls).toBe(0);
  });
});

describe("shard count is non-finite", () => {
  it("clamps NaN/Infinity to a single shard instead of building zero groups", () => {
    // Math.max(1, Math.floor(NaN)) is NaN, which produced an empty group array
    // and then threw on the first out[i % n].push.
    for (const n of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const groups = shardRoundRobin([1, 2, 3], n);
      expect(groups.length).toBeGreaterThanOrEqual(1);
      expect(groups.flat().sort()).toEqual([1, 2, 3]);
    }
  });

  it("splitBudget survives a non-finite shard count too", () => {
    expect(splitBudget(100, Number.NaN)).toEqual([100]);
  });
});
