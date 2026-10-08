// Bounded-concurrency fan-out helper — the repo's first concurrency primitive.
//
// Every Noelle worker today maps over its inputs with a sequential `for…await`
// loop (verified: no `p-limit`/`p-map` anywhere — see the Account Feeder design
// doc §2.13). `batchMap` is the hand-rolled worker pool that lets the Account
// Feeder fan out N parallel Gemini extractors per source account without
// pulling in a dependency.
//
// Semantics:
//   - At most `concurrency` `fn` calls are in flight at once; remaining items
//     start as slots free up.
//   - The result array preserves INPUT ORDER: result[i] is the outcome of
//     items[i], regardless of which item settled first.
//   - `Promise.allSettled`-style isolation: a rejected `fn` becomes
//     `{ ok: false, error }` and never rejects the whole batch.
//
// Pure: no I/O, no timers, no globals.

/** Per-item outcome, mirroring `Promise.allSettled` but order-preserving. */
export type BatchResult<R> =
  | { ok: true; value: R }
  | { ok: false; error: unknown };

export interface BatchMapOptions {
  /**
   * Max number of `fn` calls in flight at once. Values `<= 0` or non-finite
   * (NaN, Infinity) are coerced to `1`. Fractional values are floored.
   */
  concurrency: number;
}

/**
 * Map `fn` over `items` with a bounded worker pool.
 *
 * @returns A same-length array where `result[i]` is the settled outcome of
 *   `fn(items[i], i)`. Resolves once every item has settled; never rejects.
 */
export async function batchMap<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  opts: BatchMapOptions,
): Promise<Array<BatchResult<R>>> {
  const total = items.length;
  if (total === 0) return [];

  // Coerce concurrency: floor, and clamp anything non-finite or < 1 up to 1.
  const raw = Math.floor(opts.concurrency);
  const limit = Number.isFinite(raw) && raw >= 1 ? raw : 1;

  const results = new Array<BatchResult<R>>(total);

  // Shared cursor: each worker grabs the next index, runs it, repeats until the
  // queue is drained. At most `limit` workers run concurrently, so at most
  // `limit` `fn` calls are ever in flight.
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      if (index >= total) return;
      next += 1;
      try {
        const value = await fn(items[index]!, index);
        results[index] = { ok: true, value };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  }

  const workerCount = Math.min(limit, total);
  const workers: Array<Promise<void>> = [];
  for (let i = 0; i < workerCount; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return results;
}
