import type { JSONValue, Sql } from "postgres";
import type { ReplyKindValue } from "./classifier-engine.js";

export interface LeadRow {
  id: string;
  external_id: string;
  payload: Record<string, unknown>;
  author_handle: string;
  author_id: string | null;
  tier: "T1" | "T2" | "T3" | null;
  classifier_label: string | null;
  classifier_score: number | null;
  status: string;
  /**
   * Always-reply marker. Lyra's quality pipeline classifies every post, so this
   * is `false` for all discovered leads — kept on the row only because the shared
   * claim_leads_for_drafting RPC returns it and the drafter reads it (a future
   * watchlist-pin feature could flip it).
   */
  priority: boolean;
  /**
   * Engagement-bait flag set by the classifier (0031_leads_comment_bait.sql).
   * The drafter ignores the post's comment count for Opus tiering when true, so
   * a comment-farming giveaway never earns Opus on inflated comment volume alone.
   * Returned by claim_leads_for_drafting; default false. Optional on the type so
   * older fixtures/rows (and the classifier's claim, which omits it) still parse.
   */
  comment_bait?: boolean;
}

/**
 * Upsert a discovered Reddit post as a NEW, UNCLASSIFIED lead.
 *
 * The quality pipeline replaced the old "reply to everything" bypass: discovery
 * inserts status='new' / priority=false so the classifier scores every post and
 * decides reply_kind (substantial | light | skip). The drafter only ever sees a
 * lead the classifier promoted to status='classified'.
 *
 * Idempotent on a re-seen activity id within the same org and platform: a
 * conflict is a no-op (we never reopen an already-processed lead), and the
 * existing row's id is returned with inserted=false.
 *
 * `priority` marks a vetted person's lead (profile-first discovery): the
 * classifier never hard-skips a priority lead — a 'skip' verdict is clamped to
 * 'light'. Watchlist + keyword leads default to false (every post is classified
 * normally).
 */
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
    priority?: boolean;
  },
): Promise<{ id: string; inserted: boolean }> {
  // The post's own posted-at lives inside payload.posted_at — noelle.leads has no
  // dedicated posted_at column. The dashboard pulls payload.posted_at for "posted
  // Nh ago" labels.
  const payloadWithStamp = { ...args.payload, posted_at: args.postedAt };
  const rows = await sql<{ id: string; inserted: boolean }[]>`
    with ins as (
      insert into noelle.leads
        (org_id, agent_instance_id, external_id, platform, author_handle, author_id,
         payload, status, priority)
      values
        (${args.orgId}, ${args.agentInstanceId}, ${args.externalId}, ${args.platform},
         ${args.authorHandle}, ${args.authorId}, ${sql.json(payloadWithStamp as JSONValue)},
         'new', ${args.priority ?? false})
      -- A re-seen post is a no-op: never reopen an already-classified/drafted
      -- lead, never touch status/payload. (No priority to upgrade in the quality
      -- pipeline.)
      on conflict (org_id, platform, external_id) do nothing
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

/**
 * Atomic "fetch + claim" for the classifier: flip the FRESHEST N status='new'
 * leads for this instance to 'classifying' under FOR UPDATE SKIP LOCKED so
 * concurrent classifiers don't grab the same row, returning the claimed rows.
 *
 * Ordered newest-POST-first (`payload.posted_at` desc), not oldest-discovered:
 * on Reddit a reply's value decays in hours (early comments ride the thread's
 * upvote curve — the "rich get richer" ranking loop), so after any backlog or
 * stall Orion must score the freshest threads first rather than draining a
 * stale FIFO. `created_at desc` is the tie-breaker (and the sole order for the
 * rare legacy lead with no `posted_at`, sorted last via NULLS LAST).
 *
 * Ordered on the raw `posted_at` TEXT, not `::timestamptz`: discovery stamps a
 * fixed-width UTC `toISOString()` (or nothing), so lexical order == chronological,
 * and a malformed/empty value can never throw and stall the claim — a poison-pill
 * a cast would allow. Matches the cast-free ordering in the 0035 watchlist RPC.
 */
export async function claimLeadsForClassification(
  sql: Sql,
  args: { orgId: string; agentInstanceId: string; batch: number },
): Promise<LeadRow[]> {
  const rows = await sql<LeadRow[]>`
    update noelle.leads
    set status = 'classifying', updated_at = now()
    where id in (
      select id from noelle.leads
      where org_id = ${args.orgId}
        and agent_instance_id = ${args.agentInstanceId}
        and status = 'new'
      order by (payload->>'posted_at') desc nulls last, created_at desc
      for update skip locked
      limit ${args.batch}
    )
    returning id, external_id, payload, author_handle, author_id, tier, classifier_label, classifier_score, status, priority
  `;
  return [...rows];
}

/**
 * Write the classifier verdict onto a lead and advance its status.
 *
 *   - reply_kind 'substantial' | 'light' → status 'classified' (the drafter
 *     claims these; the label tells it which drafting branch to run).
 *   - reply_kind 'skip' → status 'skipped' (terminal; the drafter never sees it).
 *
 * `classifier_label` carries the reply_kind so the drafter can branch on it.
 * `classifier_score` is the 0-1 normalised `q` (or null on a fail-open) — the
 * shared approval UI multiplies it by 100 for display, same contract as the X
 * intern. `tier` is the band for a substantial lead (null for light/skip).
 */
export async function markLeadClassified(
  sql: Sql,
  args: {
    leadId: string;
    /** The reply_kind — also the classifier_label written to the row. */
    replyKind: ReplyKindValue;
    /** 0-1 normalised reply-worthiness score (q/100), or null when unscored. */
    score: number | null;
    tier: "T1" | "T2" | "T3" | null;
    /**
     * Whether the post is engagement-bait (comment-farming CTA). Persisted to
     * noelle.leads.comment_bait so the drafter can ignore an inflated comment
     * count when picking Opus. Defaults false.
     */
    commentBait?: boolean;
    classifierMeta: Record<string, unknown>;
  },
): Promise<void> {
  const status = args.replyKind === "skip" ? "skipped" : "classified";
  await sql`
    update noelle.leads
    set status = ${status},
        classifier_label = ${args.replyKind},
        classifier_score = ${args.score},
        tier = ${args.tier},
        comment_bait = ${args.commentBait ?? false},
        payload = payload || ${sql.json({ classifier: args.classifierMeta } as JSONValue)}::jsonb,
        updated_at = now()
    where id = ${args.leadId}
  `;
}

export async function claimLeadsForDrafting(
  sql: Sql,
  args: { agentInstanceId: string; batch: number },
): Promise<LeadRow[]> {
  // Claim the FRESHEST N status='classified', priority=FALSE leads (all Reddit
  // leads are priority=false — the subreddit-watchlist lane).
  //
  // Inlined (was the shared noelle.claim_leads_for_drafting RPC, ordered
  // `created_at asc`) so Orion can order newest-POST-first WITHOUT changing the
  // ordering the X and LinkedIn interns share through that RPC. The daily draft
  // budget (REDDIT_DAILY_SUBSTANTIAL_CAP / _LIGHT_CAP) is scarce, so it must be
  // spent on the threads whose Reddit visibility window is still open, not on
  // the stalest classified leads first (a reply drafted long after the post
  // reads as necro-engagement and rides no upvote curve). Returns the same 10
  // columns as the RPC (comment_bait intentionally not selected — the RPC omits
  // it too and the reddit drafter never reads it). Ordered on the raw posted_at
  // TEXT (not ::timestamptz) — UTC toISOString stamps sort lexically ==
  // chronologically, and a malformed/empty value can't throw and stall the
  // claim (matches the 0035 watchlist RPC). `created_at desc` tie-breaks; a
  // legacy lead with no posted_at sorts last (NULLS LAST).
  const rows = await sql<LeadRow[]>`
    update noelle.leads
    set status = 'drafting', updated_at = now()
    where id in (
      select id from noelle.leads
      where agent_instance_id = ${args.agentInstanceId}
        and status = 'classified'
        and priority = false
      order by (payload->>'posted_at') desc nulls last, created_at desc
      for update skip locked
      limit ${args.batch}
    )
    returning id, external_id, payload, author_handle, author_id, tier, classifier_label, classifier_score, status, priority
  `;
  return [...rows];
}

/**
 * Claim priority=TRUE classified leads — profile-first (Feeder A), ICP-vetted
 * keyword authors, and any future watchlist-pinned people. Per the 0035 split,
 * the keyword claim above excludes priority leads, so WITHOUT this they'd sit at
 * 'classified' forever. The RPC takes one newest lead per author (skipping
 * authors who already have a pending non-DM reply), up to `cap` authors.
 * RPC: infra/cloudsql/schema/0035_watchlist_drafting_rpc.sql.
 */
export async function claimWatchlistLeadsForDrafting(
  sql: Sql,
  args: { agentInstanceId: string; cap: number },
): Promise<LeadRow[]> {
  const rows = await sql<LeadRow[]>`
    select * from noelle.claim_watchlist_leads_for_drafting(${args.agentInstanceId}::uuid, ${args.cap})
  `;
  return [...rows];
}

/**
 * How many posts discovery has EXTRACTED today for this instance — every lead
 * created today, regardless of how the classifier later graded it. Discovery
 * stops fetching once this reaches LINKEDIN_DAILY_EXTRACT_CAP. `current_date`
 * uses the DB session timezone (UTC on the VM), which is the same clock the
 * created_at default writes with, so the day boundary is consistent.
 */
export async function countExtractedToday(
  sql: Sql,
  agentInstanceId: string,
): Promise<number> {
  const rows = await sql<{ count: string }[]>`
    select count(*)::text as count
    from noelle.leads
    where agent_instance_id = ${agentInstanceId}
      and created_at::date = current_date
  `;
  return Number(rows[0]?.count ?? 0);
}

/**
 * How many leads of a given reply_kind the drafter has DELIVERED today for this
 * instance — counted by joining approvals back to their lead and matching the
 * lead's classifier_label, with the approval created today. Used to enforce the
 * per-kind daily draft caps (LINKEDIN_DAILY_SUBSTANTIAL_CAP /
 * LINKEDIN_DAILY_LIGHT_CAP). `light` and `substantial` are independent buckets.
 *
 * Counts via noelle.approvals (which has created_at; noelle.drafts only has
 * synced_at) and DISTINCT lead_id — a substantial lead yields up to 3 reply
 * approvals + 1 DM approval; the cap is "N posts/day", i.e. N leads, not N rows.
 */
export async function countDraftedTodayByKind(
  sql: Sql,
  args: { agentInstanceId: string; replyKind: ReplyKindValue },
): Promise<number> {
  const rows = await sql<{ count: string }[]>`
    select count(distinct a.lead_id)::text as count
    from noelle.approvals a
    join noelle.leads l on l.id = a.lead_id
    where a.agent_instance_id = ${args.agentInstanceId}
      and l.classifier_label = ${args.replyKind}
      and a.created_at::date = current_date
  `;
  return Number(rows[0]?.count ?? 0);
}

/**
 * Backpressure read 1/2 — how many drafts are still waiting for the operator to
 * approve/skip for this agent instance. Consulted at the top of discovery +
 * drafter ticks before any cookie fetch or LLM call.
 */
export async function countPendingApprovalsForInstance(
  sql: Sql,
  agentInstanceId: string,
): Promise<number> {
  const rows = await sql<{ count: string }[]>`
    select count(*)::text as count
    from noelle.approvals
    where agent_instance_id = ${agentInstanceId}
      and status = 'pending'
  `;
  return Number(rows[0]?.count ?? 0);
}

/**
 * Backpressure read 2/2 — how many leads are "in flight" (not yet resolved into
 * a draft or skipped). Only discovery consults this, to avoid piling fresh leads
 * on top of a backlog the classifier/drafter haven't drained yet.
 */
export async function countLeadBacklogForInstance(
  sql: Sql,
  agentInstanceId: string,
): Promise<number> {
  const rows = await sql<{ count: string }[]>`
    select count(*)::text as count
    from noelle.leads
    where agent_instance_id = ${agentInstanceId}
      and status in ('new', 'classifying', 'classified', 'drafting')
  `;
  return Number(rows[0]?.count ?? 0);
}

export async function markLeadStatus(
  sql: Sql,
  args: { leadId: string; status: "drafted" | "errored" | "skipped"; meta?: Record<string, unknown> },
): Promise<void> {
  await sql`
    update noelle.leads
    set status = ${args.status},
        payload = payload || ${sql.json((args.meta ?? {}) as JSONValue)}::jsonb,
        updated_at = now()
    where id = ${args.leadId}
  `;
}

/**
 * On-demand DM requests — claim leads the operator flagged for a one-off DM
 * (payload.dm_requested = true, set by the dashboard "Generate DM" action).
 * Atomically clears the flag as it claims (so each request generates once) and
 * skips leads that already have a pending DM approval. Independent of the reply
 * lane + the auto-DM toggle: runs whenever the drafter ticks, so the operator
 * gets their DM regardless of pipeline state. Mirrors x-intern.
 */
export async function claimDmRequestLeads(
  sql: Sql,
  args: { agentInstanceId: string; cap: number },
): Promise<LeadRow[]> {
  const rows = await sql<LeadRow[]>`
    update noelle.leads l
    set payload = payload - 'dm_requested', updated_at = now()
    where l.id in (
      select c.id
      from noelle.leads c
      where c.agent_instance_id = ${args.agentInstanceId}
        and c.payload->>'dm_requested' = 'true'
        and not exists (
          select 1 from noelle.approvals a
          left join noelle.drafts d on d.id = a.draft_id
          where a.lead_id = c.id
            and a.status = 'pending'
            and coalesce(d.payload->>'kind', 'reply') = 'dm'
        )
      order by c.updated_at desc
      limit ${args.cap}
      for update skip locked
    )
    returning l.id, l.external_id, l.payload, l.author_handle, l.author_id,
              l.tier, l.classifier_label, l.classifier_score, l.status, l.priority
  `;
  return [...rows];
}

/**
 * A claim older than this is provably orphaned. Each worker kind runs as a
 * single process per instance and drafts/classifies its whole batch well inside
 * 45 minutes (the SKIP LOCKED in the claim RPCs is a concurrency safety net,
 * not the topology), so a lead still mid-claim after this long has no living
 * owner.
 */
const STALE_CLAIM_MINUTES = 45;

/**
 * Strands older than this exit as 'skipped' instead of retrying — a reply
 * drafted two days after the post reads as necro-engagement, not conversation.
 */
const STALE_CLAIM_EXPIRE_HOURS = 48;

/**
 * Recover leads stranded mid-claim by a worker crash or restart. The claim RPCs
 * flip status ('new'→'classifying', 'classified'→'drafting') and the worker
 * later writes the terminal outcome — but a process death between the two
 * leaves the lead invisible to every future claim (claims only pick the
 * pre-claim status), so it is lost silently. Merge-driven deploys restart every
 * worker, making this a steady leak (2026-07-19: 159 leads stranded at
 * 'drafting'/'classifying' across the three interns).
 *
 * Fresh strands go back to `requeueStatus` for a retry; ones past the expiry
 * horizon are marked 'skipped' with a payload.stale_claim marker so the
 * dashboard can tell them apart from classifier skips. Runs at the top of every
 * worker tick; the usual match is zero rows.
 */
export async function reapStaleClaims(
  sql: Sql,
  args: {
    agentInstanceId: string;
    /** The mid-claim status this worker owns. */
    claimedStatus: "classifying" | "drafting";
    /** The pre-claim status a fresh strand is returned to. */
    requeueStatus: "new" | "classified";
  },
