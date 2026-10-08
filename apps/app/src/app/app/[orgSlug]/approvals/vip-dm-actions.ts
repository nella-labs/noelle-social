"use server";

/**
 * "Park in DMs" — turn a VIP relationship-scout's precomputed intro DM
 * (noelle.leads.vip_signal.suggested_dm) into a real, parked draft so it shows
 * up in the Approvals inbox under the "DMs On" toggle, ready to send whenever
 * the operator gets to it.
 *
 * Why this exists: the gold VIP banner shows the intro DM inline with a "Copy
 * DM" button, but a copied string evaporates the moment you navigate away. For a
 * high-leverage account you'll often want to sit on the DM and send it a bit
 * later — so this stashes it as a `kind:'dm'` draft (which is exactly what the
 * DMs On filter, `payload->>'kind' = 'dm'`, surfaces) alongside the lead's other
 * drafts.
 *
 * The DM body is read SERVER-SIDE from the lead's vip_signal — never trusted
 * from the client — so the operator can only park the genuine scout-authored DM,
 * not an arbitrary injected message.
 *
 * Tenancy: getOrgBySlug() asserts org membership (it throws OrgMembershipError
 * for non-members), and every row we read or write is scoped to that org_id, so
 * a guessed approvalId from another tenant resolves to nothing.
 *
 * Idempotent: re-clicking is a no-op. We mark our row with
 * payload.source = 'vip_intro_dm' and skip the insert when one already exists
 * for the lead, so a double-tap (or a second operator) never parks two copies.
 */

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { OrgMembershipError } from "@noelle/runtime";
import { parseVipSignal } from "@noelle/contracts";
import { sql } from "@/lib/db";
import { getCurrentUser, getOrgBySlug } from "@/lib/queries";

/** Marker stamped on the draft payload so the park is idempotent + identifiable. */
const VIP_DM_SOURCE = "vip_intro_dm";

const ParkInput = z.object({
  orgSlug: z.string().min(1),
  /** Any pending approval UUID for the VIP lead — we resolve the lead from it. */
  approvalId: z.string().uuid(),
});

export type ParkVipIntroDmResult =
  | { ok: true; already: boolean }
  | {
      ok: false;
      error: "unauthenticated" | "forbidden" | "not_found" | "no_dm" | "failed";
    };

export async function parkVipIntroDm(
  input: z.infer<typeof ParkInput>,
): Promise<ParkVipIntroDmResult> {
  const parsed = ParkInput.parse(input);

  try {
    const user = await getCurrentUser();
    if (!user) return { ok: false, error: "unauthenticated" };

    // Asserts membership on the org (throws OrgMembershipError otherwise).
    const org = await getOrgBySlug(parsed.orgSlug);
    if (!org) return { ok: false, error: "not_found" };

    // Resolve the lead (+ its scout signal + owning instance) from the approval,
    // scoped to this org so a cross-tenant id returns nothing.
    const rows = await sql<
      Array<{ lead_id: string; agent_instance_id: string; vip_signal: unknown }>
    >`
      select a.lead_id, a.agent_instance_id, l.vip_signal
      from noelle.approvals a
      join noelle.leads l on l.id = a.lead_id
      where a.id = ${parsed.approvalId} and a.org_id = ${org.id}
      limit 1
    `;
    const row = rows[0];
    if (!row) return { ok: false, error: "not_found" };

    // The DM text comes only from the scout's persisted signal — never the client.
    const signal = parseVipSignal(row.vip_signal);
    const body =
      signal?.dm_soon && signal.suggested_dm?.trim()
        ? signal.suggested_dm.trim()
        : null;
    if (!body) return { ok: false, error: "no_dm" };

    // Idempotency: if this lead already has a parked VIP intro DM, do nothing.
    const existing = await sql<Array<{ one: number }>>`
      select 1 as one
      from noelle.drafts
      where lead_id = ${row.lead_id} and payload->>'source' = ${VIP_DM_SOURCE}
      limit 1
    `;
    if (existing[0]) {
      revalidate(parsed.orgSlug);
      return { ok: true, already: true };
    }

    const draftId = randomUUID();
    const payload = {
      kind: "dm" as const,
      angle: null,
      body,
      char_count: [...body].length,
      source: VIP_DM_SOURCE,
    };

    await sql`
      insert into noelle.drafts (id, lead_id, org_id, payload)
      values (${draftId}, ${row.lead_id}, ${org.id}, ${sql.json(payload as never)})
      on conflict (id) do nothing
    `;
    await sql`
      insert into noelle.approvals (org_id, agent_instance_id, draft_id, lead_id, status)
      values (${org.id}, ${row.agent_instance_id}, ${draftId}, ${row.lead_id}, 'pending')
      on conflict (draft_id) do nothing
    `;

    revalidate(parsed.orgSlug);
    return { ok: true, already: false };
  } catch (err) {
    if (err instanceof OrgMembershipError) return { ok: false, error: "forbidden" };
    console.error("[parkVipIntroDm] failed", err);
    return { ok: false, error: "failed" };
  }
}

/** Refresh the inbox (the DM now exists) + the detail route (banner state). */
function revalidate(orgSlug: string) {
  revalidatePath(`/app/${orgSlug}/approvals`);
  revalidatePath("/app/[orgSlug]/approvals/[approvalId]", "page");
}
