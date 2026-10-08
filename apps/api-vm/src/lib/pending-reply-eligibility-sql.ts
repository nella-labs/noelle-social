import type { Sql } from "postgres";

/** Aliases a/l denote the current approval and its tenant-owned lead. */
export function unclaimedPendingReplySql(sql: Sql) {
  return sql.unsafe(`
    not exists (select 1 from noelle.x_reply_claims claim
      where claim.org_id=a.org_id and (claim.approval_id=a.id
        or (l.platform='x' and claim.tweet_id=l.external_id)))
    and not exists (select 1 from noelle.linkedin_reply_claims claim
      where claim.org_id=a.org_id and (claim.approval_id=a.id
        or (l.platform='linkedin' and claim.activity_urn=noelle.linkedin_post_activity_urn(l.payload,l.external_id))))
  `);
}
