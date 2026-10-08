import type { JSONValue, Sql } from "postgres";
import type { VipSignal } from "@noelle/contracts";
import { sourceTimestampSql, xReplyAgeCutoffSql } from "@noelle/runtime";
import { BoundedPgSession } from "@noelle/runtime/bounded-pg-session";

const classificationReleaseSessions = new WeakMap<Sql, BoundedPgSession>();

function classificationReleaseSession(parent: Sql): BoundedPgSession {
  let session = classificationReleaseSessions.get(parent);
  if (!session) {
    session = new BoundedPgSession(parent, {
      deadlineMs: 3000,
      maxPending: 32,
      idleTimeoutMs: 1000,
    });
    classificationReleaseSessions.set(parent, session);
  }
  return session;
}

/**
 * Global safety ceiling for pending watchlist replies. The real constraint is
 * one pending reply per watched person (the claim is `distinct on (author)`),
 * so the effective cap is the number of watched accounts; this just bounds it if
 * someone watchlists a very large number of people.
 */
export const WATCHLIST_PENDING_CAP = 100;

export { OBSERVED_REPLY_ACTIVE_CAP } from "./reply-opportunity.js";

export interface LeadRow {
  id: string;
  external_id: string;
  payload: Record<string, unknown>;
  author_handle: string;
  author_id: string | null;
  tier: "T1" | "T2" | "T3" | null;
  classifier_label: string | null;
  classifier_score: number | null;
  /**
   * Engagement-bait flag from the classifier (shared noelle.leads column, mig
   * 0031). A comment-farming CTA post inflates its reply count with junk, so the
   * drafter must NOT read that count as real discussion when deciding whether to
   * escalate to the smarter model. Null on rows classified before this shipped.
   */
  comment_bait?: boolean | null;
  status: string;
  /** Always-reply marker: true for watchlist-person posts. Bypasses filters. */
  priority: boolean;
}

export type ClassificationClaim = LeadRow & {
  /** Exact database text, preserving timestamp precision for release CAS. */
  classification_claimed_at: string;
};

export const CLASSIFICATION_BATCH_LIMIT = 10;

export async function upsertDiscoveredLead(
  sql: Sql,
  args: {
    orgId: string;
    agentInstanceId: string;
    platform: "x" | "linkedin" | "reddit";
    externalId: string;
    authorHandle: string;
    authorId: string | null;
    payload: Record<string, unknown>;
    postedAt: string | null;
    priority: boolean;
  },
): Promise<{ id: string; inserted: boolean }> {
  // The tweet's own created_at lives inside payload.posted_at — noelle.leads
  // has no dedicated posted_at column (only created_at / updated_at, which are
  // system clocks). The dashboard pulls payload.posted_at for "tweeted Nh ago"
  // labels.
  const payloadWithPostedAt = { ...args.payload, posted_at: args.postedAt };
  const rows = await sql<{ id: string; inserted: boolean }[]>`
    with ins as (
      insert into noelle.leads
        (org_id, agent_instance_id, external_id, platform, author_handle, author_id, payload, status, priority)
      values
        (${args.orgId}, ${args.agentInstanceId}, ${args.externalId}, ${args.platform},
         ${args.authorHandle}, ${args.authorId}, ${sql.json(payloadWithPostedAt as JSONValue)}, 'new', ${args.priority})
      -- On a re-seen tweet, UPGRADE priority false→true if the author is now a
      -- watchlist person (e.g. it was first ingested via keyword/targeting
      -- before they were watchlisted). Only false→true, never a downgrade, and
      -- only the flag — status/payload are untouched (an already-classified lead
      -- isn't reopened; the bypass applies on its next classify if still 'new').
      on conflict (org_id, platform, external_id) do update
        set priority = true
        where noelle.leads.priority = false and excluded.priority = true
      returning id, (xmax = 0) as inserted
    )
    select id, inserted from ins
    union all
    select id, false as inserted
    from noelle.leads
    where org_id = ${args.orgId}
      and platform = ${args.platform}
      and external_id = ${args.externalId}
      and not exists (select 1 from ins)
    limit 1
  `;
  return rows[0]!;
}

