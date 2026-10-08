/**
 * Alpha invitation data access — the single source of truth for reading and
 * generating invitations. Both the onboarding flow (redeem) and the admin
 * panel (create/revoke) go through here so the lookup rules live in one place.
 *
 * Backed by noelle.alpha_invitations (see infra/cloudsql/schema/0016).
 */

import { randomBytes } from "node:crypto";
import type { TransactionSql } from "postgres";
import { sql } from "@/lib/db";

export type InvitationKind = "email" | "code";
export type InvitationStatus = "pending" | "redeemed" | "revoked";

export interface Invitation {
  id: string;
  code: string;
  email: string | null;
  kind: InvitationKind;
  status: InvitationStatus;
  note: string | null;
  created_by: string | null;
  created_at: string;
  expires_at: string | null;
  redeemed_at: string | null;
  redeemed_by: string | null;
  redeemed_org_id: string | null;
}

export class InvitationUnavailableError extends Error {
  constructor() { super("Invite code is no longer valid for this account."); }
}

/** Hold the exact invitation until its organization and redemption commit together. */
export async function lockInvitationForRedemption(
  tx: TransactionSql, id: string, code: string, email: string,
): Promise<void> {
  const locked = await tx<{ id: string }[]>`
    select id from noelle.alpha_invitations
    where id = ${id} and code = ${code} for update
  `;
  if (locked.length !== 1) throw new InvitationUnavailableError();
  // Read the clock after any lock wait; transaction now() can predate expiry.
  const current = await tx<{ id: string }[]>`
    select id from noelle.alpha_invitations
    where id = ${id} and code = ${code} and status = 'pending'
      and (expires_at is null or expires_at > clock_timestamp())
      and (email is null or lower(btrim(email)) = ${email.trim().toLowerCase()})
  `;
  if (current.length !== 1) throw new InvitationUnavailableError();
}

/** A missing or changed acknowledgment must roll back the surrounding transaction. */
export async function redeemLockedInvitation(
  tx: TransactionSql, id: string, userId: string, orgId: string,
): Promise<void> {
  const rows = await tx<{ id: string; status: string; redeemed_by: string; redeemed_org_id: string }[]>`
    update noelle.alpha_invitations
    set status = 'redeemed', redeemed_at = clock_timestamp(),
        redeemed_by = ${userId}, redeemed_org_id = ${orgId}
    where id = ${id} and status = 'pending'
      and (expires_at is null or expires_at > clock_timestamp())
    returning id, status, redeemed_by, redeemed_org_id
  `;
  const row = rows[0];
  if (rows.length !== 1 || row?.id !== id || row.status !== 'redeemed'
    || row.redeemed_by !== userId || row.redeemed_org_id !== orgId) throw new InvitationUnavailableError();
}

/** `constellation-ab12cd` — short, copy-pasteable, low collision risk. */
export function generateInviteCode(): string {
  return `constellation-${randomBytes(3).toString("hex")}`;
}

/**
 * Look up an invite that can still be redeemed: pending and not expired.
 * Used by onboarding when a user submits a code or auto-redeems an email
 * invite. Returns null if missing, redeemed, revoked, or expired.
 */
export async function findRedeemableInvite(
  code: string,
): Promise<Invitation | null> {
  const trimmed = code.trim();
  if (!trimmed) return null;
  const rows = await sql<Invitation[]>`
    select *
    from noelle.alpha_invitations
    where code = ${trimmed}
      and status = 'pending'
      and (expires_at is null or expires_at > now())
    limit 1
  `;
  return rows[0] ?? null;
}

/**
 * The pending email-bound invite for an address, if any. Lets onboarding skip
 * the code-entry step for invited recipients.
 */
export async function findPendingEmailInvite(
  email: string,
): Promise<Invitation | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  const rows = await sql<Invitation[]>`
    select *
    from noelle.alpha_invitations
    where lower(email) = ${normalized}
      and kind = 'email'
      and status = 'pending'
      and (expires_at is null or expires_at > now())
    order by created_at desc
    limit 1
  `;
  return rows[0] ?? null;
}

/** Most-recent-first list for the admin panel. */
export async function listInvitations(limit = 200): Promise<Invitation[]> {
  return sql<Invitation[]>`
    select *
    from noelle.alpha_invitations
    order by created_at desc
    limit ${limit}
  `;
}
