"use server";

/**
 * "Draft DM" (on a post in the approvals inbox) — flag the lead behind THIS
 * approval for a one-off DM. The owning agent's drafter (Lyra) claims it next
 * tick and drafts the NEXT rung of the progressive DM ladder (Open → Deepen →
 * Bridge → Invite), chosen by how many DMs were already sent to that person, and
 * queues it for approval. Auto-send stays off — Lyra never posts.
 *
 * Distinct from the Contacts "Generate DM" action (requestDmForPerson), which
 * targets a person's MOST-RECENT lead-with-a-post. This targets the SPECIFIC lead
 * behind the post the operator clicked, so the DM is grounded in that post.
 *
 * Tenancy: getOrgBySlug() asserts org membership (throws OrgMembershipError for
 * non-members), and the write is scoped to that org_id via the approval → lead
 * join, so a guessed approvalId from another tenant resolves to nothing. Setting
 * the flag is idempotent, and the drafter skips a lead that already has a pending
 * DM, so a double-tap never queues two DMs.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { OrgMembershipError } from "@noelle/runtime";
import { sql } from "@/lib/db";
import { getCurrentUser, getOrgBySlug } from "@/lib/queries";

const RequestDmForLeadInput = z.object({
  orgSlug: z.string().min(1),
  /** Any pending approval UUID for the post — we resolve the lead from it. */
  approvalId: z.string().uuid(),
});

export type RequestDmForLeadResult =
  | { ok: true }
  | {
      ok: false;
      error: "unauthenticated" | "forbidden" | "not_found" | "no_post" | "failed";
    };

export async function requestDmForLead(
  input: z.infer<typeof RequestDmForLeadInput>,
): Promise<RequestDmForLeadResult> {
  const parsed = RequestDmForLeadInput.parse(input);

  try {
    const user = await getCurrentUser();
    if (!user) return { ok: false, error: "unauthenticated" };

    // Asserts membership on the org (throws OrgMembershipError otherwise).
    const org = await getOrgBySlug(parsed.orgSlug);
    if (!org) return { ok: false, error: "not_found" };

    // Flag the lead behind this approval, scoped to the org so a cross-tenant id
    // writes nothing. Requires post text — the ladder DM grounds on the post.
    const rows = await sql<Array<{ id: string }>>`
      update noelle.leads l
      set payload = payload || '{"dm_requested": true}'::jsonb, updated_at = now()
      from noelle.approvals a
      where a.id = ${parsed.approvalId}
        and a.org_id = ${org.id}
        and l.id = a.lead_id
        and l.org_id = ${org.id}
        and coalesce(l.payload->>'text', '') <> ''
      returning l.id
    `;
    if (rows.length === 0) return { ok: false, error: "no_post" };

    revalidatePath(`/app/${parsed.orgSlug}/approvals`);
    revalidatePath("/app/[orgSlug]/approvals/[approvalId]", "page");
    return { ok: true };
  } catch (err) {
    if (err instanceof OrgMembershipError) return { ok: false, error: "forbidden" };
    console.error("[requestDmForLead] failed", err);
    return { ok: false, error: "failed" };
  }
}
