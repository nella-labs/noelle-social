import type { Sql } from "postgres";
import { readXSourceId } from "@noelle/x-client";

/** Confirmed or uncertain dispatch evidence is permanent, scoped to this candidate batch. */
export async function fetchXRepliedTweetIds(sql: Sql, orgId: string, targets: readonly string[]): Promise<Set<string>> {
  if (targets.length > 500) throw new RangeError("reply evidence batch exceeds 500 targets");
  const ids = [...new Set(targets.map(id => readXSourceId(id)).filter((id): id is string => id !== null))];
  if (!ids.length) return new Set();
  const rows = await sql<{ tweet_id: string }[]>`
    select distinct tweet_id from (
      select act.tweet_id from noelle.x_activity act
      where act.org_id=${orgId} and act.type in ('reply', 'skip')
        and act.tweet_id is not null and act.tweet_id=any(${ids}::text[])
      union
      select le.external_id as tweet_id from noelle.approvals a
      join noelle.drafts d on d.id=a.draft_id and d.org_id=a.org_id
      join noelle.leads le on le.id=a.lead_id and le.org_id=a.org_id
      where a.org_id=${orgId} and a.status = 'sent' and le.platform='x'
        and coalesce(d.payload->>'kind','reply')='reply' and le.external_id=any(${ids}::text[])
      union
      select claim.tweet_id from noelle.x_reply_claims claim
      where claim.org_id=${orgId} and claim.tweet_id=any(${ids}::text[])
    ) evidence
  `;
  return new Set(rows.map(row => row.tweet_id));
}
