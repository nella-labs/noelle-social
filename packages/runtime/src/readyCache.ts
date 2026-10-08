import { MemoryCache } from "./cache.js";

/**
 * In-process readiness gate with shared same-tuple checks and bounded LRU state.
 *
 * Usage:
 *   const ready = createReadyCache();
 *   await ready.ensure(orgId, "x-cookies", async () => { ... });
 *   await ready.ensure(orgId, "linkedin-li-at", async () => { ... });
 */
export interface ReadyCache {
  /**
   * Retain a successful check for the process lifetime, until reset, clear or
   * LRU eviction. Concurrent checks for the exact tuple share one result.
   * A failed check propagates its error and may be retried. At executing
   * capacity, new checks reject with CacheBusyError; hits and joins still work.
   */
  ensure(orgId: string, kind: string, check: () => Promise<void>): Promise<void>;
  /** Reset a single (orgId, kind) entry — useful in tests. */
  reset(orgId: string, kind: string): void;
  /** Reset all entries — useful in tests. */
  clear(): void;
}

export function createReadyCache(
  options: { maxEntries?: number; maxExecuting?: number } = {},
): ReadyCache {
  const ready = new MemoryCache(options.maxEntries, options.maxExecuting);

  function key(orgId: string, kind: string) {
    return JSON.stringify([orgId, kind]);
  }

  return {
    async ensure(orgId, kind, check) {
      await ready.getOrCompute(key(orgId, kind), Infinity, async () => {
        await check();
        return true;
      });
    },
    reset(orgId, kind) {
      void ready.del(key(orgId, kind));
    },
    clear() {
      ready.clear();
    },
  };
}
