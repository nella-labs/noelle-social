import type { Sql } from "postgres";
import { reserveXReplyClaimInTransaction } from "@noelle/runtime";
import { readXBrowserReplyCapInTransaction } from "./x-browser-reply-cap-db.js";
import { readXBrowserReplyUsage } from "./x-browser-reply-usage-db.js";

type ClaimOutcome = "claimed" | "not-eligible" | "already-claimed" | "daily-cap" | "per-author-cap" | "challenge";
class AuthorCapReached extends Error {}

/** Organization quota and dispatch eligibility commit with the permanent target claim. */
export async function reserveXBrowserReply(sql: Sql, args: {
  orgId: string; instanceId: string; approvalId: string; draftId: string;
  tweetId: string; body: string; maxAgeHours: number; blockExternalLinks: boolean;
  perAuthorCap: number | null; haltOnChallenge: boolean;
}): Promise<ClaimOutcome> {
  try {
    return await sql.begin(async tx => {
      await tx`set local lock_timeout='5s'`;
      await tx`set local statement_timeout='10s'`;
      await tx`select id from noelle.organizations where id=${args.orgId} for update`;
      const policy = await readXBrowserReplyCapInTransaction(tx, args);
      if (!policy) return "not-eligible";
      if (args.haltOnChallenge) {
        const [row] = await tx<{ n: number }[]>`select count(*)::int as n from noelle.x_activity
          where org_id=${args.orgId} and reason='challenge' and created_at>=now()-interval '1 hour'`;
        if (!row || row.n > 0) return "challenge";
      }
      const dailyCap = policy.cap;
      if (dailyCap !== null) {
        if (await readXBrowserReplyUsage(tx as unknown as Sql, args.orgId) >= dailyCap) return "daily-cap";
      }
      const claim = await reserveXReplyClaimInTransaction(tx, {
        orgId: args.orgId, draftId: args.draftId, approvalId: args.approvalId,
        targetTweetId: args.tweetId, mode: "browser", body: args.body,
        maxAgeHours: args.maxAgeHours, blockExternalLinks: args.blockExternalLinks,
      });
      if (!claim) return "already-claimed";
      if (args.perAuthorCap !== null) {
        const [count] = await tx<{ n: number }[]>`
          with author as (
            select lower(ltrim(btrim(l.author_handle),'@')) as handle
            from noelle.approvals a join noelle.leads l on l.id=a.lead_id and l.org_id=a.org_id
            where a.id=${claim.approvalId} and a.org_id=${args.orgId}
          ), reserved as (
            select c.tweet_id from noelle.x_reply_claims c
            join noelle.approvals a on a.id=c.approval_id and a.org_id=c.org_id
            join noelle.leads l on l.id=a.lead_id and l.org_id=c.org_id
            where c.org_id=${args.orgId} and c.claimed_at>=date_trunc('day',now())
              and lower(ltrim(btrim(l.author_handle),'@'))=(select handle from author)
          )
          select count(distinct tweet_id)::int as n from (
            select tweet_id from reserved
            union
            select coalesce(act.tweet_id,'activity:'||act.id::text) as tweet_id from noelle.x_activity act
            left join noelle.approvals a on a.id=act.approval_id and a.org_id=act.org_id
            left join noelle.leads l on l.id=a.lead_id and l.org_id=act.org_id
            where act.org_id=${args.orgId} and act.type='reply' and act.created_at>=date_trunc('day',now())
              and lower(ltrim(btrim(coalesce(nullif(act.author_handle,''),l.author_handle)),'@'))=(select handle from author)
          ) usage
        `;
        // Throwing rolls the newly inserted claim back with the quota decision.
        if (!count || count.n > args.perAuthorCap) throw new AuthorCapReached();
      }
      return "claimed";
    });
  } catch (error) {
    if (error instanceof AuthorCapReached) return "per-author-cap";
    throw error;
  }
}
