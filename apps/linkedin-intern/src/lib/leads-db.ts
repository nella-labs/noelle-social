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
  },
): Promise<void> {
  const status = args.replyKind === "skip" ? "skipped" : args.identityPending ? "identity_pending" : "classified";
  await sql`
    update noelle.leads
    set status = ${status},
        classifier_label = ${args.replyKind},
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
  args: { agentInstanceId: string; batch: number },
): Promise<LeadRow[]> {
  // RPC defined in infra/cloudsql/schema/0018_x_watchlist_people.sql — claims the
  // oldest N status='classified' leads with priority=FALSE (the keyword/funnel
  // lane). The two-lane drafting split (0035) routes priority=TRUE leads to
  // claimWatchlistLeadsForDrafting below instead.
  const rows = await sql<LeadRow[]>`
    select * from noelle.claim_leads_for_drafting(${args.agentInstanceId}::uuid, ${args.batch})
  `;
  return [...rows];
}

/**
 * Claim NOTIFICATION leads only — people who replied to us.
 *
 * Deliberately not one of the two claims above. Those are lane-blind: the
 * keyword claim takes priority=FALSE and the watchlist claim takes
 * priority=TRUE, and a notification lead is priority=TRUE — so running the
 * watchlist claim on a notifications-only tick would drag in every
 * profile_search and keyword lead too. On LinkedIn essentially EVERY lead is
 * priority=TRUE, so that is the entire cold funnel. `payload.source` is the only
 * thing that actually identifies this lane.
 *
 * RPC: infra/cloudsql/schema/0095_notifications_lane.sql. It applies the same
 * freshness bound as every other notification path
 * (packages/runtime/src/notificationWindow.ts).
 */
export async function claimNotificationLeadsForDrafting(
  sql: Sql,
  args: { agentInstanceId: string; cap: number },
): Promise<LeadRow[]> {
  const rows = await sql<LeadRow[]>`
    select * from noelle.claim_notification_leads_for_drafting(${args.agentInstanceId}::uuid, ${args.cap})
  `;
  return [...rows];
}

/**
 * Claim priority=TRUE classified leads — profile-first (Feeder A), ICP-vetted
 * keyword authors, and any future watchlist-pinned people. Per the 0035 split,
 * the keyword claim above excludes priority leads, so WITHOUT this they'd sit at
 * 'classified' forever. Keep extension-observed rows out of this claim: they
 * must pass through claimObservedLeadsForDrafting's Jev and per-author lane.
 * Mirrors the existing RPC's default no-age-cutoff behavior and pending-reply
 * guard, while excluding one-off reply requests as that RPC does.
 */
export async function claimWatchlistLeadsForDrafting(
  sql: Sql,
  args: { agentInstanceId: string; cap: number },
): Promise<LeadRow[]> {
  const rows = await sql<LeadRow[]>`
    update noelle.leads l
    set status = 'drafting', updated_at = now()
    where l.status = 'classified' and l.id in (
      select picked.id from (
        select distinct on (cand.author_handle) cand.id
        from noelle.leads cand
        where cand.agent_instance_id = ${args.agentInstanceId}::uuid
          and cand.status = 'classified'
          and cand.priority = true
          and cand.payload->>'source' is distinct from 'extension_observed'
          and coalesce(cand.payload->>'reply_requested', 'false') <> 'true'
          and not exists (
            select 1 from noelle.approvals a
            join noelle.leads la on la.id = a.lead_id
            left join noelle.drafts d on d.id = a.draft_id
            where la.agent_instance_id = ${args.agentInstanceId}::uuid
              and la.author_handle = cand.author_handle
              and a.status = 'pending'
              and coalesce(d.payload->>'kind', 'reply') <> 'dm'
          )
        order by cand.author_handle,
                 (cand.payload->>'posted_at') desc nulls last,
                 cand.created_at desc
      ) picked
      limit ${args.cap}
    )
    returning l.id, l.external_id, l.payload, l.author_handle, l.author_id,
              l.tier, l.classifier_label, l.classifier_score, l.status, l.priority
  `;
  return [...rows];
}

/** Take freshly qualified browser leads ahead of the normal watchlist queue. */
export async function claimObservedLeadsForDrafting(
  sql: Sql,
  args: { agentInstanceId: string; cap: number },
): Promise<LeadRow[]> {
  // Match the actuator's unattended gate: a failed review stays available for
  // human editing, but it cannot consume one of the five automatic reply slots.
  const configuredVoiceFloor = Number(process.env.LINKEDIN_AUTOSEND_VOICE_FLOOR ?? 0.7);
  const voiceFloor = Number.isFinite(configuredVoiceFloor)
    ? Math.min(1, Math.max(0, configuredVoiceFloor)) : 0.7;
  const rows = await sql<LeadRow[]>`
    update noelle.leads l
    set status = 'drafting', updated_at = now()
    where l.status = 'classified' and l.id in (
      select picked.id from (
        select distinct on (cand.author_handle) cand.id
        from noelle.leads cand
        where cand.agent_instance_id = ${args.agentInstanceId}
          and cand.status = 'classified'
          and cand.payload->>'source' = 'extension_observed'
          and cand.payload->'classifier'->>'provider' = 'jev'
          and cand.external_id ~ '^[0-9]+$'
          and cand.payload->>'url' like 'https://www.linkedin.com/%'
          and (cand.payload->>'urn' is null
            or cand.payload->>'urn' = 'urn:li:activity:' || cand.external_id)
          and ((cand.payload->>'url' like '%/feed/update/urn:li:activity:' || cand.external_id || '/%')
            or (cand.payload->>'url' like '%-activity-' || cand.external_id || '-%'))
          and not exists (
            select 1 from noelle.approvals a
            join noelle.leads la on la.id = a.lead_id
            join noelle.drafts d on d.id = a.draft_id
            where la.agent_instance_id = ${args.agentInstanceId}
              and la.author_handle = cand.author_handle
              and a.status = 'pending'
              and coalesce(d.payload->>'kind', 'reply') = 'reply'
              and d.payload->'verifier_meta'->>'pass' = 'true'
              and d.payload->'verifier_meta'->>'judgeOk' = 'true'
              and (d.payload->>'human_review_required' is distinct from 'true'
                   or d.payload->>'human_send_approved' = 'true')
              and case when jsonb_typeof(d.payload->'verifier_meta'->'scores'->'voice') = 'number'
                then (d.payload->'verifier_meta'->'scores'->>'voice')::numeric >= ${voiceFloor}
                else false end
          )
        order by cand.author_handle,
                 (cand.payload->>'posted_at') desc nulls last,
                 cand.created_at desc
      ) picked
      limit greatest(0, least(${args.cap}, 5 - (
        select count(distinct occupied.id)::int
        from noelle.leads occupied
        where occupied.agent_instance_id = ${args.agentInstanceId}
          and occupied.platform = 'linkedin'
          and occupied.payload->>'source' = 'extension_observed'
          and (occupied.status = 'drafting' or exists (
            select 1 from noelle.approvals approval
            join noelle.drafts draft on draft.id = approval.draft_id
            where approval.lead_id = occupied.id
              and approval.status = 'pending'
              and coalesce(draft.payload->>'kind', 'reply') = 'reply'
              and draft.payload->'verifier_meta'->>'pass' = 'true'
              and draft.payload->'verifier_meta'->>'judgeOk' = 'true'
              and (draft.payload->>'human_review_required' is distinct from 'true'
                   or draft.payload->>'human_send_approved' = 'true')
              and case when jsonb_typeof(draft.payload->'verifier_meta'->'scores'->'voice') = 'number'
                then (draft.payload->'verifier_meta'->'scores'->>'voice')::numeric >= ${voiceFloor}
                else false end
          ))
      )))
    )
    returning l.id, l.external_id, l.payload, l.author_handle, l.author_id,
              l.tier, l.classifier_label, l.classifier_score, l.status, l.priority
  `;
  return [...rows];
}

/**
 * How many posts discovery has EXTRACTED today for this instance — every lead
 * created today, regardless of how the classifier later graded it. Discovery
 * stops fetching once this reaches LINKEDIN_DAILY_EXTRACT_CAP. `current_date`
 * uses the DB session timezone — America/Bogota on the native Mac runtime, NOT
 * UTC (that was the retired Lima VM) — which is the same clock the created_at
 * default writes with, so the day boundary is consistent. It does mean every
 * "today" counter here rolls at local midnight.
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
 * Backpressure read 1/2 — how many reply drafts are still waiting for the
 * operator or actuator for this agent instance. DMs have their own review lane
 * and must not stop reply discovery, classification, or drafting.
 */
export async function countPendingApprovalsForInstance(
  sql: Sql,
  agentInstanceId: string,
): Promise<number> {
  const rows = await sql<{ count: string }[]>`
    select count(*)::text as count
    from noelle.approvals a
    join noelle.drafts d on d.id = a.draft_id
    where a.agent_instance_id = ${agentInstanceId}
      and a.status = 'pending'
      and coalesce(d.payload->>'kind', 'reply') <> 'dm'
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

/**
 * One-off reply requests — claim leads the operator explicitly asked to draft
 * through MCP (payload.reply_requested = true). This is independent of reply
 * lane state: the worker drains it even while paused/replies are off. The claim
 * keeps the request marker until completion so crash recovery and the drafter
 * can inject guidance and tag the outbound request key. A matching completed
 * draft blocks duplicate generation for the same key.
 */
export async function claimReplyRequestLeads(
  sql: Sql,
  args: { agentInstanceId: string; cap: number },
): Promise<LeadRow[]> {
  const rows = await sql<LeadRow[]>`
    update noelle.leads l
    set status = 'drafting', updated_at = now()
    where l.id in (
      select c.id
      from noelle.leads c
      where c.agent_instance_id = ${args.agentInstanceId}
        and c.status = 'classified'
        and c.payload->>'reply_requested' = 'true'
        and c.payload->'reply_request'->>'request_key' is not null
        and not exists (
          select 1 from noelle.approvals a
          left join noelle.drafts d on d.id = a.draft_id
          where a.lead_id = c.id
            and coalesce(d.payload->>'kind', 'reply') <> 'dm'
            and d.payload->>'reply_request_key' = c.payload->'reply_request'->>'request_key'
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

export async function markLeadStatus(
  sql: Sql,
  args: {
    leadId: string;
    status: "drafted" | "errored" | "skipped" | "observed";
    meta?: Record<string, unknown>;
  },
): Promise<void> {
  await sql`
    update noelle.leads
    set status = ${args.status},
        payload = payload || ${sql.json((args.meta ?? {}) as JSONValue)}::jsonb
          || case when payload ? 'reply_request' then '{"reply_requested":false}'::jsonb else '{}'::jsonb end,
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

type DraftingRecovery = { requeued: number; reconciled: number; approvalsRepaired: number };

/**
 * The outbound API saves drafts and approvals in separate statements, then the
 * writer marks the lead drafted. A crash in either gap can leave a saved reply
 * occupying a drafting slot. Repair only missing approvals for reply drafts,
 * then reconcile those leads; both steps are safe to repeat after another crash.
 * A DM draft does not finish the public reply claim.
 */
async function reconcileSavedReplyDrafts(
  sql: Sql,
  agentInstanceId: string,
  before: Date | null,
): Promise<{ reconciled: number; approvalsRepaired: number }> {
  const cutoff = before?.toISOString() ?? null;
  const approvals = await sql<{ id: string }[]>`
    insert into noelle.approvals (org_id, agent_instance_id, draft_id, lead_id, status)
    select l.org_id, l.agent_instance_id, d.id, l.id, 'pending'
    from noelle.leads l
    join noelle.drafts d on d.lead_id = l.id and d.org_id = l.org_id
    where l.agent_instance_id = ${agentInstanceId}
      and l.status = 'drafting'
      and l.updated_at < coalesce(${cutoff}::timestamptz, now() - make_interval(mins => ${STALE_CLAIM_MINUTES}))
      and coalesce(d.payload->>'kind', 'reply') = 'reply'
      and not exists (select 1 from noelle.approvals a where a.draft_id = d.id)
    on conflict (draft_id) do nothing
    returning id
  `;
  const leads = await sql<{ id: string }[]>`
    update noelle.leads l
    set status = 'drafted',
