import { type NextRequest, NextResponse } from "next/server";
import { enforce, rateLimitedResponse } from "@noelle/runtime/ratelimit";
import { isLocalAuth } from "@/lib/local-auth";
import { getGateSecret } from "@/lib/gate-secret";

import { authSessionCookieName } from "@/lib/auth-session-config";
const VERIFIED_COOKIE = "noelle_email_verified";

/**
 * Allowlist gate enforcer.
 *
 * /auth/gate is the only place that talks to Cloud SQL to verify a user's
 * email is on `noelle.invited_emails`. After it succeeds it sets an HMAC-
 * signed `noelle_email_verified` cookie. This middleware enforces that
 * cookie's presence + signature on every protected route, so a request
 * that holds a Supabase session cookie but skipped (or forged) the gate
 * gets bounced back to /auth/gate for a fresh DB check.
 *
 * Edge-safe: no DB, no Node `crypto`; uses Web Crypto for HMAC verify.
 */

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function verifyVerifiedCookie(raw: string | undefined): Promise<boolean> {
  if (!raw) return false;
  const dot = raw.lastIndexOf(".");
  if (dot < 1) return false;
  const email = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  // Fail CLOSED on ANY error — including getGateSecret() throwing when the
  // production secret is unset. A throw here must NOT 500 the Edge middleware;
  // it resolves to an invalid cookie, so the request is bounced to /auth/gate.
  try {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(getGateSecret()),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const computed = await crypto.subtle.sign("HMAC", key, enc.encode(email));
    const computedHex = Array.from(new Uint8Array(computed))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return constantTimeEqual(computedHex, sig);
  } catch (err) {
    console.error("[proxy] gate-cookie verify failed closed", err);
    return false;
  }
}

function hasSessionCookie(request: NextRequest): boolean {
  const SESSION_COOKIE_PREFIX = authSessionCookieName();
  for (const c of request.cookies.getAll()) {
    if (c.name === SESSION_COOKIE_PREFIX || c.name.startsWith(`${SESSION_COOKIE_PREFIX}.`)) {
      return true;
    }
  }
  return false;
}

/**
 * Pull the JWT `sub` claim from the chunked Supabase auth cookie without
 * verifying the signature. We only use this as a rate-limit key — the real
 * trust boundary is downstream (api-vm verifies JWTs; assertOrgMember
 * gates data access). A forged `sub` here only burns another user's
 * rate-limit bucket. Edge-safe: atob + JSON.parse, no Node Buffer.
 */
function extractJwtSub(request: NextRequest): string | null {
  const SESSION_COOKIE_PREFIX = authSessionCookieName();
  const chunks = request.cookies
    .getAll()
    .filter(
      (c) =>
        c.name === SESSION_COOKIE_PREFIX ||
        c.name.startsWith(`${SESSION_COOKIE_PREFIX}.`),
    )
    .sort((a, b) => {
      const idx = (n: string) =>
        n === SESSION_COOKIE_PREFIX
          ? -1
          : parseInt(n.split(".").pop() ?? "0", 10);
      return idx(a.name) - idx(b.name);
    });
  if (chunks.length === 0) return null;
  let raw = chunks.map((c) => c.value).join("");
  if (raw.startsWith("base64-")) {
    try {
      raw = atob(raw.slice(7));
    } catch {
      return null;
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const accessToken: string | null = Array.isArray(parsed)
    ? typeof parsed[0] === "string"
      ? (parsed[0] as string)
      : null
    : typeof parsed === "object" &&
        parsed !== null &&
        "access_token" in parsed
      ? ((parsed as { access_token?: string }).access_token ?? null)
      : null;
  if (!accessToken) return null;
  const payloadSeg = accessToken.split(".")[1];
  if (!payloadSeg) return null;
  try {
    const padded =
      payloadSeg.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - (payloadSeg.length % 4)) % 4);
    const json = atob(padded);
    const claims = JSON.parse(json) as { sub?: unknown };
    return typeof claims.sub === "string" ? claims.sub : null;
  } catch {
    return null;
  }
}