export async function claimLeadsForClassification(
  sql: Sql,
  args: {
    orgId: string;
    agentInstanceId: string;
    batch: number;
    /**
     * Watchlist-lane mode: claim only priority (watchlist-person) leads. Used
     * when the instance is paused — the keyword lane is off, but watched
     * accounts must still be classified. Default false = claim any 'new' lead.
     */
    priorityOnly?: boolean;
  },
): Promise<ClassificationClaim[]> {
  const rows = await sql<ClassificationClaim[]>`
    update noelle.leads
    set status = 'classifying', updated_at = now()
    where id in (
      select id from noelle.leads
      where org_id = ${args.orgId}
        and agent_instance_id = ${args.agentInstanceId}
        and status = 'new'
        ${args.priorityOnly ? sql`and priority = true` : sql``}
      order by created_at asc
      for update skip locked
      limit ${args.batch}
    )
    returning id, external_id, payload, author_handle, author_id, tier, classifier_label, classifier_score, status, priority,
              updated_at::text as classification_claimed_at
  `;
  return [...rows];
}

/** Requeue only the unchanged claims rejected before model dispatch. */
export async function releaseClassificationClaims(
  sql: Sql,
  args: { orgId: string; agentInstanceId: string; claims: readonly ClassificationClaim[] },
): Promise<number> {
  if (!args.claims.length || args.claims.length > CLASSIFICATION_BATCH_LIMIT) return 0;
  const claims = args.claims.map((claim) => ({
    id: claim.id,
    claimed_at: claim.classification_claimed_at,
  }));
  return classificationReleaseSession(sql).run((owned) =>
    owned.begin(async (tx) => {
      await tx`set local lock_timeout='1s'`;
      await tx`set local statement_timeout='2s'`;
      await tx`set local idle_in_transaction_session_timeout='3s'`;
      const rows = await tx<{ id: string }[]>`
        with owner as materialized (
          select id from noelle.agent_instances
          where id = ${args.agentInstanceId} and org_id = ${args.orgId} and role = 'x_intern'
          for no key update
        )
        update noelle.leads l set status = 'new', updated_at = now()
        from owner, jsonb_to_recordset(${tx.json(claims)}::jsonb) as c(id uuid, claimed_at text)
        where l.id = c.id and l.agent_instance_id = owner.id
          and l.org_id = ${args.orgId} and l.platform = 'x' and l.status = 'classifying'
          and l.updated_at::text = c.claimed_at
        returning l.id
      `;
      return rows.length;
    }),
  );
}

/** Stage browser observations outside the legacy new/fail-open classifier lane. */
export async function claimObservedLeadsForClassification(
  sql: Sql,
  args: { orgId: string; agentInstanceId: string; batch: number },
): Promise<LeadRow[]> {
  const rows = await sql<LeadRow[]>`
    update noelle.leads l
    set status = 'observed_classifying', updated_at = now()
    where l.id in (
      select id from noelle.leads
      where org_id = ${args.orgId} and agent_instance_id = ${args.agentInstanceId}
        and platform = 'x' and status = 'observed'
        and payload->>'source' = 'extension_observed'
      order by created_at asc
      for update skip locked
      limit ${args.batch}
    )
    returning l.id, l.external_id, l.payload, l.author_handle, l.author_id,
              l.tier, l.classifier_label, l.classifier_score, l.status, l.priority
  `;
  return [...rows];
}

/**
 * How many leads this instance has ingested TODAY, across every lane. Drives the
 * daily extract cap + the watch-lane reserve (lib/discovery-budget.ts), so the
 * high-volume keyword lane cannot burn the day's Apify budget and starve the
 * operator's hand-picked accounts.
 */
export async function countExtractedToday(sql: Sql, agentInstanceId: string): Promise<number> {
  const rows = await sql<{ count: string }[]>`
    select count(*)::text as count
    from noelle.leads
    where agent_instance_id = ${agentInstanceId}
      and created_at::date = current_date
  `;
  return Number(rows[0]?.count ?? 0);
}

