import type { Sql } from "postgres";
import { unattendedReplyReviewSql } from "@noelle/runtime";
import { resolveLinkedInVoiceFloor } from "./linkedin-voice-policy.js";

export const DISCOVERY_REPLY_LIMIT = 5;
export const X_DISCOVERY_REPLY_LIMIT = 12;

/** Count unfinished browser-discovered posts that can still occupy a send slot. */
export async function discoveryReplyCapacity(
  sql: Sql,
  args: { orgId: string; instanceId: string; platform: "linkedin" | "x" },
): Promise<{ limit: number; occupied: number; available: number }> {
  const linkedinVoiceFloor = resolveLinkedInVoiceFloor();
  const [row] = await sql<Array<{ occupied: number }>>`
    select count(*)::int as occupied
    from noelle.leads l
    where l.org_id = ${args.orgId}
      and l.agent_instance_id = ${args.instanceId}
      and l.platform = ${args.platform}
      and l.payload->>'source' = 'extension_observed'
      and (
        l.status = 'drafting'
        or exists (
          select 1
          from noelle.approvals a
          join noelle.drafts d on d.id = a.draft_id and d.org_id = a.org_id
          where a.lead_id = l.id
            and a.org_id = ${args.orgId}
            and a.agent_instance_id = ${args.instanceId}
            and a.status = 'pending'
            and coalesce(d.payload->>'kind', 'reply') = 'reply'
            and ${unattendedReplyReviewSql(sql, sql`d.payload`)}
            and (${args.platform} = 'x' or case
              when jsonb_typeof(d.payload->'verifier_meta'->'scores'->'voice') = 'number'
              then (d.payload->'verifier_meta'->'scores'->>'voice')::numeric >= ${linkedinVoiceFloor}
              else false end)
        )
      )
  `;
  const occupied = Math.max(0, Number(row?.occupied ?? 0));
  const limit = args.platform === "x" ? X_DISCOVERY_REPLY_LIMIT : DISCOVERY_REPLY_LIMIT;
  return { limit, occupied, available: Math.max(0, limit - occupied) };
}
