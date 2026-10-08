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
