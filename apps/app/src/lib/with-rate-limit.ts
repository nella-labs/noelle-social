/**
 * Server-action rate limit wrapper.
 *
 * Wraps a `"use server"` action so it's gated by a per-user token bucket
 * BEFORE the action body runs. Use this on writes that fan out to the API
 * (POST /api/drafts/*, POST /api/outbound/*) — the proxy in
 * src/proxy.ts already covers /api/* HTTP traffic, but server actions
 * dispatch over the special Next RSC protocol which bypasses /api/*. This
 * wrapper closes that gap.
 *
 * Key resolution: the trusted user id is the Supabase JWT `sub` claim
 * surfaced by `getUserFromCookies()`. If we can't identify the caller we
 * fall back to a shared `__anon__` bucket — defensive: anonymous traffic
 * on signed-in routes shouldn't exist by the time a server action runs,
 * but if it does we'd rather all of it share one tight bucket than each
 * forge its own.
 *
 * On trip the wrapper returns the canonical error envelope
 * `{ ok: false, error: { code: "rate_limited", message, status: 429 } }`
 * — same shape the approvals actions use for NoelleApiError, so callers
 * can keep one `if (result.ok === false)` branch.
 */

import { enforce, type EnforceOptions } from "@noelle/runtime/ratelimit";
import { getUserFromCookies } from "@/lib/auth-cookie";

export type WithRateLimitOptions = Pick<
  EnforceOptions,
  "capacity" | "refillPerSecond" | "cost"
>;

export interface RateLimitedActionFailure {
  ok: false;
  error: {
    code: "rate_limited";
    message: string;
    status: 429;
    retry_after_ms: number;
    bucket: string;
  };
}

/**
 * Wrap a server action with a per-user rate limit. The wrapped function has
 * the same call signature as the original.
 *
 * `actionName` becomes the logical bucket name in the 429 envelope so an
 * over-eager caller can tell which action they're tripping.
 */
export function withRateLimit<TArgs extends unknown[], TResult>(
  actionName: string,
  opts: WithRateLimitOptions,
  fn: (...args: TArgs) => Promise<TResult>,
): (...args: TArgs) => Promise<TResult | RateLimitedActionFailure> {
  return async (...args: TArgs) => {
    const user = await getUserFromCookies();
    const userId = user?.id ?? "__anon__";
    const decision = await enforce(`app:action:${actionName}:${userId}`, {
      bucket: `app:action:${actionName}`,
      capacity: opts.capacity,
      refillPerSecond: opts.refillPerSecond,
      cost: opts.cost,
    });
    if (!decision.allowed) {
      const retryMs = decision.retryAfterMs;
      return {
        ok: false,
        error: {
          code: "rate_limited",
          message: `Slow down — rate limit on ${actionName} hit. Retry in ${Math.ceil(retryMs / 1000)}s.`,
          status: 429,
          retry_after_ms: retryMs,
          bucket: decision.bucket,
        },
      } satisfies RateLimitedActionFailure;
    }
    return fn(...args);
  };
}
