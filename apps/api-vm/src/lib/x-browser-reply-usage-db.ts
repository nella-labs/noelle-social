import type { Sql } from "postgres";

/** Today's permanent reservations plus confirmed replies without a matching reservation. */
export async function readXBrowserReplyUsage(sql: Sql, orgId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select (
      (select count(*) from noelle.x_reply_claims claim
       where claim.org_id=${orgId} and claim.claimed_at>=date_trunc('day',now()))
      + (select count(*) from noelle.x_activity act
         where act.org_id=${orgId} and act.type='reply' and act.created_at>=date_trunc('day',now())
           and not exists (select 1 from noelle.x_reply_claims claim
             where claim.org_id=${orgId} and claim.claimed_at>=date_trunc('day',now()) and claim.tweet_id=act.tweet_id))
    )::int as n
  `;
  return row?.n ?? Number.POSITIVE_INFINITY;
}
