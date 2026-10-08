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
  name: z
    .string()
    .min(2, "Org name must be at least 2 characters.")
    .max(80, "Org name is too long.")
    .transform((s) => s.trim()),
  slug: z
    .string()
    .min(2, "Slug must be at least 2 characters.")
    .max(48, "Slug is too long.")
    .regex(slugRegex, "Slug must be lowercase letters, numbers, and dashes."),
});

export interface CreateOrgResult {
  ok: boolean;
  error?: string;
  fieldErrors?: Partial<Record<"name" | "slug" | "inviteCode", string>>;
}

interface AgentSeed {
  role: AgentRole;
  display_name: string;
  status: AgentInstanceStatus;
  budget_cap_cents: number;
}

export async function createOrgFromOnboarding(
  _prev: CreateOrgResult | undefined,
  formData: FormData,
): Promise<CreateOrgResult> {
  const user = await getUserFromCookies();
  if (!user) {
    return { ok: false, error: "Sign in first." };
  }

  const cookieStore = await cookies();
  let cookieCode: string | null = null;
  let invite: Invitation | null = null;
  if (!isLocalAuth()) {
    cookieCode = verifyInviteCookie(cookieStore.get(INVITE_COOKIE)?.value);
    if (!cookieCode) return { ok: false, error: "Invite code missing or expired. Re-enter it." };
    const resolved = await resolveInvite(cookieCode);
    if (!resolved.valid) return { ok: false, error: "Invite code is no longer valid." };
    invite = resolved.invite;
    if (invite?.email && invite.email.trim().toLowerCase() !== (user.email || "").trim().toLowerCase()) {
      return { ok: false, error: "This invite is for a different email address." };
    }
  }

  const parsed = createOrgSchema.safeParse({
    name: formData.get("name"),
    slug: formData.get("slug"),
  });
  if (!parsed.success) {
    const fieldErrors: CreateOrgResult["fieldErrors"] = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path[0];
      if (path === "name" || path === "slug" || path === "inviteCode") {
        fieldErrors[path] = issue.message;
      }
    }
    return {
      ok: false,
      error: "Fix the highlighted fields.",
      fieldErrors,
    };
  }

  const { name, slug } = parsed.data;

  const seeds: AgentSeed[] = [{
    role: "x_intern",
    display_name: "Vega",
    status: "paused",
    budget_cap_cents: 10000,
  }];

  // Phase 4 (Supabase → Cloud SQL): the three inserts (org, owner
  // membership, agent seeds) must be atomic — a partial commit would leave
  // an orphan org with no members. Wrap the lot in a single transaction.
  // postgres.js rolls back on any throw inside `sql.begin`.
  let createdOrg: { id: string; slug: string };
  try {
    createdOrg = await withTx(async (tx) => {
      await tx`set local lock_timeout = '2s'`;
      await tx`set local idle_in_transaction_session_timeout = '1s'`;
      if (invite && cookieCode) await lockInvitationForRedemption(tx, invite.id, cookieCode, user.email || "");
      const orgRows = await tx<{ id: string; slug: string }[]>`
        insert into noelle.organizations (name, slug, plan)
        values (${name}, ${slug}, 'alpha')
        returning id, slug
      `;
      const newOrg = orgRows[0];

      await tx`
        insert into noelle.org_members (org_id, user_id, role)
        values (${newOrg.id}, ${user.id}, 'owner')
      `;

      // Bulk insert agents. postgres.js doesn't expose Supabase's array
      // overload; do it explicitly so the SQL is readable.
      for (const s of seeds) {
        await tx`
          insert into noelle.agent_instances
            (org_id, role, status, display_name, budget_cap_cents, send_enabled, auto_send_enabled, reply_send_enabled)
          values
            (${newOrg.id}, ${s.role}, ${s.status}, ${s.display_name}, ${s.budget_cap_cents}, false, false, false)
        `;
      }

      // Environment codes have no single-use row. Database invitations require
      // their exact acknowledgment before any organization changes can commit.
      if (invite) await redeemLockedInvitation(tx, invite.id, user.id, newOrg.id);

      return newOrg;
    });
  } catch (err) {
    // Postgres unique-violation code is '23505' — same as before, just via
    // postgres.js error shape (`.code` on `PostgresError`).
    const e = err as { code?: string; message?: string };
    if (e.code === "23505") {
      return {
        ok: false,
        error: "That slug is taken. Try another.",
        fieldErrors: { slug: "Slug is taken." },
      };
    }
    return {
      ok: false,
      error: e.message ?? "Couldn't create org. Try again.",
    };
  }

  // Burn the invite cookie now that it's been spent.
  if (cookieCode) cookieStore.delete(INVITE_COOKIE);

  // Open the new social workspace.
  revalidatePath(`/app/${createdOrg.slug}`);
  redirect(`/app/${createdOrg.slug}`);
}
