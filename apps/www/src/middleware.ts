// Astro middleware — IP-keyed rate limiting for the marketing site at
// trynoelle.com. The marketing site is mostly static (Astro + Vercel),
// but it does expose POST /api/waitlist for the homepage signup form,
// and that's a juicy target for spambots. We layer two limits:
//
//   1. www:ip:<ip>:waitlist  — 5 tokens, 1 token/sec refill, ONLY on
//      /api/waitlist*. Soaks burst-spamming the form.
//   2. www:ip:<ip>:any       — 60 tokens, 30 tokens/min refill, on
//      everything else. Catches scraper / crawler abuse without
//      penalising legitimate page reloads.
//
// Driver follows NOELLE_RATELIMIT_DRIVER (memory in dev, upstash in
// prod). When the limit trips we short-circuit with the canonical 429
// envelope from @noelle/runtime — no fancy UI, just the JSON shape so
// fetch() callers can read retry_after_ms.
//
// `apps/www` is the canonical Astro project being absorbed from the
// legacy /noell-website repo (see CLAUDE.md). This file is intentionally
// in place before the rest of the absorption lands so the import only
// needs to copy pages/layouts/components, not the middleware too.

import { defineMiddleware } from "astro:middleware";
import { enforce, rateLimitedResponse } from "@noelle/runtime";

const WAITLIST_PATH_PREFIX = "/api/waitlist";

function extractClientIp(request: Request): string {
  // Vercel sets x-forwarded-for; first hop is the real client. Fall
  // back to x-real-ip, then a constant so we still rate-limit (poorly)
  // in environments without either header rather than letting requests
  // bypass the gate entirely.
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = request.headers.get("x-real-ip");
  if (real) return real;
  return "unknown";
}

export const onRequest = defineMiddleware(async (context, next) => {
  const url = new URL(context.request.url);
  const ip = extractClientIp(context.request);

  // 1. Waitlist-specific limiter — tight burst control on the form.
  if (url.pathname.startsWith(WAITLIST_PATH_PREFIX)) {
    const decision = await enforce(`www:ip:${ip}:waitlist`, {
      bucket: "www:waitlist",
      capacity: 5,
      refillPerSecond: 1,
    });
    if (!decision.allowed) {
      const r = rateLimitedResponse({
        bucket: decision.bucket,
        retryAfterMs: decision.retryAfterMs,
      });
      return new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: r.headers,
      });
    }
  }

  // 2. Global per-IP limiter — 60 capacity, 0.5 tokens/sec (= 30/min).
  const global = await enforce(`www:ip:${ip}:any`, {
    bucket: "www:any",
    capacity: 60,
    refillPerSecond: 0.5,
  });
  if (!global.allowed) {
    const r = rateLimitedResponse({
      bucket: global.bucket,
      retryAfterMs: global.retryAfterMs,
    });
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: r.headers,
    });
  }

  return next();
});
