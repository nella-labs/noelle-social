"use server";

/**
 * Settings Server Actions.
 *
 * `renameOrg` is owner-only. Pre-Phase-4 we relied on Supabase RLS as the
 * authoritative gate; with data in Cloud SQL there's no RLS and the TS
 * owner-check is the gate. The single `org_members` SELECT below also
 * subsumes the standard `assertOrgMember` membership check — a non-member
 * has no row at all and collapses to the same `forbidden` response.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { sql } from "@/lib/db";
import { getCurrentUser } from "@/lib/queries";

const RenameInput = z.object({
  orgId: z.string().uuid(),
  orgSlug: z.string().min(1),
  name: z.string().trim().min(2).max(80),
});

export type RenameOrgInput = z.infer<typeof RenameInput>;

export type RenameOrgResult =
  | { ok: true; name: string }
  | { ok: false; error: { code: string; message: string } };

export async function renameOrg(input: RenameOrgInput): Promise<RenameOrgResult> {
  const parsed = RenameInput.parse(input);
  const user = await getCurrentUser();
  if (!user) {
    return { ok: false, error: { code: "unauthenticated", message: "Sign in first." } };
  }

  // Owner-gate. Returning a single column avoids reading the whole row.
  const membership = await sql<{ role: string }[]>`
    select role
    from noelle.org_members
    where org_id = ${parsed.orgId} and user_id = ${user.id}
    limit 1
  `;

  if (membership.length === 0 || membership[0].role !== "owner") {
    return { ok: false, error: { code: "forbidden", message: "Only owners can rename the org." } };
  }

  try {
    await sql`
      update noelle.organizations
      set name = ${parsed.name}
      where id = ${parsed.orgId}
    `;
  } catch (err) {
    return {
      ok: false,
      error: { code: "update_failed", message: (err as Error).message },
    };
  }

  revalidatePath(`/app/${parsed.orgSlug}`);
  revalidatePath(`/app/${parsed.orgSlug}/settings`);
  return { ok: true, name: parsed.name };
}
