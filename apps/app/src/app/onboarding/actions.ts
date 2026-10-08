"use server";

import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getUserFromCookies } from "@/lib/auth-cookie";
import { isLocalAuth } from "@/lib/local-auth";
import { sql, withTx } from "@/lib/db";
import type { AgentRole, AgentInstanceStatus } from "@/lib/db-types";
import {
  findPendingEmailInvite,
  findRedeemableInvite,
  lockInvitationForRedemption,
  redeemLockedInvitation,
  type Invitation,
} from "@/lib/invitations";
import { getInviteSecret } from "@/lib/invite-secret";

/**
 * Resolve the signed-in user's first existing org slug (if any). The
 * onboarding page mount-effect calls this to redirect existing members
 * straight into their workspace instead of forcing them through the form.
 *
 * Returns `null` if there's no session or no org_members row. Browsing
 * directly through the pg `sql` template keeps onboarding off Supabase
 * data calls (Phase 4 of the Supabase → Cloud SQL migration).
 */
export async function getFirstOrgSlugForCurrentUser(): Promise<string | null> {
  // Cookie-JWT path; sb.auth.getUser() deadlocks on Vercel Node Serverless.
  const user = await getUserFromCookies();
  if (!user) return null;
  const rows = await sql<{ slug: string }[]>`
    select o.slug
    from noelle.organizations o
    join noelle.org_members m on m.org_id = o.id
    where m.user_id = ${user.id}
    order by o.created_at asc
    limit 1
  `;
  return rows[0]?.slug ?? null;
}

/**
 * Invite-gate cookie. Set when the user submits a valid alpha invite code in
 * <InviteGate>; consumed by createOrgFromOnboarding. Signed with HMAC-SHA256
 * over `NOELLE_INVITE_COOKIE_SECRET` so a tampered code can't pass the gate
 * without a server round-trip.
 */
const INVITE_COOKIE = "noelle_invite_redeemed";
const INVITE_COOKIE_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

// The invite-cookie HMAC secret comes from @/lib/invite-secret. It NEVER falls
// back to the browser-public anon key and throws in production when unset
// (fail-closed) — callers below treat a throw as "invite gate unavailable".
function signInvite(code: string): string {
  return createHmac("sha256", getInviteSecret()).update(code).digest("hex");
}

function packInviteCookie(code: string): string {
  return `${code}.${signInvite(code)}`;
}

function verifyInviteCookie(raw: string | undefined): string | null {
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot < 1) return null;
  const code = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  try {
    // signInvite → getInviteSecret() throws when the production secret is
    // unset. Fail CLOSED: treat an unresolvable secret as an invalid cookie.
    const expected = signInvite(code);
    const a = Buffer.from(sig, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length) return null;
    if (!timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  return code;
}

function getValidInviteCodes(): string[] {
  return (process.env.NOELLE_ALPHA_INVITE_CODES || "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
}

/**
 * Resolve a submitted code against the DB invitation table first, then fall
 * back to the legacy `NOELLE_ALPHA_INVITE_CODES` env list (kept for dev /
 * backstop). `invite` is the matched DB row when present — used to stamp the
 * redemption at org creation; null for env-list codes (which carry no row).
 */
async function resolveInvite(
  code: string,
): Promise<{ valid: boolean; invite: Invitation | null }> {
  const invite = await findRedeemableInvite(code);
  if (invite) return { valid: true, invite };
  if (getValidInviteCodes().includes(code)) return { valid: true, invite: null };
  return { valid: false, invite: null };
}

function setInviteCookie(
  cookieStore: Awaited<ReturnType<typeof cookies>>,
  code: string,
): void {
  cookieStore.set(INVITE_COOKIE, packInviteCookie(code), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: INVITE_COOKIE_TTL_SECONDS,
  });
}

// ---------- redeemInviteCode ----------

const redeemSchema = z.object({
  code: z
    .string()
    .min(1, "Enter your invite code.")
    .max(128, "Invite code is too long.")
    .transform((s) => s.trim()),
});

export interface RedeemInviteResult {
  ok: boolean;
  error?: string;
}

export async function redeemInviteCode(
  _prev: RedeemInviteResult | undefined,
  formData: FormData,
): Promise<RedeemInviteResult> {
  const user = await getUserFromCookies();
  if (!user) {
    return { ok: false, error: "Sign in first." };
  }

  const parsed = redeemSchema.safeParse({ code: formData.get("code") });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid invite code." };
  }

  const { valid, invite } = await resolveInvite(parsed.data.code);
  if (!valid) {
    return { ok: false, error: "That invite code isn't valid." };
  }
  // Email-bound invites only redeem for their intended recipient.
  if (
    invite?.email &&
    invite.email.trim().toLowerCase() !== (user.email || "").trim().toLowerCase()
  ) {
    return { ok: false, error: "This invite is for a different email address." };
  }

  const cookieStore = await cookies();
  try {
    // setInviteCookie → signInvite → getInviteSecret() throws when the prod
    // secret is unset. Fail CLOSED: deny rather than sign with a weak key.
    setInviteCookie(cookieStore, parsed.data.code);
  } catch (err) {
    console.error("[onboarding] invite secret unavailable — refusing to set invite cookie", err);
    return { ok: false, error: "Invite gate unavailable." };
  }

  return { ok: true };
}

/**
 * Auto-redeem a pending email-bound invite for the signed-in user. The
 * onboarding page calls this on mount: if the user's email has a pending
 * `kind = 'email'` invite, we set the invite cookie for them and they skip
 * the code-entry step entirely. No-op (ok: false) for everyone else.
 */
export async function autoRedeemEmailInvite(): Promise<{ ok: boolean }> {
  const user = await getUserFromCookies();
  if (!user?.email) return { ok: false };
  const invite = await findPendingEmailInvite(user.email);
  if (!invite) return { ok: false };
  const cookieStore = await cookies();
  try {
    // Fail CLOSED: a thrown invite secret (prod, unset) means no auto-redeem.
    setInviteCookie(cookieStore, invite.code);
  } catch (err) {
    console.error("[onboarding] invite secret unavailable — skipping auto-redeem", err);
    return { ok: false };
  }
  return { ok: true };
}

// ---------- createOrgFromOnboarding ----------

const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const createOrgSchema = z.object({