export async function markLeadClassified(
  sql: Sql,
  args: {
    leadId: string;
    label: string;
    /** 0-1 normalised score, or null when the classifier couldn't score. */
    score: number | null;
    tier: "T1" | "T2" | "T3" | null;
    onBrand: boolean;
    classifierMeta: Record<string, unknown>;
    /** Engagement-bait verdict → noelle.leads.comment_bait. Default false. */
    commentBait?: boolean;
    /**
     * Relationship-scout verdict to persist on noelle.leads.vip_signal. null
     * (scout off / fail-open / model omitted it) writes NULL — the approvals
     * banner only renders for a non-null `vip: true` row, so this is fail-open.
     */
    vipSignal?: VipSignal | null;
  },
): Promise<void> {
  await sql`
    update noelle.leads
    set status = ${args.onBrand ? "classified" : "skipped"},
        classifier_label = ${args.label},
        classifier_score = ${args.score},
        tier = ${args.tier},
        comment_bait = ${args.commentBait ?? false},
        vip_signal = ${args.vipSignal ? sql.json(args.vipSignal as unknown as JSONValue) : null}::jsonb,
        payload = payload || ${sql.json({ classifier: args.classifierMeta } as JSONValue)}::jsonb,
        updated_at = now()
    where id = ${args.leadId}
  `;
}

export async function claimLeadsForDrafting(
  sql: Sql,
  args: { agentInstanceId: string; batch: number; maxAgeHours?: number },
): Promise<LeadRow[]> {
  // RPC defined in infra/cloudsql/schema/0088_reply_freshness_rpcs.sql:
  // freshest-tweet-first, bounded by the target-tweet age ceiling
  // (X_REPLY_MAX_AGE_HOURS; null/0 = no age filter).
  const rows = await sql<LeadRow[]>`
    select * from noelle.claim_leads_for_drafting(
      ${args.agentInstanceId}::uuid, ${args.batch}, ${args.maxAgeHours ?? null}
    )
  `;
  return [...rows];
}

/**
 * Watchlist-lane drafting claim — ONE pending reply per watched person.
 *
 * Claims, per watched author, that author's NEWEST classified priority lead,
 * but only for authors who have no pending (non-DM) reply approval right now,
 * up to `cap` authors total. So the watched accounts each carry at most one
 * pending reply; once the operator sends/marks-sent it, the author is eligible
 * again next tick. RPC defined in infra/cloudsql/schema/0035_watchlist_drafting_rpc.sql.
 */
export async function claimWatchlistLeadsForDrafting(
  sql: Sql,
  args: { agentInstanceId: string; cap: number; maxAgeHours?: number },
): Promise<LeadRow[]> {
  const rows = await sql<LeadRow[]>`
    select * from noelle.claim_watchlist_leads_for_drafting(
      ${args.agentInstanceId}::uuid, ${args.cap}, ${args.maxAgeHours ?? null}
    )
  `;
  return [...rows];
}

export { claimObservedLeadsForDrafting } from "./observed-reply-claims-db.js";

/**
 * Freshness sweep for the legacy drafting queue (X_REPLY_MAX_AGE_HOURS): 'classified'
 * leads whose TARGET TWEET has aged past the ceiling are flipped to 'skipped'
 * with a payload marker. The 0088 claim RPCs already refuse to CLAIM them;
 * without this sweep they would sit 'classified' forever, eating backlog-cap
 * headroom (countLeadBacklogForInstance counts 'classified') and misreading as
 * a live queue. Applies to both lanes — a watchlist author's week-old post is
 * noise too, and their next post arrives as a fresh lead. Fail-open on
 * undateable posted_at. Notifications use their own recency window.
 * Browser-observed leads have no age ceiling. Returns the number expired.
 */
