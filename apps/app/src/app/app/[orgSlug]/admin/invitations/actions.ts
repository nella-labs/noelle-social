"use server";

import { revalidatePath } from "next/cache";
import { sql } from "@/lib/db";
import { getUserFromCookies } from "@/lib/auth-cookie";
import { checkPrimaryAdmin } from "@/lib/admin-gate";
import { generateInviteCode } from "@/lib/invitations";
import { listmonkConfigured, sendTransactional } from "@/lib/listmonk";
import {
  buildEmailHtml,
  emailAppUrl,
  ctaButton,
  eyebrow as eyebrowBlock,
  footnote,
  headline as headlineBlock,
  monoBlock,
  paragraph,
} from "@/lib/email/template.mjs";

const ONBOARDING_URL = `${emailAppUrl()}/onboarding`;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type CreateEmailInviteResult =
  | { ok: true; code: string; emailSent: boolean }
  | { ok: false; error: string };

export type CreateCodeInviteResult =
  | { ok: true; codes: string[] }
  | { ok: false; error: string };

export type RevokeInviteResult = { ok: boolean; error?: string };

/** Insert a row, regenerating the code on the (rare) unique collision. */
async function insertInvite(args: {
  kind: "email" | "code";
  email: string | null;
  note: string | null;
  createdBy: string | null;
}): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateInviteCode();
    try {
      await sql`
        insert into noelle.alpha_invitations (code, email, kind, note, created_by)
        values (${code}, ${args.email}, ${args.kind}, ${args.note}, ${args.createdBy})
      `;
      return code;
    } catch (err) {
      if ((err as { code?: string }).code === "23505") continue; // dup code, retry
      throw err;
    }
  }
  throw new Error("Couldn't generate a unique invite code.");
}

function renderInviteEmail(code: string): string {
  const body = [
    eyebrowBlock("Workspace invitation"),
    headlineBlock("You're invited to Noelle."),
    paragraph(
      "You've been invited to Noelle, a workspace for social engagement and content planning. " +
        "Sign in with this email address to set up your workspace.",
    ),
    ctaButton(ONBOARDING_URL, "Accept your invite"),
    paragraph("If you're ever asked for an invite code, use this one:"),
    monoBlock(code, { center: true }),
    footnote(
      "This invite is tied to your email address. If you weren't expecting it, you can safely ignore this email.",
    ),
  ].join("\n");
  return buildEmailHtml({
    preheader: "Your Noelle workspace invite is ready.",
    transactional: true,
    body,
  });
}

/**
 * Create an email-bound invitation: generate a code, seed the recipient into
 * the sign-in allowlist (invited_emails), and send the invite email. Owner-only.
 */
export async function createEmailInvitation(input: {
  email: string;
  note?: string;
}): Promise<CreateEmailInviteResult> {
  const { isPrimaryAdmin } = await checkPrimaryAdmin();
  if (!isPrimaryAdmin) return { ok: false, error: "Owner only" };

  const email = String(input.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, error: "Enter a valid email." };
  const note = input.note?.trim() ? input.note.trim().slice(0, 200) : null;

  const user = await getUserFromCookies();
  const createdBy = user?.id ?? null;

  let code: string;
  try {
    // Reuse an outstanding pending invite for this email rather than minting
    // duplicates (resending is idempotent on the code).
    const existing = await sql<{ code: string }[]>`
      select code
      from noelle.alpha_invitations
      where lower(email) = ${email} and kind = 'email' and status = 'pending'
      order by created_at desc
      limit 1
    `;
    code = existing[0]?.code ?? (await insertInvite({ kind: "email", email, note, createdBy }));

    // Seed the sign-in allowlist so the recipient can authenticate at all.
    // Don't touch is_admin if they already exist.
    await sql`
      insert into noelle.invited_emails (email, invited_by)
      values (${email}, ${createdBy})
      on conflict (email) do nothing
    `;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // Best-effort send — the invite row exists regardless of mail success.
  let emailSent = false;
  if (listmonkConfigured()) {
    try {
      await sendTransactional({
        toEmail: email,
        subject: "You're invited to Noelle (private alpha)",
        body: renderInviteEmail(code),
      });
      emailSent = true;
    } catch (err) {
      console.error("[invitations] invite email send failed", err);
    }
  }

  revalidatePath("/app/[orgSlug]/admin/invitations", "page");
  return { ok: true, code, emailSent };
}

/** Mint N loose shareable codes (not bound to any email). Owner-only. */
export async function createCodeInvitations(input: {
  count: number;
  note?: string;
}): Promise<CreateCodeInviteResult> {
  const { isPrimaryAdmin } = await checkPrimaryAdmin();
  if (!isPrimaryAdmin) return { ok: false, error: "Owner only" };

  const count = Math.floor(Number(input.count));
  if (!Number.isFinite(count) || count < 1 || count > 25) {
    return { ok: false, error: "Pick a count between 1 and 25." };
  }
  const note = input.note?.trim() ? input.note.trim().slice(0, 200) : null;

  const user = await getUserFromCookies();
  const createdBy = user?.id ?? null;

  const codes: string[] = [];
  try {
    for (let i = 0; i < count; i++) {
      codes.push(await insertInvite({ kind: "code", email: null, note, createdBy }));
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  revalidatePath("/app/[orgSlug]/admin/invitations", "page");
  return { ok: true, codes };
}

/** Revoke a pending invitation (no-op if already redeemed/revoked). Owner-only. */
export async function revokeInvitation(input: {
  id: string;
}): Promise<RevokeInviteResult> {
  const { isPrimaryAdmin } = await checkPrimaryAdmin();
  if (!isPrimaryAdmin) return { ok: false, error: "Owner only" };

  const id = String(input.id ?? "").trim();
  if (!id) return { ok: false, error: "Missing invite id." };

  try {
    await sql`
      update noelle.alpha_invitations
      set status = 'revoked'
      where id = ${id} and status = 'pending'
    `;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  revalidatePath("/app/[orgSlug]/admin/invitations", "page");
  return { ok: true };
}
