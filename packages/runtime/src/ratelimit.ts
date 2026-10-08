import { decodeHttpJson, fetchBoundedHttpResponse, HttpBodyError } from "./boundedHttp.js";

/**
 * RateLimit — per-key token bucket. See docs/scalability.md § 4.
 *
 * Two drivers:
 *   - `memory` (default for dev): per-process Map, fine for single-replica.
 *   - `upstash`  (production):    atomic refill via Upstash REST + Lua EVAL.
 *
 * Driver selection:
 *   - Explicit arg to getRateLimit() wins.
 *   - Else `NOELLE_RATELIMIT_DRIVER` env var.
 *   - Else `memory`.
 *
 * Same `RateLimit` interface across drivers so call sites don't change when
 * we flip the env in prod.
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** Remaining tokens after this take (0 if denied). */
  remaining: number;
  /** If denied, ms to wait before retry would succeed. 0 if allowed. */
  retryAfterMs: number;
}

export interface RateLimit {
  /**
   * Attempt to consume `cost` tokens from the bucket identified by `key`.
   * Denies if not enough tokens, never blocks.
   */
  take(key: string, cost?: number): Promise<RateLimitDecision>;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export interface TokenBucketOptions {
  /** Max tokens the bucket can hold. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSecond: number;
}

export class MemoryTokenBucket implements RateLimit {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly opts: TokenBucketOptions) {}

  async take(key: string, cost: number = 1): Promise<RateLimitDecision> {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.opts.capacity, lastRefillMs: now };
      this.buckets.set(key, b);
    } else {
      const elapsedSec = (now - b.lastRefillMs) / 1000;
      b.tokens = Math.min(this.opts.capacity, b.tokens + elapsedSec * this.opts.refillPerSecond);
      b.lastRefillMs = now;
    }
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { allowed: true, remaining: Math.floor(b.tokens), retryAfterMs: 0 };
    }
    const deficit = cost - b.tokens;
    const retryAfterMs = Math.ceil((deficit / this.opts.refillPerSecond) * 1000);
    return { allowed: false, remaining: 0, retryAfterMs };
  }
}

// -- UpstashTokenBucket ----------------------------------------------------

/**
 * Atomic token bucket backed by Upstash Redis REST.
 *
 * We run a single Lua script via `EVAL` so refill + decrement happen inside
 * one Redis round-trip — no read/modify/write races between replicas. State
 * for each key is stored as a hash with two fields (`tokens`, `ts_ms`) and a
 * TTL slightly longer than time-to-refill so cold keys eventually evict.
 *
 * REST contract (https://upstash.com/docs/redis/features/restapi):
 *   POST {UPSTASH_REDIS_REST_URL}
 *   Authorization: Bearer <UPSTASH_REDIS_REST_TOKEN>
 *   body: ["EVAL", "<script>", "<numkeys>", "<key>", "<arg>", ...]
 *   → 200 { "result": <whatever the script returned> }
 *
 * The script returns the Lua array `[allowed_int, remaining_int, retry_ms_int]`.
 */

// KEYS[1] = bucket key, ARGV[1] = capacity, ARGV[2] = refill_per_sec,
// ARGV[3] = cost, ARGV[4] = now_ms
const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local now_ms = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'tokens', 'ts_ms')
local tokens = tonumber(data[1])
local ts_ms = tonumber(data[2])

if tokens == nil then
  tokens = capacity
  ts_ms = now_ms
else
  local elapsed_ms = now_ms - ts_ms
  if elapsed_ms < 0 then elapsed_ms = 0 end
  tokens = tokens + (elapsed_ms / 1000.0) * refill
  if tokens > capacity then tokens = capacity end
  ts_ms = now_ms
end

local allowed = 0
local retry_ms = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  local deficit = cost - tokens
  if refill > 0 then
    retry_ms = math.ceil((deficit / refill) * 1000)
  else
    retry_ms = -1
  end
end

redis.call('HSET', key, 'tokens', tokens, 'ts_ms', ts_ms)
local ttl_sec = math.ceil(capacity / math.max(refill, 0.001))
if ttl_sec < 60 then ttl_sec = 60 end
if ttl_sec > 3600 then ttl_sec = 3600 end
redis.call('EXPIRE', key, ttl_sec)

return { allowed, math.floor(tokens), retry_ms }
`.trim();

export interface UpstashTokenBucketOptions extends TokenBucketOptions {
  url: string;
  token: string;
  /** Optional fetch impl (tests inject). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Complete Redis HTTP request deadline. Default 2 seconds. */
  timeoutMs?: number;
}

export class UpstashTokenBucket implements RateLimit {
  private readonly url: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly opts: TokenBucketOptions;
  private readonly timeoutMs: number;

  constructor(opts: UpstashTokenBucketOptions) {
    if (!opts.url || !opts.token) {
      throw new Error("UpstashTokenBucket: url and token required");
    }
    this.url = opts.url.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.opts = { capacity: opts.capacity, refillPerSecond: opts.refillPerSecond };
    this.timeoutMs = opts.timeoutMs ?? 2000;
  }

  async take(key: string, cost: number = 1): Promise<RateLimitDecision> {
    const now = Date.now();
    const command = [
      "EVAL",
      TOKEN_BUCKET_LUA,
      "1",
      key,
      String(this.opts.capacity),
      String(this.opts.refillPerSecond),
      String(cost),
      String(now),
    ];

    const failOpen = (): RateLimitDecision => ({ allowed: true, remaining: this.opts.capacity, retryAfterMs: 0 });
    let parsed: unknown;
    try {
      const { response, bytes } = await fetchBoundedHttpResponse(this.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(command),
      }, { fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs, maxBytes: 65_536 });
      if (!response.ok) {
        console.warn(`[ratelimit.upstash] HTTP ${response.status}; failing open`);
        return failOpen();
      }
      parsed = decodeHttpJson(bytes);
    } catch (err) {
      // Fail open: if Upstash is unreachable we'd rather serve traffic than
      // 503 the world. Surface remaining=capacity so callers get a sane
      // value; never set allowed=false on infra error.
      console.warn(
        "[ratelimit.upstash] request failed; failing open:",
        err instanceof HttpBodyError ? err.code : "request_error",
      );
      return failOpen();
    }

    const result = (parsed as { result?: unknown })?.result;
    if (!Array.isArray(result) || result.length !== 3) return failOpen();
    const [allowedRaw, remainingRaw, retryRaw] = result as [unknown, unknown, unknown];
    if ((allowedRaw !== 0 && allowedRaw !== 1) || typeof remainingRaw !== "number" ||
        !Number.isSafeInteger(remainingRaw) || remainingRaw < 0 || typeof retryRaw !== "number" ||
        !Number.isSafeInteger(retryRaw) || retryRaw < -1 || (allowedRaw === 1 && retryRaw !== 0)) return failOpen();
    const allowed = allowedRaw === 1;
    const remaining = remainingRaw;
    const retryAfterMs = Math.max(0, retryRaw);
    return { allowed, remaining, retryAfterMs: allowed ? 0 : retryAfterMs };
  }
}

// -- factory ---------------------------------------------------------------

export type RateLimitDriver = "memory" | "upstash";

export function getRateLimit(
  opts: TokenBucketOptions,
  driver?: RateLimitDriver,
): RateLimit {
  const d =
    driver ??
    (process.env.NOELLE_RATELIMIT_DRIVER as RateLimitDriver | undefined) ??
    "memory";
  switch (d) {
    case "memory":
      return new MemoryTokenBucket(opts);
    case "upstash": {
      const url = process.env.UPSTASH_REDIS_REST_URL;
      const token = process.env.UPSTASH_REDIS_REST_TOKEN;
      if (!url || !token) {
        throw new Error(
          "getRateLimit(upstash): UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN required",
        );
      }
      return new UpstashTokenBucket({ ...opts, url, token });
    }
    default: {
      const exhaustive: never = d;
      throw new Error(`Unknown NOELLE_RATELIMIT_DRIVER: ${String(exhaustive)}`);
    }
  }
}

// -- enforce() helper + 429 envelope ---------------------------------------

/**
 * One-call enforcement primitive. Builds (or reuses) a token bucket for the
 * given `(bucket, opts)` pair, takes `cost` tokens against `key`, and returns
 * a discriminated decision the caller can map straight into a transport-
 * appropriate response.
 *
 * We memoize the bucket instance per `(driver, bucket, capacity, refill)` so
 * repeated `enforce()` calls in the same process share state. Without this,
 * a route handler creating a new MemoryTokenBucket per request would leak
 * memory and never actually rate limit.
 */
export interface EnforceOptions extends TokenBucketOptions {
  /**
   * Logical bucket name — used in the 429 envelope so the client can tell
   * which limit it tripped. Also part of the in-process memoization key.
   * Convention: `<scope>:<resource>` e.g. `app:api:user`, `api:org:write`.
   */
  bucket: string;
  /** Token cost of this op. Default 1. */
  cost?: number;
  /** Override driver selection per-call (defaults to env / "memory"). */
  driver?: RateLimitDriver;
}

export type EnforceResult =
  | { allowed: true; remaining: number; bucket: string }
  | {
      allowed: false;
      remaining: 0;
      retryAfterMs: number;
      bucket: string;
    };

const limiterRegistry = new Map<string, RateLimit>();

function registryKey(driver: RateLimitDriver, opts: EnforceOptions): string {
  return [
    driver,
    opts.bucket,
    String(opts.capacity),
    String(opts.refillPerSecond),
  ].join("|");
}

function getOrCreateLimiter(opts: EnforceOptions): RateLimit {
  const driver: RateLimitDriver =
    opts.driver ??
    (process.env.NOELLE_RATELIMIT_DRIVER as RateLimitDriver | undefined) ??
    "memory";
  const k = registryKey(driver, opts);
  let l = limiterRegistry.get(k);
  if (!l) {
    l = getRateLimit({ capacity: opts.capacity, refillPerSecond: opts.refillPerSecond }, driver);
    limiterRegistry.set(k, l);
  }
  return l;
}

/** Test-only: forget memoized limiter instances. */
export function _resetRateLimitRegistryForTests(): void {
  limiterRegistry.clear();
}

export async function enforce(
  key: string,
  opts: EnforceOptions,
): Promise<EnforceResult> {
  const limiter = getOrCreateLimiter(opts);
  const decision = await limiter.take(key, opts.cost ?? 1);
  if (decision.allowed) {
    return { allowed: true, remaining: decision.remaining, bucket: opts.bucket };
  }
  return {
    allowed: false,
    remaining: 0,
    retryAfterMs: decision.retryAfterMs,
    bucket: opts.bucket,
  };
}

/**
 * Standard 429 envelope. Returns a plain object so each transport (Next,
 * Hono, Astro) can adapt it without us pulling a framework dep in here.
 */
export interface RateLimitedResponse {
  status: 429;
  headers: Record<string, string>;
  body: {
    error: "rate_limited";
    detail: string;
    bucket: string;
    retry_after_ms: number;
  };
}

export function rateLimitedResponse(args: {
  bucket: string;
  retryAfterMs: number;
}): RateLimitedResponse {
  const retrySec = Math.max(1, Math.ceil(args.retryAfterMs / 1000));
  return {
    status: 429,
    headers: {
      "Retry-After": String(retrySec),
      "X-RateLimit-Bucket": args.bucket,
      "X-RateLimit-Retry-After-Ms": String(args.retryAfterMs),
      "content-type": "application/json",
    },
    body: {
      error: "rate_limited",
      detail: `Rate limit hit for ${args.bucket}. Retry after ${retrySec}s.`,
      bucket: args.bucket,
      retry_after_ms: args.retryAfterMs,
    },
  };
}
