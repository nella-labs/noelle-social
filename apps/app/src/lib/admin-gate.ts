import { sql } from "@/lib/db";
import { getCurrentUser } from "@/lib/queries";

import { isLocalAuth, localOperatorEmail } from "./local-auth";

/** Hosted admin access is stored in the allowlist; ownership is configured by each installation. */
export interface AdminCheckResult {
  isAdmin: boolean;
  email: string | null;
}

export async function checkAdmin(): Promise<AdminCheckResult> {
  const user = await getCurrentUser();
  const email = user?.email ?? null;
  if (!email) return { isAdmin: false, email: null };

  const normalized = email.trim().toLowerCase();
  try {
    const rows = await sql<{ is_admin: boolean }[]>`
      select is_admin
      from noelle.invited_emails
      where email = ${normalized}
      limit 1
    `;
    return { isAdmin: rows[0]?.is_admin === true, email };
  } catch (err) {
    console.error("[admin-gate] is_admin lookup failed", err);
    return { isAdmin: false, email };
  }
}

/** Pure email-string check — no DB hit. Safe to call anywhere. */
export function isPrimaryAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const owner = process.env.NOELLE_PRIMARY_ADMIN_EMAIL?.trim() || (isLocalAuth() ? localOperatorEmail() : "");
  return Boolean(owner) && email.trim().toLowerCase() === owner.toLowerCase();
}

export interface PrimaryAdminCheckResult {
  isPrimaryAdmin: boolean;
  email: string | null;
}

/** Pulls the email from the current session and decides owner-or-not. */
export async function checkPrimaryAdmin(): Promise<PrimaryAdminCheckResult> {
  const user = await getCurrentUser();
  const email = user?.email ?? null;
  return { isPrimaryAdmin: isPrimaryAdminEmail(email), email };
}
