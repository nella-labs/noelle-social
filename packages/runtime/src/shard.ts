// Split work across N Apify tokens for concurrent discovery. Round-robin so each
// shard gets a balanced, interleaved slice, and — critically — every item lands
// in EXACTLY ONE shard, so two tokens never fetch the same person/keyword at the
// same time. Pure + unit-tested.
export function shardRoundRobin<T>(items: readonly T[], shards: number): T[][] {
  // Math.floor(NaN) is NaN and Math.max(1, NaN) is NaN, so a non-finite count
  // would build ZERO groups and then throw on the first `out[i % n].push`.
  // Clamp non-finite to 1 rather than crashing the caller's tick.
  const n = Number.isFinite(shards) ? Math.max(1, Math.floor(shards)) : 1;
  const out: T[][] = Array.from({ length: n }, () => []);
  items.forEach((item, i) => out[i % n]!.push(item));
  return out;
}

/** Launch only shards with at least one remaining extract slot. */
export function plannedShardCount(tokenCount: number, remainingCap: number): number {
  const tokens = Math.max(0, Math.floor(tokenCount));
  const cap = Math.max(0, Math.floor(remainingCap));
  if (tokens === 0 || cap === 0) return 0;
  return Math.min(tokens, cap);
}

/**
 * Split a daily extract budget across N shards. Each shard gets an equal floor;
 * the remainder goes to shard 0. Sum equals the original budget, so concurrent
 * shards never collectively exceed the cap (no shared-counter race).
 */
export function splitBudget(total: number, shards: number): number[] {
  const n = Number.isFinite(shards) ? Math.max(1, Math.floor(shards)) : 1;
  const base = Math.floor(Math.max(0, total) / n);
  const rem = Math.max(0, total) - base * n;
  return Array.from({ length: n }, (_, i) => base + (i === 0 ? rem : 0));
}

/**
 * Per-shard launch delay (ms) for the discovery fan-out. Shard i waits roughly
 * `i * base + random(0..base)` before its FIRST Apify request, so N tokens don't
 * all egress simultaneously from one box (the LinkedIn-ban trigger). Shards still
 * run concurrently — only their starts are spread out. base<=0 (or i<0) → 0 ms
 * (no stagger, the old behaviour). Pure + deterministic given `rng` (test seam).
 */
export function shardStaggerDelayMs(i: number, base: number, rng: () => number = Math.random): number {
  if (base <= 0 || i < 0) return 0;
  return i * base + Math.floor(rng() * base);
}

/**
 * Bounded-concurrency runner with allSettled semantics. Runs `fn` over indices
 * 0..items.length-1 with at most `limit` calls in flight at once, preserving
 * input order in the results. Never rejects — a throwing item becomes a
 * `rejected` result, exactly like Promise.allSettled, so one failing shard never
 * tears down the whole pool.
 *
 * The point of capping the discovery fan-out is to bound how many Apify actor
 * calls egress from one box simultaneously (the LinkedIn-ban trigger), so `limit`
 * is clamped to at least 1 — there is no "0 = unlimited" mode.
 */
export async function runWithConcurrency<T>(
  items: readonly unknown[],
  limit: number,
  fn: (index: number) => Promise<T>,
): Promise<PromiseSettledResult<T>[]> {
  const total = items.length;
  const results = new Array<PromiseSettledResult<T>>(total);
  if (total === 0) return results;
  const max = Math.min(total, Math.max(1, Math.floor(limit)));

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= total) return;
      try {
        results[i] = { status: "fulfilled", value: await fn(i) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };

  await Promise.all(Array.from({ length: max }, () => worker()));
  return results;
}