function extractClientIp(request: NextRequest): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = request.headers.get("x-real-ip");
  if (real) return real;
  return "unknown";
}

/**
 * Rate-limit the authenticated API surface.
 *
 * Scope: /api/** EXCEPT /api/cron/* (GCP Scheduler hits these with its
 * own auth, must never 429) and /api/auth/* (would brick login).
 *
 * Key: JWT `sub` when the Supabase cookie is present and decodable; else
 * client IP. Limit: 120 capacity, 1 token/sec sustained.
 */
async function enforceApiRateLimit(
  request: NextRequest,
): Promise<NextResponse | null> {
  const path = request.nextUrl.pathname;
  if (!path.startsWith("/api/")) return null;
  if (path.startsWith("/api/cron/")) return null;
  if (path.startsWith("/api/auth/")) return null;

  const sub = extractJwtSub(request);
  const key = sub
    ? `app:api:user:${sub}`
    : `app:api:ip:${extractClientIp(request)}`;
  const decision = await enforce(key, {
    bucket: sub ? "app:api:user" : "app:api:ip",
    capacity: 120,
    refillPerSecond: 1,
  });
  if (decision.allowed) return null;

  const r = rateLimitedResponse({
    bucket: decision.bucket,
    retryAfterMs: decision.retryAfterMs,
  });
  return new NextResponse(JSON.stringify(r.body), {
    status: r.status,
    headers: r.headers,
  });
}

export async function proxy(request: NextRequest) {
  const { pathname, origin } = request.nextUrl;

  // Self-host single-user mode: there is no Supabase session cookie and no
  // allowlist gate to enforce. Keep the per-route rate limit (provider-
  // agnostic), then pass through. The fixed operator identity is resolved
  // server-side by getUserFromCookies().
  if (isLocalAuth()) {
    const rl = await enforceApiRateLimit(request);
    return rl ?? NextResponse.next();
  }

  // Public surface: login screen, the OAuth callback, the gate itself, and
  // anything under /api/auth/* (none exist today, but reserved).
  if (
    pathname === "/" ||
    pathname === "/about" ||
    pathname === "/robots.txt" ||
    pathname === "/sitemap.xml" ||
    pathname.startsWith("/auth/") ||
    pathname.startsWith("/api/auth/")
  ) {
    return NextResponse.next();
  }

  if (!hasSessionCookie(request)) {
    // Not signed in at all — let the destination's own server-side checks
    // handle the redirect to /. We don't gate unauthenticated traffic here
    // because some routes (eg. /api/*) may legitimately serve 401s.
    // Still rate-limit unauth /api/* by IP to absorb scrape bursts.
    const rl = await enforceApiRateLimit(request);
    if (rl) return rl;
    return NextResponse.next();
  }

  const verified = request.cookies.get(VERIFIED_COOKIE)?.value;
  if (await verifyVerifiedCookie(verified)) {
    // Auth gate passed — apply the per-user rate limit before the
    // request reaches a route handler.
    const rl = await enforceApiRateLimit(request);
    if (rl) return rl;
    return NextResponse.next();
  }

  // Session cookie present but verified marker missing / forged / expired
  // → the gate must re-run. BUT: only a top-level DOCUMENT navigation can
  // usefully follow a redirect to /auth/gate (the browser navigates there,
  // re-gates, gets a fresh cookie). An RSC navigation fetch or a server-action
  // POST CANNOT — a redirect on those silently aborts the request, so the
  // user's click does nothing with no console error, and only a full reload
  // fixes it. (This is why every button/link goes dead once the 24h verified
  // cookie expires mid-session.) For those fetch requests we fall through:
  // the data-layer guard (assertOrgMember on every server path) still enforces
  // access, and the user is re-gated on their next full document load.
  const dest = request.headers.get("sec-fetch-dest");
  const isFetch =
    dest === "empty" ||
    request.headers.get("rsc") === "1" ||
    request.headers.has("next-action");
  if (isFetch) {
    const rl = await enforceApiRateLimit(request);
    if (rl) return rl;
    return NextResponse.next();
  }
  return NextResponse.redirect(`${origin}/auth/gate`);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