export async function expireStaleClassifiedLeads(
  sql: Sql,
  args: { agentInstanceId: string; maxAgeHours: number },
): Promise<number> {
  if (args.maxAgeHours <= 0) return 0;
  const rows = await sql<{ id: string }[]>`
    update noelle.leads
    set status = 'skipped',
        payload = payload || ${sql.json({ skipped: "expired-age", max_age_hours: args.maxAgeHours } as JSONValue)}::jsonb,
        updated_at = now()
    where agent_instance_id = ${args.agentInstanceId}
      and status = 'classified'
      and payload->>'reply_requested' is distinct from 'true'
      and payload->>'source' is distinct from 'extension_observed'
      and ${sourceTimestampSql(sql, sql`payload->>'posted_at'`)} < ${xReplyAgeCutoffSql(sql, sql`payload`, args.maxAgeHours)}
    returning id
  `;
  return rows.length;
}

/**
 * After drafting a watched author's newest lead, mark that author's OTHER still-
 * classified priority leads as 'skipped' (superseded) so a stale older post for
 * the same person never gets drafted once a newer one has been. Keeps the
 * one-reply-per-person queue clean. Returns the number superseded.
 */
export async function supersedeOlderPriorityLeads(
  sql: Sql,
  args: { agentInstanceId: string; authorHandle: string; keepLeadId: string },
): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    update noelle.leads
    set status = 'skipped',
        payload = payload || ${sql.json({ superseded: "watchlist-newer-post" } as JSONValue)}::jsonb,
        updated_at = now()
    where agent_instance_id = ${args.agentInstanceId}
      and author_handle = ${args.authorHandle}
      and priority = true
      and status = 'classified'
      and payload->>'reply_requested' is distinct from 'true'
      and id <> ${args.keepLeadId}
    returning id
  `;
  return rows.length;
}

/**
 * Character count of the body field on the most recent reply this instance
 * actually sent (status='sent'). Used by the auto-send delay scaler so a
 * run of long replies spaces itself out further than a run of short ones.
 *
 * Returns 0 when the instance has no prior sent reply — the scaler treats
 * 0 as "min delay, no humanise padding".
 *
 * Reads `coalesce(payload->>'edited_body', payload->>'body')` so a draft
 * the founder edited before approving counts at the edited length, not
 * the original LLM output.
 */
export async function lastSentReplyLength(
  sql: Sql,
  args: { agentInstanceId: string },
): Promise<number> {
  const rows = await sql<Array<{ len: number }>>`
    select coalesce(
             length(coalesce(d.payload->>'edited_body', d.payload->>'body')),
             0
           )::int as len
    from noelle.drafts d
    join noelle.approvals a on a.draft_id = d.id
    where a.agent_instance_id = ${args.agentInstanceId}
      and a.status = 'sent'
    order by a.decided_at desc nulls last
    limit 1
  `;
  return rows[0]?.len ?? 0;
}

/**
 * Backpressure read 1/2 — how many LEADS are still waiting for the founder to
 * review (pick an angle / skip) for this agent instance.
 *
 * Counts DISTINCT LEADS with a pending REPLY approval — NOT raw approval rows.
 * Each lead fans out to ~3 reply angles + 1 DM, so counting rows reads ~4× too
 * high and starves the pipeline (a cap of 50 hits at ~12 leads). The operator
 * reviews one decision per lead, and the inbox + the `countPendingApprovalsForOrg`
 * badge are both per-reply-lead — this gate must match. DM-only leads (reply
 * already actioned) are a hidden manual side-flow and don't count.
 *
 * Called from the top of every worker's `onTick` BEFORE any secret fetch or LLM
 * client construction. When it hits an instance's `pending_drafts_cap`, the tick
 * is skipped and nothing is spent.
 *
 * See: infra/cloudsql/schema/0012_pending_drafts_cap.sql,
 *      apps/x-intern/src/workers/{drafter,classifier,discovery}.ts
 */
export async function countPendingApprovalsForInstance(
  sql: Sql,
  agentInstanceId: string,
): Promise<number> {
  const rows = await sql<{ count: string }[]>`
    select count(distinct a.lead_id)::text as count
    from noelle.approvals a
    left join noelle.drafts d on d.id = a.draft_id
    where a.agent_instance_id = ${agentInstanceId}
      and a.status = 'pending'
