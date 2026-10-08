/**
 * Read-through cache interface. MemoryCache provides per-process LRU entries,
 * expiry and shared same-key computations. The external Upstash adapter is
 * unavailable until its methods are implemented.
 */

export interface Cache {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  /**
   * Stampede-safe read-through. Concurrent calls for the same key within the
   * same process collapse to a single computeFn invocation.
   */
  getOrCompute<T>(key: string, ttlSeconds: number, computeFn: () => Promise<T>): Promise<T>;
}

// -- MemoryCache (default) -------------------------------------------------

interface Entry {
  value: unknown;
  expiresAt: number;
}

export class CacheBusyError extends Error {
  constructor() {
    super("MemoryCache executing computation capacity reached");
    this.name = "CacheBusyError";
  }
}

/**
 * Bounds completed LRU entries separately from executing computations. Hits
 * and same-key joins remain available at capacity; new work rejects immediately.
 * Invalidating an entry cannot cancel its callback or free its executing slot.
 */
export class MemoryCache implements Cache {
  private readonly store = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly executing = new Set<Promise<unknown>>();

  constructor(
    private readonly maxEntries: number = 10_000,
    private readonly maxExecuting: number = 32,
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError("MemoryCache maxEntries must be a positive safe integer");
    }
    if (!Number.isSafeInteger(maxExecuting) || maxExecuting < 1) {
      throw new RangeError("MemoryCache maxExecuting must be a positive safe integer");
    }
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.readStored<T>(key);
  }

  private readStored<T>(key: string): T | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    this.store.delete(key);
    this.store.set(key, e);
    return e.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    this.inflight.delete(key);
    this.writeStored(key, value, ttlSeconds);
  }

  private writeStored<T>(key: string, value: T, ttlSeconds: number): void {
    this.store.delete(key);
    if (this.store.size >= this.maxEntries) {
      // Reads and writes move entries to the end; evict the least recently used.
      const firstKey = this.store.keys().next().value;
      if (firstKey !== undefined) this.store.delete(firstKey);
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
    this.inflight.delete(key);
  }

  clear(): void {
    this.store.clear();
    this.inflight.clear();
  }

  async getOrCompute<T>(key: string, ttlSeconds: number, computeFn: () => Promise<T>): Promise<T> {
    const cached = this.readStored<T>(key);
    if (cached !== undefined) return cached;
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;
    if (this.executing.size >= this.maxExecuting) throw new CacheBusyError();
    // Install ownership before invoking user code, including synchronous throws.
    const p = Promise.resolve().then(computeFn).then(v => {
      if (this.inflight.get(key) === p) this.writeStored(key, v, ttlSeconds);
      return v;
    }).finally(() => {
      this.executing.delete(p);
      if (this.inflight.get(key) === p) this.inflight.delete(key);
    });
    this.inflight.set(key, p);
    this.executing.add(p);
    return p;
  }
}

// -- UpstashCache (skeleton) -----------------------------------------------

/**
 * Skeleton for a Redis-backed cache (Upstash REST API or compatible). Method
 * bodies throw until the swap is needed — see docs/scalability.md § 3 for the
 * signal to migrate.
 */
export class UpstashCache implements Cache {
  constructor(_opts: { url: string; token: string }) {
    // intentionally unused until impl lands
  }

  async get<T>(_key: string): Promise<T | undefined> {
    throw new Error("UpstashCache.get not yet implemented");
  }
  async set<T>(_key: string, _value: T, _ttlSeconds: number): Promise<void> {
    throw new Error("UpstashCache.set not yet implemented");
  }
  async del(_key: string): Promise<void> {
    throw new Error("UpstashCache.del not yet implemented");
  }
  async getOrCompute<T>(_key: string, _ttlSeconds: number, _computeFn: () => Promise<T>): Promise<T> {
    throw new Error("UpstashCache.getOrCompute not yet implemented");
  }
}

// -- factory ---------------------------------------------------------------

export type CacheDriver = "memory" | "upstash";

export function getCache(driver?: CacheDriver): Cache {
  const d = driver ?? (process.env.NOELLE_CACHE_DRIVER as CacheDriver | undefined) ?? "memory";
  switch (d) {
    case "memory":
      return new MemoryCache();
    case "upstash": {
      const url = process.env.UPSTASH_REDIS_REST_URL;
      const token = process.env.UPSTASH_REDIS_REST_TOKEN;
      if (!url || !token) {
        throw new Error("getCache(upstash): UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN required");
      }
      return new UpstashCache({ url, token });
    }
    default: {
      const exhaustive: never = d;
      throw new Error(`Unknown NOELLE_CACHE_DRIVER: ${String(exhaustive)}`);
    }
  }
}
