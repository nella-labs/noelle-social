import { describe, it, expect } from "vitest";
import { shardRoundRobin, splitBudget, shardStaggerDelayMs, runWithConcurrency, plannedShardCount } from "./shard.js";

describe("plannedShardCount", () => {
  it("caps shard count at the remaining budget so no shard gets 0 (the starvation bug)", () => {
    // 11 tokens, only 8 leads of budget left: the old code split 8 across 11
    // shards -> [8,0,0,...] and stranded every subreddit not on shard 0.
    const k = plannedShardCount(11, 8);
    expect(k).toBe(8);
    // Every funded shard now gets >= 1 (no zero-budget shard).
    expect(splitBudget(8, k).every((b) => b >= 1)).toBe(true);
  });

  it("is a no-op (== token count) when budget covers every token", () => {
    expect(plannedShardCount(3, 80)).toBe(3);
    expect(splitBudget(80, plannedShardCount(3, 80))).toEqual(splitBudget(80, 3));
  });

  it("returns 0 when the budget is spent or the pool is empty (caller skips the tick)", () => {
    expect(plannedShardCount(11, 0)).toBe(0);
    expect(plannedShardCount(0, 80)).toBe(0);
    expect(plannedShardCount(-2, 5)).toBe(0);
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
    expect(shardStaggerDelayMs(1, 800, () => 0.5)).toBe(1200);
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

  it("limit <= 0 is clamped to 1 (serial), never unlimited", async () => {
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
