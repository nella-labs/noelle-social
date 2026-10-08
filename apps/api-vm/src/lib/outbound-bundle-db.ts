import type { Sql } from "postgres";
import { isDeepStrictEqual } from "node:util";
import type { OutboundIn } from "@noelle/contracts";
import { AmbiguousOutboundOwnerError, resolveActiveInstanceForPlatform } from "./auth.js";
import { outboundApprovalRows, outboundDraftRows, outboundLeadPayload, type OutboundStoredDraft } from "./outbound-bundle.js";

export class OutboundBundleError extends Error {
  constructor(readonly code: string, readonly status: 400 | 409 | 500) { super(code); }
}
export type OutboundApprovalReceipt = { id: string; draft_id: string; status: string; created_at: string };
type SavedDraft = OutboundStoredDraft & { org_id: string; lead_id: string };
const immutableFields = ["kind", "angle", "body", "reply_target", "reply_request_key"] as const;

/** One coherent, locked bundle; no external notification runs before its commit. */
export async function saveOutboundBundle(sql: Sql, payload: OutboundIn, voiceFloor?: number) {
  const incoming = outboundDraftRows(payload);
  if (new Set(incoming.map(d => d.id.toLowerCase())).size !== incoming.length)
    throw new OutboundBundleError("invalid_body", 400);
  let stage = "lead_upsert_failed";
  try {
    return await sql.begin(async tx => {
      await tx`set local lock_timeout='5s'`;
      await tx`set local statement_timeout='10s'`;
      await tx`set local idle_in_transaction_session_timeout='20s'`;
      const owner = await resolveActiveInstanceForPlatform(payload.platform, payload.owner, { sql: tx, lock: true });
      if (!owner) throw new OutboundBundleError("no_active_instance", 500);
      const [lead] = await tx<{ id: string }[]>`
        insert into noelle.leads (external_id,org_id,agent_instance_id,platform,author_handle,author_id,status,payload)
        values (${payload.leadId},${owner.org_id},${owner.agent_instance_id},${payload.platform},${payload.authorHandle},
          ${payload.authorId},${payload.postKind === "relationship_dm" ? "drafted" : "new"},${tx.json(outboundLeadPayload(payload))})
        on conflict (org_id,platform,external_id) do update
          set agent_instance_id=coalesce(noelle.leads.agent_instance_id,excluded.agent_instance_id),
              payload=noelle.leads.payload || case when excluded.payload->>'posted_at' is null
                then excluded.payload-'posted_at' else excluded.payload end
          where noelle.leads.org_id=excluded.org_id
            and (noelle.leads.agent_instance_id is null or noelle.leads.agent_instance_id=excluded.agent_instance_id)
        returning id
      `;
      if (!lead) throw new OutboundBundleError("bundle_identity_conflict", 409);
      stage = "drafts_upsert_failed";
      await tx`insert into noelle.drafts ${tx(incoming.map(d => ({ id: d.id, org_id: owner.org_id,
        lead_id: lead.id, payload: tx.json(d.payload) })), "id", "org_id", "lead_id", "payload")}
        on conflict (id) do nothing`;
      const ids = incoming.map(d => d.id);
      const saved = await tx<SavedDraft[]>`select id,org_id,lead_id,payload from noelle.drafts
        where id in ${tx(ids)} order by id for no key update`;
      const byId = new Map(saved.map(d => [d.id.toLowerCase(), d]));
      const ordered = incoming.map(d => {
        const stored = byId.get(d.id.toLowerCase());
        if (!stored || stored.org_id !== owner.org_id || stored.lead_id !== lead.id
          || immutableFields.some(field => !isDeepStrictEqual(stored.payload[field] ?? null, d.payload[field] ?? null))
          || (Object.hasOwn(d.payload, "review_context")
            && !isDeepStrictEqual(stored.payload.review_context, d.payload.review_context)))
          throw new OutboundBundleError("bundle_identity_conflict", 409);
        return stored;
      });
      stage = "approvals_upsert_failed";
      const approvals = outboundApprovalRows(ordered, owner, lead.id, payload.platform, voiceFloor);
      await tx`insert into noelle.approvals ${tx(approvals,"org_id","agent_instance_id","draft_id","lead_id",
        "status","decided_at","decided_by","skip_reason")} on conflict (draft_id) do nothing`;
      const receipts = await tx<(OutboundApprovalReceipt & { org_id: string; agent_instance_id: string; lead_id: string })[]>`
        select id,draft_id,status,created_at,org_id,agent_instance_id,lead_id from noelle.approvals
        where draft_id in ${tx(ids)} order by draft_id for no key update
      `;
      if (receipts.length !== incoming.length || receipts.some(a => a.org_id !== owner.org_id
        || a.agent_instance_id !== owner.agent_instance_id || a.lead_id !== lead.id))
        throw new OutboundBundleError("bundle_identity_conflict", 409);
      const byDraft = new Map(receipts.map(a => [a.draft_id.toLowerCase(), a]));
      return { owner, leadId: lead.id, approvals: incoming.map(d => byDraft.get(d.id.toLowerCase())!) };
    });
  } catch (error) {
    if (error instanceof OutboundBundleError) throw error;
    if (error instanceof AmbiguousOutboundOwnerError) throw new OutboundBundleError("ambiguous_owner", 409);
    throw new OutboundBundleError(stage, 500);
  }
}
