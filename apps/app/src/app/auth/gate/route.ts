/** Hosted email allowlist and signed verification cookie; local mode uses the configured operator. */

import { createHmac } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { getUserFromCookies } from "@/lib/auth-cookie";
import { isLocalAuth, localOperatorEmail, localOrgSlug } from "@/lib/local-auth";
import { getGateSecret } from "@/lib/gate-secret";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { authSessionCookieName } from "@/lib/auth-session-config";
const VERIFIED_COOKIE = "noelle_email_verified";
const VERIFIED_TTL_SECONDS = 60 * 60 * 24; // 24h — re-gate at least daily

function signEmail(email: string): string {
  return createHmac("sha256", getGateSecret()).update(email).digest("hex");
}

function packVerifiedCookie(email: string): string {
  return `${email}.${signEmail(email)}`;
}

function clearSessionCookies(res: NextResponse, req: NextRequest): void {
  const SESSION_COOKIE_PREFIX = authSessionCookieName();
  // Supabase chunks large sessions across `sb-{ref}-auth-token`,
  // `sb-{ref}-auth-token.0`, `.1`, etc. Enumerate and clear all of them
  // so chunk-0 doesn't survive and re-hydrate a partial session.
  for (const c of req.cookies.getAll()) {
    if (c.name === SESSION_COOKIE_PREFIX || c.name.startsWith(`${SESSION_COOKIE_PREFIX}.`)) {
      res.cookies.delete(c.name);
    }
  }
  res.cookies.delete(VERIFIED_COOKIE);
}

export async function GET(request: NextRequest) {
  const { origin } = new URL(request.url);

  // Self-host: there is no allowlist to enforce — stamp the verified cookie for
  // the single operator and continue. (Middleware already passes through in
  // local mode, so this only fires if /auth/gate is hit directly.)
  if (isLocalAuth()) {
    const email = localOperatorEmail().trim().toLowerCase();
    let cookieValue: string;
    try {
      // packVerifiedCookie → signEmail → getGateSecret() throws when the
      // production secret is unset. Fail CLOSED: never mint a cookie signed
      // with a weak/public key; surface an error redirect instead of a 500.
      cookieValue = packVerifiedCookie(email);
    } catch (err) {
      console.error("[auth/gate] gate secret unavailable — refusing to sign verify cookie", err);
      const res = NextResponse.redirect(`${origin}/?error=gate_unavailable`);
      clearSessionCookies(res, request);
      return res;
    }
    const res = NextResponse.redirect(`${origin}/app/${localOrgSlug()}`);
    res.cookies.set(VERIFIED_COOKIE, cookieValue, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: VERIFIED_TTL_SECONDS,
    });
    return res;
  }

  const user = await getUserFromCookies();
  if (!user) {
    // No session at all → bounce to the login screen, nothing to clear.
    return NextResponse.redirect(`${origin}/?error=auth_failed`);
  }

  const email = (user.email ?? "").trim().toLowerCase();
  if (!email) {
    // Authenticated but no email claim — shouldn't happen with the providers
    // we enable, but if it does we can't allowlist them, so reject.
    const res = NextResponse.redirect(`${origin}/?error=not_invited`);
    clearSessionCookies(res, request);
    return res;
  }

  let allowed = false;
  try {
    const rows = await sql<{ email: string }[]>`
      select email
      from noelle.invited_emails
      where email = ${email}
      limit 1
    `;
    allowed = rows.length > 0;
  } catch (err) {
    // Fail closed: if the gate can't reach the DB, don't let anyone in.
    // Logging here so the operator dashboard surfaces gate failures.
    console.error("[auth/gate] allowlist lookup failed", err);
    const res = NextResponse.redirect(`${origin}/?error=gate_unavailable`);
    clearSessionCookies(res, request);
    return res;
  }

  if (!allowed) {
    const res = NextResponse.redirect(`${origin}/?error=not_invited`);
    clearSessionCookies(res, request);
    return res;
  }

  // Stamp the redemption columns — best-effort, never blocks the redirect.
  try {
    await sql`
      update noelle.invited_emails
      set redeemed_at    = coalesce(redeemed_at, now()),
          linked_user_id = ${user.id}
      where email = ${email}
    `;
  } catch (err) {
    console.warn("[auth/gate] failed to stamp redemption", err);
  }

  let cookieValue: string;
  try {
    // Fail CLOSED: refuse to issue a verify cookie signed with a weak/public
    // key if the production gate secret is unresolvable. Mirror the DB-fail
    // path above — clear the session and bounce, never a weak cookie or a 500.
    cookieValue = packVerifiedCookie(email);
  } catch (err) {
    console.error("[auth/gate] gate secret unavailable — refusing to sign verify cookie", err);
    const res = NextResponse.redirect(`${origin}/?error=gate_unavailable`);
    clearSessionCookies(res, request);
    return res;
  }

  const res = NextResponse.redirect(`${origin}/onboarding`);
  res.cookies.set(VERIFIED_COOKIE, cookieValue, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: VERIFIED_TTL_SECONDS,
  });
  return res;
}
