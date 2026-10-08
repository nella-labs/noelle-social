import type { MiddlewareHandler } from "hono";
import { enforce, rateLimitedResponse } from "@noelle/runtime";
import type { AuthContext } from "./jwt.js";

/**
 * Per-user rate limiting for the JWT-protected surface.
 *
 * The plan calls these "per-org" limits — in practice AuthContext only
 * surfaces `userId` (the Supabase JWT `sub` claim), and alpha tenancy is
 * effectively 1:1 with the user. The org boundary is enforced separately
 * by isOrgMember() inside each route handler, so it's fine to bucket the
 * rate limit on userId here. Keys are namespaced `api:user:<userId>:*` so
 * a future migration to per-org keys can land without colliding.
 *
 * Three layered buckets:
 *
 *  - api:user:<u>:read   cap 600, refill 10/sec  (= 600/min) — applied to
 *    GET. Generous because dashboard polling is normal.
 *  - api:user:<u>:write  cap 100, refill 100/60s (= 100/min) — applied to
 *    POST/PUT/PATCH/DELETE. Tight enough to catch a stuck loop, loose
 *    enough that batch approval doesn't trip it.
 *  - api:user:<u>:send   cap 30,  refill 30/60s  (= 30/min) — OVERLAY on
 *    POST /api/drafts/:id/send. Each send hits both the write bucket AND
 *    the send bucket, so the tighter of the two wins.
 *
 * Failure mode: enforce() fails open if the backing store (Upstash) is
 * unreachable. We never 5xx on rate-limit infra failure.
 */

type RateLimitVars = { auth: AuthContext };

const READ_METHODS = new Set(["GET", "HEAD"]);

export const requireRateLimit: MiddlewareHandler<{
  Variables: RateLimitVars;
}> = async (c, next) => {
  const auth = c.get("auth");
  // Without an auth context we'd have nothing to key on — this middleware
  // is intentionally registered AFTER requireUserJwt, so auth must exist.
  // Defensive: if it doesn't, skip rate limiting rather than 500ing.
  if (!auth?.userId) return next();

  const method = c.req.method.toUpperCase();
  const isRead = READ_METHODS.has(method);
  const baseBucket = isRead ? "api:user:read" : "api:user:write";
  const baseDecision = await enforce(
    `api:user:${auth.userId}:${isRead ? "read" : "write"}`,
    {
      bucket: baseBucket,
      capacity: isRead ? 600 : 100,
      refillPerSecond: isRead ? 10 : 100 / 60,
    },
  );
  if (!baseDecision.allowed) {
    const r = rateLimitedResponse({
      bucket: baseDecision.bucket,
      retryAfterMs: baseDecision.retryAfterMs,
    });
    return c.json(r.body, r.status, r.headers);
  }

  // Overlay: the send path is paid downstream (X post + Cloud SQL approval
  // flip). 30/min hard cap per user beyond the generic write limit. Pattern
  // match on path + method so we don't accidentally apply the send limit
  // to /api/drafts/:id/skip.
  const path = c.req.path;
  const isSend =
    method === "POST" && /^\/api\/drafts\/[^/]+\/send$/.test(path);
  if (isSend) {
    const sendDecision = await enforce(`api:user:${auth.userId}:send`, {
      bucket: "api:user:send",
      capacity: 30,
      refillPerSecond: 30 / 60,
    });
    if (!sendDecision.allowed) {
      const r = rateLimitedResponse({
        bucket: sendDecision.bucket,
        retryAfterMs: sendDecision.retryAfterMs,
      });
      return c.json(r.body, r.status, r.headers);
    }
  }

  await next();
};
