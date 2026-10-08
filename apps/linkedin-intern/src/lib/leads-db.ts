import type { JSONValue, Sql } from "postgres";
import type { VipSignal } from "@noelle/contracts";
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

/** A browser card can be scored without a URL, but cannot be drafted or sent. */
export function hasCanonicalObservedIdentity(
  lead: Pick<LeadRow, "external_id">,
  payload: Record<string, unknown>,
): boolean {
  const id = lead.external_id;
  if (!/^\d{10,}$/.test(id)) return false;
  if (payload.urn != null && payload.urn !== `urn:li:activity:${id}`) return false;
  if (typeof payload.url !== "string") return false;
  try {
    const url = new URL(payload.url);
    if (url.protocol !== "https:" || url.hostname !== "www.linkedin.com") return false;
    const activityPath = `/feed/update/urn:li:activity:${id}`;
    return (url.pathname === activityPath || url.pathname.startsWith(`${activityPath}/`)) ||
      new RegExp(`^/posts/[^/]+-activity-${id}(?:-|/|$)`).test(url.pathname);
  } catch {
    return false;
  }
}

/**
 * Upsert a discovered LinkedIn post as a NEW, UNCLASSIFIED lead.
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
 * Atomic "fetch + claim" for the classifier: flip the oldest N status='new' leads
 * for this instance to 'classifying' under FOR UPDATE SKIP LOCKED so concurrent
 * classifiers don't grab the same row, returning the claimed rows. Mirrors
 * x-intern's leads-db.claimLeadsForClassification.
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
      order by created_at asc
      for update skip locked
      limit ${args.batch}
    )
    returning id, external_id, payload, author_handle, author_id, tier, classifier_label, classifier_score, status, priority
  `;
  return [...rows];
}

/** Browser observations are staged outside the legacy fail-open claim lane. */
export async function claimObservedLeadsForClassification(
  sql: Sql,
  args: { agentInstanceId: string; batch: number },
): Promise<LeadRow[]> {
  const rows = await sql<LeadRow[]>`
    update noelle.leads
    set status = 'observed_classifying', updated_at = now()
    where id in (
      select id from noelle.leads
      where agent_instance_id = ${args.agentInstanceId}
        and status = 'observed'
        and payload->>'source' = 'extension_observed'
      order by created_at asc
      for update skip locked
      limit ${args.batch}
    )
    returning id, external_id, payload, author_handle, author_id, tier,
              classifier_label, classifier_score, status, priority
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
    /**
     * Relationship-scout verdict to persist on noelle.leads.vip_signal. null
     * (scout off / fail-open / model omitted it) writes NULL — the approvals
     * banner only renders for a non-null `vip: true` row, so this is fail-open.
     */
    vipSignal?: VipSignal | null;
    /** A Jev-qualified browser card waits here until the actor resolves its post URL. */
    identityPending?: boolean;
