import { cache } from "react";
import { readApifySpendData } from "./apify-spend-db";
import { apifyTokenSpend, summarizeApifyProviderSpend, type ApifyTokenSpend } from "./apify-spend-model";
export type { ApifyTokenSpend } from "./apify-spend-model";
import { assertOrgMember, type ChatHistoryTurn } from "@noelle/runtime";
import type {
  WatchlistObjectiveKind,
  DiscoveryConfig,
  TargetingProposal,
  VaultEditProposal,
  PatternRulesPageInput,
  PatternAlertsPageInput,
  PatternRulesPage,
} from "@noelle/contracts";
import { SOCIAL_AGENT_ROLES, BusEventsQuerySchema, DiscoveryConfigSchema, parseVipSignal, parseRunSchedule, type VipSignal } from "@noelle/contracts";
import { XWhoamiOutSchema, type XWhoamiOut } from "@/lib/contracts";
import { noelleFetch } from "@/lib/api";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { pgOrgMembersClient, sql, readSql } from "@/lib/db";
import {
  loadVisibleAlerts,
  listPatternRules as readPatternRules,
  countPatternRules as readPatternCounts,
  validPatternScope,
  type PatternScope,
  type PatternAlertRow as StoredPatternAlertRow,
  type StoredPatternAlertsPage,
} from "@noelle/runtime/pattern-breaker-db";
import { getUserFromCookies } from "@/lib/auth-cookie";
import { cleanModelLabel, scrubBackendTokens } from "@/lib/model-label";
import { isAllSkipDraft } from "@/lib/is-skip-draft";
import { bodyForSelectedAngle, draftPayload, leadPayload, linkedinLeadPayload, redditLeadFields, sentReplyUrl } from "@/lib/payload-shapes";
import { parseStoredVaultEdit, publicVaultEditReceipt, type StoredVaultEdit, type VaultEditClientReceipt } from "@/lib/agent-chat/proposal";
import type {
  NoelleAgentInstance,
  NoelleApproval,
  NoelleDraft,
  NoelleLead,
  NoelleOrganization,
  NoelleOrgSpendMonth,
  NoelleSyncRun,
  SocialPlatform,
} from "@/lib/db-types";

/**
 * Read helpers for `noelle.*` tables.
 *
 * Phase 4 of tasks/supabase-to-gcp-migration.md: data lives in Cloud SQL
 * (Postgres 16), not in Supabase anymore. Every helper below queries via
 * the postgres.js `sql` template tagged client in `@/lib/db`. Auth still
 * flows through Supabase — `getCurrentUser()` keeps the Supabase
 * cookie-bound client because that's where sessions live.
 *
 * Tenancy: there's no RLS in Cloud SQL. Each helper that returns org-
 * scoped data calls `assertOrgMember()` (via the `pgOrgMembersClient()`
 * adapter) BEFORE the data query. Defense in depth: every read is gated
 * in TS.
 *
 * Naming: `getXForY` returns one row; `listXForY` returns many.
 */

/**
 * Resolve the currently signed-in Supabase auth user. Throws if there's no
 * session — every callsite that hits `assertOrgMember` needs a real user id.
 */
/**
 * Both helpers below use the verified identity owner in @/lib/auth-cookie.
 * It verifies an explicit JWT without entering SSR session-refresh locks.
 * The `sb` parameter is kept on internal helpers only for callers that still
 * pass it (it's unused for the auth path now).
 */
const requiredUserId = cache(async (): Promise<string> => {
  const user = await getUserFromCookies();
  if (!user) throw new Error("not signed in");
  return user.id;
});

async function getRequiredUserId(
  _sb?: Awaited<ReturnType<typeof createSupabaseServerClient>>,
): Promise<string> {
  // `_sb` is a legacy param (ignored — see note above). The cached inner keys
  // on no args; the identity owner also deduplicates verification per request jar.
  return requiredUserId();
}

/**
 * Per-request memoized membership guard. React `cache()` dedupes by
 * (orgId, userId) within one request render / server action, so the many
 * org-scoped read helpers that each guard with `assertOrgMember` share ONE
 * `org_members` round-trip instead of one apiece. Tenancy is unchanged: the
 * first call still asserts (and throws `OrgMembershipError` for a non-member);
 * later calls reuse that same settled promise.
 */
const assertMember = cache((orgId: string, userId: string) =>
  assertOrgMember(pgOrgMembersClient(), userId, orgId),
);

export async function getCurrentUser() {
  return getUserFromCookies();
}

export async function listOrgsForCurrentUser(): Promise<NoelleOrganization[]> {
  const sb = await createSupabaseServerClient();
  const userId = await getRequiredUserId(sb);
  // The inner join through `org_members` is itself the membership guard —
  // we only return orgs the user actually belongs to.
  const rows = await readSql<NoelleOrganization[]>`
    select o.*
    from noelle.organizations o
    join noelle.org_members m on m.org_id = o.id
    where m.user_id = ${userId}
    order by o.created_at asc
  `;
  return rows;
}

/**
 * Which X account the org's stored cookies post as (via api-vm /api/x/whoami).
 * Best-effort + per-request cached: returns `{ connected: false }` on any
 * error so callers can render "not connected" instead of throwing.
 */
export const getXAccount = cache(async (orgId: string): Promise<XWhoamiOut> => {
  try {
    const res = await noelleFetch<unknown>(
      `/api/x/whoami?org_id=${encodeURIComponent(orgId)}`,
    );
    return XWhoamiOutSchema.parse(res);
  } catch {
    return { connected: false };
  }
});

export const getOrgBySlug = cache(async (slug: string): Promise<NoelleOrganization | null> => {
  const userId = await getRequiredUserId();
  const rows = await readSql<NoelleOrganization[]>`
    select * from noelle.organizations where slug = ${slug} limit 1
  `;
  const org = rows[0];
  if (!org) return null;
  // No RLS in Cloud SQL — verify membership before returning a row that a
  // signed-in non-member could otherwise read by guessing the slug.
  await assertMember(org.id, userId);
  return org;
});

export const listAgentInstancesForOrg = cache(async (
  orgId: string,
): Promise<NoelleAgentInstance[]> => {
  const userId = await getRequiredUserId();
  await assertMember(orgId, userId);
  const rows = await readSql<NoelleAgentInstance[]>`
    select * from noelle.agent_instances
    where org_id = ${orgId}
      and status <> 'retired'
      and role = any(${[...SOCIAL_AGENT_ROLES]})
    order by role asc
  `;
  return rows;
});

export const getAgentInstance = cache(async (
  instanceId: string,
): Promise<NoelleAgentInstance | null> => {
  const userId = await getRequiredUserId();
  const rows = await readSql<NoelleAgentInstance[]>`
    select * from noelle.agent_instances where id = ${instanceId}
      and status <> 'retired'
      and role = any(${[...SOCIAL_AGENT_ROLES]})
    limit 1
  `;
  const inst = rows[0];
  if (!inst) return null;
  // Fetch first, then guard on the row's org_id. Returning null for
  // non-members would leak existence; throwing matches the original
  // "RLS would have refused" semantics callers already handle.
  await assertMember(inst.org_id, userId);
  return inst;
});

export interface InstanceTargeting {
  handles: string[];
  keywords: string[];
}

/**
 * What an agent instance is actively hunting for — its x_watchlist handles +
 * keywords. Drives the "Actively hunting for" summary on the Objective card and
 * the targeting page. Tenancy piggybacks on getAgentInstance (assertOrgMember).
 */
export async function getWatchlistForInstance(
  instanceId: string,
): Promise<InstanceTargeting> {
  const inst = await getAgentInstance(instanceId);
  if (!inst) return { handles: [], keywords: [] };
  const rows = await readSql<{ kind: "handle" | "keyword"; value: string }[]>`
    select kind, value
    from noelle.x_watchlist
    where agent_instance_id = ${inst.id} and org_id = ${inst.org_id}
    order by created_at asc
  `;
  return {
    handles: rows.filter((r) => r.kind === "handle").map((r) => r.value),
    keywords: rows.filter((r) => r.kind === "keyword").map((r) => r.value),
  };
}

export interface WatchlistPersonRow {
  id: string;
  handle: string;
  added_at: string;
  objective_kind: WatchlistObjectiveKind | null;
  objective_note: string | null;
  /**
   * The Contacts person this watchlist row maps to (the CRM is the single
   * person surface). Backfilled by `ensurePersonForHandle` on every add, so it
   * is non-null in practice; nullable only for legacy rows that predate the
   * link. Lets the watchlist card deep-link straight into `/contacts/[id]`.
   */
  person_id: string | null;
}

/**
 * People the X intern must always reply to — its x_watchlist_people. Distinct
 * from getWatchlistForInstance (targeting handles/keywords): every new post
 * from one of these gets a drafted reply, bypassing the classifier + drafter
 * filters. Tenancy piggybacks on getAgentInstance (assertOrgMember).
 */
export async function getWatchlistPeopleForInstance(
  instanceId: string,
): Promise<WatchlistPersonRow[]> {
  const inst = await getAgentInstance(instanceId);
  if (!inst) return [];
  const rows = await readSql<WatchlistPersonRow[]>`
    select id, handle, added_at, objective_kind, objective_note, person_id
    from noelle.x_watchlist_people
    where agent_instance_id = ${inst.id} and org_id = ${inst.org_id}
    order by added_at asc
  `;
  return [...rows];
}

export interface PendingApprovalRow {
  approval: NoelleApproval;
  draft: NoelleDraft | null;
  lead: NoelleLead | null;
  /**
   * Relationship-scout verdict the classifier attached to the lead
   * (noelle.leads.vip_signal). null when the scout never ran / the author isn't
   * high-leverage. Carried alongside `lead` rather than on it because the
   * generated NoelleLead type doesn't model the new column.
   */
  vipSignal: VipSignal | null;
}

/**
 * A lead's full approval detail: the representative approval row PLUS every
 * sibling approval for the same lead (the 3 reply angles + the DM are separate
 * approval rows). The detail page assembles all reply angles + the DM onto one
 * page from `siblings`. `siblings` includes the representative row itself.
 */
export interface ApprovalDetail extends PendingApprovalRow {
  siblings: PendingApprovalRow[];
}

/**
 * Collapse per-draft-variant approval rows to ONE representative per lead.
 *
 * The drafter writes 4 approvals per lead (3 reply angles + 1 DM), so the raw
 * list shows each lead 4×. The review inbox + the detail pager want one entry
 * per lead. Preserves the incoming order (score desc, then newest) and prefers
 * a reply draft as the representative over a DM so the row preview + detail
 * entry point land on the reply. Rows with no lead are kept as their own entry.
 */
export function dedupeApprovalsByLead(
  rows: PendingApprovalRow[],
): PendingApprovalRow[] {
  const byLead = new Map<string, PendingApprovalRow>();
  const out: PendingApprovalRow[] = [];
  for (const r of rows) {
    const leadId = r.approval.lead_id ?? r.draft?.lead_id ?? null;
    if (!leadId) {
      out.push(r);
      continue;
    }
    const existing = byLead.get(leadId);
    if (!existing) {
      byLead.set(leadId, r);
      out.push(r);
      continue;
    }
    // Upgrade the representative to a reply if the first one seen was a DM.
    const existingIsDm = draftPayload(existing.draft).kind === "dm";
    const candidateIsReply = draftPayload(r.draft).kind !== "dm";
    if (existingIsDm && candidateIsReply) {
      const idx = out.indexOf(existing);
      if (idx !== -1) out[idx] = r;
      byLead.set(leadId, r);
    }
  }
  return out;
}

/** Stable author identity for an X lead: numeric id first, then handle. */
function xAuthorKey(lead: NoelleLead): string | null {
  const lp = leadPayload(lead);
  return (
    lead.author_id ??
    lp.author_id ??
    lead.author_handle ??
    lp.author_handle ??
    null
  );
}

/** A post's own creation time in epoch ms, or 0 when absent/unparseable. */
function xLeadPostedAtMs(lead: NoelleLead): number {
  const raw = leadPayload(lead).posted_at;
  if (!raw) return 0;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Collapse each WATCHLISTED person down to just their single most-recent post.
 *
 * Watchlist accounts (`leads.priority = true`, the always-reply people) often
 * have several pending posts queued at once, so the same person shows up many
 * times in the inbox / speedrun. With this collapse on, we keep — per watched
 * author — only the approvals tied to their newest post (by the post's own
 * `posted_at`), so each watched person occupies one slot. Ties and missing
 * timestamps keep whichever post the active sort surfaced first.
 *
 * Non-watchlisted leads (keyword discovery) and lead-less rows pass through
 * untouched. Run this on the RAW per-approval rows BEFORE dedupeApprovalsByLead
 * / toSpeedrunLeads so the Review list, Speedrun, and the detail-page stepper
 * all walk the same collapsed set.
 */
export function keepLatestPostPerWatchlistedPerson(
  rows: PendingApprovalRow[],
): PendingApprovalRow[] {
  // Pass 1: find the newest post (lead) per watched author.
  const newestLeadByAuthor = new Map<
    string,
    { leadId: string; postedAt: number }
  >();
  for (const r of rows) {
    const lead = r.lead;
    if (!lead || lead.priority !== true) continue;
    const author = xAuthorKey(lead);
    const leadId = lead.id ?? r.approval.lead_id ?? r.draft?.lead_id ?? null;
    if (!author || !leadId) continue;
    const postedAt = xLeadPostedAtMs(lead);
    const best = newestLeadByAuthor.get(author);
    if (!best || postedAt > best.postedAt) {
      newestLeadByAuthor.set(author, { leadId, postedAt });
    }
  }
  // Pass 2: keep every non-watched row, plus the watched rows whose lead is the
  // author's newest.
  return rows.filter((r) => {
    const lead = r.lead;
    if (!lead || lead.priority !== true) return true;
    const author = xAuthorKey(lead);
    const leadId = lead.id ?? r.approval.lead_id ?? r.draft?.lead_id ?? null;
    if (!author || !leadId) return true;
    const best = newestLeadByAuthor.get(author);
    return !best || best.leadId === leadId;
  });
}

/**
 * Pending approvals for an org, joined to the underlying draft + lead.
 *
 * Previously this was a three-step stitch (approvals → drafts via `.in()` →
 * leads via `.in()`) because Supabase JS couldn't compose the join across
 * the embedded jsonb payloads cleanly. With direct Postgres we collapse
 * that to a single SQL statement:
 *
 *   approvals ⨝ drafts (drafts.id = approvals.draft_id)
 *             ⨝ leads  (leads.id  = drafts.lead_id)
 *
 * Both sides use `left join` so a stale approval with a soft-deleted draft
 * still appears in the inbox (matches the prior behavior where the stitch
 * step returned `null` for the missing side). Each row is unpacked back
 * into the `{ approval, draft, lead }` shape the consumers already expect.
 */
/** Which approval status the inbox shows. Defaults to the live work queue. */
export type ApprovalStatusFilter = "pending" | "sent" | "skipped" | "all";

/**
 * Lead source filter. `real` (default) hides synthetic seed leads whose
 * `external_id` is prefixed `synthetic-` (test data that leaked into
 * noelle.leads out-of-band — see 0017_purge_synthetic_leads.sql). `synthetic`
 * shows only those; `all` shows everything.
 */
export type ApprovalSourceFilter = "real" | "synthetic" | "all";

/**
 * Watchlist filter. `all` (default) shows every lead; `only` shows just
 * watchlist-person leads (leads.priority = true, the always-reply accounts);
 * `exclude` hides them so the operator can sweep non-watchlist leads. Keyed off
 * the discovery worker's `priority` flag, the same signal that marks a lead as
 * coming from a watchlisted author.
 */
export type ApprovalWatchlistFilter = "all" | "only" | "exclude";

export interface ListPendingApprovalsOptions {
  /**
   * Reviewer-facing quality floor (0..1). When set, approvals tied to leads
   * with `classifier_score < minScore` are dropped from the inbox. NULL
   * scores (pre-classifier-mirror rows) always pass through so the inbox
   * never silently swallows historical work where the classifier hadn't yet
   * mirrored.
   */
  minScore?: number | null;
  /** Approval status to show. Defaults to `pending` (the review queue). */
  status?: ApprovalStatusFilter;
  /** Lead source. Defaults to `real` — synthetic seed leads are hidden. */
  source?: ApprovalSourceFilter;
  /** Watchlist membership. Defaults to `all`. */
  watchlist?: ApprovalWatchlistFilter;
  /**
   * Ordering. `score` (default) ranks by classifier quality; `newest_post`
   * ranks by the POST's own creation time (leads.payload.posted_at) so the
   * freshest tweets surface first, regardless of when the lead was drafted.
   */
  sort?: ApprovalSort;
  /**
   * "Last batch" filter. When set to an ISO timestamp, only approvals created
   * at/after it are returned — used to show just the most recent goal-run's
   * output (the instance's last_goal_started_at). NULL/undefined = no filter.
   */
  lastBatchSince?: string | null;
}

/** Approval inbox ordering. */
export type ApprovalSort = "score" | "newest_post";

export async function listPendingApprovalsForOrg(
  orgId: string,
  limit = 50,
  options: ListPendingApprovalsOptions = {},
): Promise<PendingApprovalRow[]> {
  const sb = await createSupabaseServerClient();
  const userId = await getRequiredUserId(sb);
  await assertMember(orgId, userId);

  const minScore =
    options.minScore != null && Number.isFinite(options.minScore)
      ? Math.max(0, Math.min(1, options.minScore))
      : null;
  const status: ApprovalStatusFilter = options.status ?? "pending";
  const source: ApprovalSourceFilter = options.source ?? "real";
  const watchlist: ApprovalWatchlistFilter = options.watchlist ?? "all";
  const sort: ApprovalSort = options.sort ?? "score";
  const lastBatchSince = options.lastBatchSince ?? null;

  const rows = await readSql<JoinedRowRaw[]>`
    select
      a.id              as a_id,
      a.org_id          as a_org_id,
      a.agent_instance_id as a_agent_instance_id,
      a.draft_id        as a_draft_id,
      a.lead_id         as a_lead_id,
      a.status          as a_status,
      a.decided_at      as a_decided_at,
      a.decided_by      as a_decided_by,
      a.skip_reason     as a_skip_reason,
      a.auto_send_target_at as a_auto_send_target_at,
      a.created_at      as a_created_at,
      a.updated_at      as a_updated_at,
      d.id              as d_id,
      d.lead_id         as d_lead_id,
      d.org_id          as d_org_id,
      d.payload         as d_payload,
      d.synced_at       as d_synced_at,
      l.id              as l_id,
      l.external_id     as l_external_id,
      l.org_id          as l_org_id,
      l.payload         as l_payload,
      l.synced_at       as l_synced_at,
      l.tier            as l_tier,
      l.classifier_label as l_classifier_label,
      l.classifier_score as l_classifier_score,
      l.priority        as l_priority
    from noelle.approvals a
    left join noelle.drafts d on d.id = a.draft_id
    left join noelle.leads  l on l.id = d.lead_id
    where a.org_id = ${orgId}
      -- This is the X intern (Vega) inbox: exclude LinkedIn-platform leads,
      -- which queue in Lyra's own draft-only stream (?stream=linkedin-intern).
      -- platform defaults to 'x' (cloudsql/0005), so null/'x' both stay.
      and (l.platform is null or l.platform = 'x')
      and (${status} = 'all' or a.status = ${status})
      and (${source} = 'all'
           or (${source} = 'synthetic' and l.external_id like 'synthetic-%')
           or (${source} = 'real'
               and (l.external_id is null or l.external_id not like 'synthetic-%')))
      and (${minScore}::numeric is null
           or l.classifier_score is null
           or l.classifier_score >= ${minScore}::numeric)
      and (${watchlist} = 'all'
           or (${watchlist} = 'only' and l.priority = true)
           or (${watchlist} = 'exclude' and (l.priority is null or l.priority = false)))
      and (${lastBatchSince}::timestamptz is null
           or a.created_at >= ${lastBatchSince}::timestamptz)
    order by
      case when a.status = 'pending' then 0 else 1 end,
      case when ${sort} = 'newest_post'
           then (l.payload->>'posted_at')::timestamptz end desc nulls last,
      l.classifier_score desc nulls last,
      a.created_at desc
    limit ${limit}
  `;

  // Defensive filter: pre-2026-05-26 drafter runs occasionally produced
  // approvals whose draft bodies were SKIP prose (model wedged the skip into
  // the angle payload instead of returning {skip:"…"}). New runs normalise via
  // drafter-tick's safeJsonParse — this drops the historical residue (and any
  // future regression). Such a draft has no usable angle text, so it renders
  // as a broken card under ANY status filter; hide it everywhere (the rows
  // stay in the DB). See `lib/is-skip-draft.ts`.
  return rows
    .map((r) => unpackJoined(r))
    .filter((row) => !isAllSkipDraft(draftPayload(row.draft)));
}

/**
 * Count of *real* pending approvals for an org — synthetic seed leads
 * (external_id LIKE 'synthetic-%') excluded. Drives the X-intern stream
 * badge so it always reflects genuine work to review, independent of the
 * status/source filters the user may have applied to the visible list.
 * Cheap: a COUNT over the status-indexed approvals table.
 */
export const countPendingApprovalsForOrg = cache(async (
  orgId: string,
): Promise<number> => {
  const userId = await getRequiredUserId();
  await assertMember(orgId, userId);
  // Count distinct visible leads, not raw approval rows. The drafter writes ~4
  // approvals per reply lead (3 reply angles + 1 legacy companion DM). The tab
  // badge is the replies backlog; the shared Show DMs control reveals and
  // counts DMs separately inside the active stream.
  // Approvals with no lead still count once via the id coalesce.
  const rows = await readSql<Array<{ n: number }>>`
    select count(distinct coalesce(l.id::text, a.id::text))::int as n
    from noelle.approvals a
    left join noelle.drafts d on d.id = a.draft_id
    left join noelle.leads  l on l.id = d.lead_id
    where a.org_id = ${orgId}
      and a.status = 'pending'
      -- X intern (Vega) badge only — LinkedIn leads belong to Lyra's stream.
      and (l.platform is null or l.platform = 'x')
      and (l.external_id is null or l.external_id not like 'synthetic-%')
      and coalesce(d.payload->>'kind', 'reply') <> 'dm'
  `;
  return rows[0]?.n ?? 0;
});

/**
 * Lifetime count of approvals genuinely SENT for an org (status = 'sent' only
 * — skipped drafts are NOT sends). Drives the "Sent" KPI. Excludes synthetic
 * seed leads, matching the pending/visible surfaces.
 *
 * Note: 'sent' is forward-only — deleting the reply/DM on X does not decrement
 * it, and a hand-dispatched DM is marked 'sent' without Noelle posting. So this
 * reflects "approvals marked sent", not "currently-live posts".
 */
export async function countSentApprovalsForOrg(orgId: string): Promise<number> {
  const sb = await createSupabaseServerClient();
  const userId = await getRequiredUserId(sb);
  await assertMember(orgId, userId);
  const rows = await readSql<Array<{ n: number }>>`
    select count(*)::int as n
    from noelle.approvals a
    left join noelle.leads l on l.id = a.lead_id
    where a.org_id = ${orgId}
      and a.status = 'sent'
      and (l.external_id is null or l.external_id not like 'synthetic-%')
  `;
  return rows[0]?.n ?? 0;
}

/** One agent's sent-message tally, sliced by recency and reply-vs-DM. */
export interface SentStatsByAgentRow {
  instanceId: string;
  /** 'x_intern' (Vega) | 'linkedin_intern' (Lyra) | … */
  role: string;
  displayName: string;
  /** Platform the role posts to — derived from role, for the UI label. */
  platform: "x" | "linkedin" | "other";
  /** Sent since 00:00 UTC today. */
  today: number;
  /** Sent in the trailing 7 days (today + 6). */
  last7: number;
  /** Lifetime sent. */
  total: number;
  /** Of `total`, how many were DMs (drafts.payload.kind = 'dm'). */
  dms: number;
  /** Of `total`, how many were replies (everything that isn't a DM). */
  replies: number;
}

function platformForRole(role: string): SentStatsByAgentRow["platform"] {
  if (role === "x_intern") return "x";
  if (role === "linkedin_intern") return "linkedin";
  return "other";
}

/**
 * Per-agent sent-message stats for the Stats page — today / last 7 days /
 * lifetime, plus a reply-vs-DM split. Driven from `agent_instances` (left join
 * approvals) so a real agent with zero sends still shows a row of zeros rather
 * than vanishing. 'sent' is status = 'sent' only (skips are not sends), and
 * synthetic seed leads are excluded via a NOT EXISTS in the join so they never
 * inflate a count. `decided_at` is the send time; windows are UTC, matching the
 * rest of the dashboard. Tenancy guard before the query.
 */
export async function getSentStatsByAgent(
  orgId: string,
): Promise<SentStatsByAgentRow[]> {
  const sb = await createSupabaseServerClient();
  const userId = await getRequiredUserId(sb);
  await assertMember(orgId, userId);
  const rows = await readSql<
    Array<{
      instance_id: string;
      role: string;
      display_name: string;
      today: number;
      last7: number;
      total: number;
      dms: number;
      replies: number;
    }>
  >`
    select
      ai.id           as instance_id,
      ai.role         as role,
      ai.display_name as display_name,
      count(a.id)::int                                                          as total,
      count(a.id) filter (where a.decided_at >= date_trunc('day', now()))::int  as today,
      count(a.id) filter (
        where a.decided_at >= date_trunc('day', now()) - interval '6 days'
      )::int                                                                    as last7,
      count(a.id) filter (
        where coalesce(d.payload->>'kind', 'reply') = 'dm'
      )::int                                                                    as dms,
      count(a.id) filter (
        where coalesce(d.payload->>'kind', 'reply') <> 'dm'
      )::int                                                                    as replies
    from noelle.agent_instances ai
    left join noelle.approvals a
      on a.agent_instance_id = ai.id
     and a.org_id = ai.org_id
     and a.status = 'sent'
     and not exists (
       select 1 from noelle.leads syn
       where syn.id = a.lead_id and syn.external_id like 'synthetic-%'
     )
    left join noelle.drafts d on d.id = a.draft_id
    where ai.org_id = ${orgId}
      and ai.role in ('x_intern', 'linkedin_intern')
    group by ai.id, ai.role, ai.display_name
    order by total desc, ai.role asc
  `;
  return rows.map((r) => ({
    instanceId: r.instance_id,
    role: r.role,
    displayName: r.display_name,
    platform: platformForRole(r.role),
    today: r.today,
    last7: r.last7,
    total: r.total,
    dms: r.dms,
    replies: r.replies,
  }));
}

/** One day's sent total, split by platform, for the trailing-14-day chart. */
export interface SentDailyPoint {
  /** ISO date (YYYY-MM-DD), UTC. */
  day: string;
  /** Sent by the X intern (Vega) that day. */
  x: number;
  /** Sent by the LinkedIn intern (Lyra) that day. */
  linkedin: number;
  /** x + linkedin (+ any other role). */
  total: number;
}

/**
 * Trailing-14-day daily sent counts, split X vs LinkedIn, for the Stats page
 * chart. Generates a dense date series (so empty days render as zero-height
 * bars rather than gaps), left-joins sent approvals on `decided_at::date`, and
 * excludes synthetic seed leads. Mirrors `getOrgSpendDaily14`'s shape. Tenancy
 * guard before the query.
 */
export async function getSentDaily14ByAgent(
  orgId: string,
): Promise<SentDailyPoint[]> {
  const sb = await createSupabaseServerClient();
  const userId = await getRequiredUserId(sb);
  await assertMember(orgId, userId);
  const rows = await readSql<
    Array<{ day: string; x: number; linkedin: number; total: number }>
  >`
    with days as (
      select generate_series(
        (current_date - interval '13 days')::date,
        current_date,
        interval '1 day'
      )::date as day
    )
    select
      d.day::text as day,
      count(a.id) filter (where ai.role = 'x_intern')::int        as x,
      count(a.id) filter (where ai.role = 'linkedin_intern')::int as linkedin,
      count(a.id)::int                                            as total
    from days d
    left join noelle.approvals a
      on a.org_id = ${orgId}
     and a.status = 'sent'
     and a.decided_at::date = d.day
     and not exists (
       select 1 from noelle.leads syn
       where syn.id = a.lead_id and syn.external_id like 'synthetic-%'
     )
    left join noelle.agent_instances ai on ai.id = a.agent_instance_id
    group by d.day
    order by d.day asc
  `;
  return rows.map((r) => ({
    day: r.day,
    x: r.x,
    linkedin: r.linkedin,
    total: r.total,
  }));
}

/**
 * Lifetime count of approvals that have been actioned (sent OR skipped) for an
 * org, excluding synthetic seed leads. Used to derive "drafts produced"
 * (pending + actioned) so a produced count includes drafts you skipped.
 */
export async function countActionedApprovalsForOrg(orgId: string): Promise<number> {
  const sb = await createSupabaseServerClient();
  const userId = await getRequiredUserId(sb);
  await assertMember(orgId, userId);
  const rows = await readSql<Array<{ n: number }>>`
    select count(*)::int as n
    from noelle.approvals a
    left join noelle.leads l on l.id = a.lead_id
    where a.org_id = ${orgId}
      and a.status in ('sent', 'skipped')
      and (l.external_id is null or l.external_id not like 'synthetic-%')
  `;
  return rows[0]?.n ?? 0;
}

/**
 * Backpressure status for the org's X Growth Intern (Vega).
 *
 * Returns the configured caps and the current counts so the dashboard
 * can surface "Resting at 100/100 drafts — review some to wake Vega up"
 * or "Backlog full (243/200) — discovery paused" without the card
 * having to know how the workers gate themselves.
 *
 * Returns `null` when the org has no `x_intern` instance (alpha
 * cohorts that haven't been provisioned yet) — let the caller skip
 * the override entirely instead of falling back to fake numbers.
 *
 * One round trip, index-covered by:
 *   - approvals_instance_idx (counts pending approvals)
 *   - leads(org_id, status, ...)
 */
export async function getCapStatusForXIntern(
  orgId: string,
): Promise<{
  pendingDraftsCap: number | null;
  pendingDrafts: number;
  leadBacklogCap: number | null;
  leadBacklog: number;
} | null> {
  const sb = await createSupabaseServerClient();
  const userId = await getRequiredUserId(sb);
  await assertMember(orgId, userId);

  // Single round trip: pulls the instance's two caps and the live
  // counts from approvals + leads. LEFT JOIN LATERAL keeps the row
  // even when there's nothing in either subtable (counts default 0).
  const rows = await readSql<
    Array<{
      pending_drafts_cap: number | null;
      pending_drafts: string;
      lead_backlog_cap: number | null;
      lead_backlog: string;
    }>
  >`
    select
      ai.pending_drafts_cap,
      ai.lead_backlog_cap,
      (
        select count(*)
        from noelle.approvals a
        where a.agent_instance_id = ai.id and a.status = 'pending'
      )::text as pending_drafts,
      (
        select count(*)
        from noelle.leads l
        where l.agent_instance_id = ai.id
          and l.status in ('new', 'classifying', 'classified', 'drafting')
      )::text as lead_backlog
    from noelle.agent_instances ai
    where ai.org_id = ${orgId}
      and ai.role = 'x_intern'
    limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    pendingDraftsCap: row.pending_drafts_cap,
    pendingDrafts: Number(row.pending_drafts),
    leadBacklogCap: row.lead_backlog_cap,
    leadBacklog: Number(row.lead_backlog),
  };
}

export async function getApprovalDetail(
  approvalId: string,
): Promise<ApprovalDetail | null> {
  const sb = await createSupabaseServerClient();
  const userId = await getRequiredUserId(sb);

  // We need the approval row first to know which org to guard against; do
  // it as the same single join so we only round-trip once.
  const rows = await readSql<JoinedRowRaw[]>`
    select
      a.id              as a_id,
      a.org_id          as a_org_id,
      a.agent_instance_id as a_agent_instance_id,
      a.draft_id        as a_draft_id,
      a.lead_id         as a_lead_id,
      a.status          as a_status,
      a.decided_at      as a_decided_at,
      a.decided_by      as a_decided_by,
      a.skip_reason     as a_skip_reason,
      a.auto_send_target_at as a_auto_send_target_at,
      a.created_at      as a_created_at,
      a.updated_at      as a_updated_at,
      d.id              as d_id,
      d.lead_id         as d_lead_id,
      d.org_id          as d_org_id,
      d.payload         as d_payload,
      d.synced_at       as d_synced_at,
      l.id              as l_id,
      l.external_id     as l_external_id,
      l.org_id          as l_org_id,
      l.payload         as l_payload,
      l.synced_at       as l_synced_at,
      l.tier            as l_tier,
      l.classifier_label as l_classifier_label,
      l.classifier_score as l_classifier_score,
      l.priority        as l_priority,
      l.platform        as l_platform,
      l.vip_signal      as l_vip_signal
    from noelle.approvals a
    left join noelle.drafts d on d.id = a.draft_id
    left join noelle.leads  l on l.id = d.lead_id
    where a.id = ${approvalId}
    limit 1
  `;

  const row = rows[0];
  if (!row) return null;
  // Phase 2 guard: gate access on caller membership of the approval's org.
  await assertMember(row.a_org_id, userId);
  const unpacked = unpackJoined(row);
  // Same defensive filter as listPendingApprovalsForOrg — old SKIP-shaped
  // approval rows shouldn't be reachable via direct URL either.
  if (
    unpacked.approval.status === "pending" &&
    isAllSkipDraft(draftPayload(unpacked.draft))
  ) {
    return null;
  }

  // Load every sibling approval for the same lead so the detail page can show
  // all 3 reply angles + the DM on one page (each is a separate approval row).
  // Falls back to just the primary row when the approval has no lead.
  let siblings: PendingApprovalRow[] = [unpacked];
  const leadId = unpacked.approval.lead_id ?? unpacked.draft?.lead_id ?? null;
  if (leadId) {
    const sibRows = await readSql<JoinedRowRaw[]>`
      select
        a.id              as a_id,
        a.org_id          as a_org_id,
        a.agent_instance_id as a_agent_instance_id,
        a.draft_id        as a_draft_id,
        a.lead_id         as a_lead_id,
        a.status          as a_status,
        a.decided_at      as a_decided_at,
        a.decided_by      as a_decided_by,
        a.skip_reason     as a_skip_reason,
        a.auto_send_target_at as a_auto_send_target_at,
        a.created_at      as a_created_at,
        a.updated_at      as a_updated_at,
        d.id              as d_id,
        d.lead_id         as d_lead_id,
        d.org_id          as d_org_id,
        d.payload         as d_payload,
        d.synced_at       as d_synced_at,
        l.id              as l_id,
        l.external_id     as l_external_id,
        l.org_id          as l_org_id,
        l.payload         as l_payload,
        l.synced_at       as l_synced_at,
        l.tier            as l_tier,
        l.classifier_label as l_classifier_label,
        l.classifier_score as l_classifier_score,
        l.priority        as l_priority,
        l.platform        as l_platform,
        l.vip_signal      as l_vip_signal
      from noelle.approvals a
      left join noelle.drafts d on d.id = a.draft_id
      left join noelle.leads  l on l.id = d.lead_id
      where a.org_id = ${unpacked.approval.org_id}
        and a.lead_id = ${leadId}
      order by a.created_at asc
    `;
    const unpackedSibs = sibRows
      .map(unpackJoined)
      .filter((s) => !isAllSkipDraft(draftPayload(s.draft)));
    if (unpackedSibs.length > 0) siblings = unpackedSibs;
  }

  return { ...unpacked, siblings };
}

interface JoinedRowRaw {
  a_id: string;
  a_org_id: string;
  a_agent_instance_id: string;
  a_draft_id: string;
  a_lead_id: string;
  a_status: string;
  a_decided_at: string | null;
  a_decided_by: string | null;
  a_skip_reason: string | null;
  a_auto_send_target_at: string | null;
  a_created_at: string;
  a_updated_at: string;
  d_id: string | null;
  d_lead_id: string | null;
  d_org_id: string | null;
  d_payload: unknown;
  d_synced_at: string | null;
  l_id: string | null;
  l_external_id: string | null;
  l_org_id: string | null;
  l_payload: unknown;
  l_synced_at: string | null;
  // Classifier columns from cloudsql/0005. postgres-js returns `numeric`
  // as a JS string, so we coerce on unpack.
  l_tier: string | null;
  l_classifier_label: string | null;
  l_classifier_score: string | number | null;
  // 0005_leads_full_schema §platform. Defaults to 'x' when the column is
  // somehow null (pre-0005 rows that never got backfilled).
  l_platform?: string | null;
  // Watchlist flag — true when the lead's author is a watched person. Optional
  // because the detail-sibling selects don't always project it; coalesced to
  // null on unpack.
  l_priority?: boolean | null;
  // Relationship-scout verdict jsonb (noelle.leads.vip_signal). Optional because
  // not every select projects it; parsed + coalesced to null on unpack.
  l_vip_signal?: unknown;
}

function unpackJoined(r: JoinedRowRaw): PendingApprovalRow {
  const approval: NoelleApproval = {
    id: r.a_id,
    org_id: r.a_org_id,
    agent_instance_id: r.a_agent_instance_id,
    draft_id: r.a_draft_id,
    lead_id: r.a_lead_id,
    status: r.a_status,
    decided_at: r.a_decided_at,
    decided_by: r.a_decided_by,
    skip_reason: r.a_skip_reason,
    auto_send_target_at: r.a_auto_send_target_at,
    created_at: r.a_created_at,
    updated_at: r.a_updated_at,
  } as NoelleApproval;

  const draft: NoelleDraft | null = r.d_id
    ? ({
        id: r.d_id,
        lead_id: r.d_lead_id!,
        org_id: r.d_org_id!,
        payload: r.d_payload,
        synced_at: r.d_synced_at!,
      } as NoelleDraft)
    : null;

  const lead: NoelleLead | null = r.l_id
    ? ({
        id: r.l_id,
        external_id: r.l_external_id!,
        org_id: r.l_org_id!,
        payload: r.l_payload,
        synced_at: r.l_synced_at!,
        tier:
          r.l_tier === "T1" || r.l_tier === "T2" || r.l_tier === "T3"
            ? r.l_tier
            : null,
        classifier_label: r.l_classifier_label,
        classifier_score:
          r.l_classifier_score == null
            ? null
            : typeof r.l_classifier_score === "string"
              ? Number(r.l_classifier_score)
              : r.l_classifier_score,
        platform: (r.l_platform as SocialPlatform | null) ?? "x",
        priority: r.l_priority ?? null,
      } as NoelleLead)
    : null;

  return { approval, draft, lead, vipSignal: parseVipSignal(r.l_vip_signal) };
}

export async function getOrgSpendForMonth(
  orgId: string,
  monthIsoFirstOfMonth: string,
): Promise<NoelleOrgSpendMonth[]> {
  const sb = await createSupabaseServerClient();
  const userId = await getRequiredUserId(sb);
  await assertMember(orgId, userId);
  const rows = await readSql<NoelleOrgSpendMonth[]>`
    select * from noelle.org_spend_month
    where org_id = ${orgId} and month = ${monthIsoFirstOfMonth}
  `;
  // `org_spend_month.cents` is a BIGINT, and postgres.js returns bigint columns
  // as JS strings. Callers sum these with `acc + row.cents`, so a string slips
  // through as concatenation ("3" + "70" + "41" + "280" → "037041280" →
  // $370412.80) instead of addition. Coerce to a number at the source so every
  // consumer (nav meter, dashboard, billing) is correct. The generated type
  // already claims `number`, so this just makes runtime match it.
  return rows.map((r) => ({ ...r, cents: Number(r.cents ?? 0) }));
}

/**
 * Sum of per-agent `budget_cap_cents` for the org — the closest thing the
 * schema has to a monthly org spend cap. Returns 0 when no caps are set.
 */
export async function getOrgBudgetCapCents(orgId: string): Promise<number> {
  const sb = await createSupabaseServerClient();
  const userId = await getRequiredUserId(sb);
  await assertMember(orgId, userId);
  const rows = await readSql<Array<{ cents: number }>>`
    select coalesce(sum(budget_cap_cents), 0)::int as cents
    from noelle.agent_instances
    where org_id = ${orgId}
  `;
  return rows[0]?.cents ?? 0;
}

/** First-of-month (UTC) ISO date, the key `org_spend_month` rows are bucketed by. */
export function currentMonthIso(d = new Date()): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

/**
 * True when a `org_spend_month.bucket` row is an Apify data-fetch bucket
 * (apifySpendRow names them `apify-<worker>`, e.g. "apify-drafter"). Apify spend
 * is recorded for visibility but is EXCLUDED from the cap-relevant "spent this
 * month" total — it never counts toward the limit. Mirrors the cap reader's
 * apify exemption (packages/runtime/src/pgBudgetAdapters.ts).
 */
export function isApifyBucket(bucket: string | null | undefined): boolean {
  return typeof bucket === "string" && bucket.startsWith("apify");
}

export interface XApiSpend {
  /** The configured flat MONTHLY subscription cost (cents). */
  monthlyCostCents: number;
  tier: string;
  /** Writes metered this calendar month (visibility only — never capped). */
  postsThisMonth: number;
  repliesThisMonth: number;
}

/**
 * The org's X API subscription line for the Spends page: the configured flat
 * monthly cost (noelle.x_api_config) + this month's write counts from
 * noelle.llm_calls (engine='xapi'). The X API bills a flat tier, so its cost
 * never counts toward the per-call LLM cap.
 */
export async function loadXApiSpend(orgId: string): Promise<XApiSpend> {
  const userId = await requiredUserId();
  await assertOrgMember(pgOrgMembersClient(), userId, orgId);
  const [cfgRows, countRows] = await Promise.all([
    readSql<Array<{ tier: string; monthly_cost_cents: string | number }>>`
      select tier, monthly_cost_cents from noelle.x_api_config where org_id = ${orgId}
    `.catch(() => [] as Array<{ tier: string; monthly_cost_cents: string | number }>),
    readSql<Array<{ bucket: string; n: string | number }>>`
      select bucket, count(*) as n from noelle.llm_calls
      where org_id = ${orgId} and engine = 'xapi'
        and started_at >= date_trunc('month', now())
      group by bucket
    `.catch(() => [] as Array<{ bucket: string; n: string | number }>),
  ]);
  const cfg = cfgRows[0];
  const posts = Number(countRows.find((r) => r.bucket === "xapi-post")?.n ?? 0);
  const replies = Number(countRows.find((r) => r.bucket === "xapi-reply")?.n ?? 0);
  return {
    monthlyCostCents: Number(cfg?.monthly_cost_cents ?? 0),
    tier: cfg?.tier ?? "none",
    postsThisMonth: posts,
    repliesThisMonth: replies,
  };
}

export interface XApiConnection {
  /** Whether Vega has X API creds saved. */
  connected: boolean;
  handle: string | null;
  authKind: string | null;
  writeEnabled: boolean;
  /** True when the org has an x_intern (Vega) to connect at all. */
  hasVega: boolean;
}

/** X API connection status for the org's Vega instance (Connections page). */
export async function getXApiConnection(orgId: string): Promise<XApiConnection> {
  const userId = await requiredUserId();
  await assertOrgMember(pgOrgMembersClient(), userId, orgId);
  const rows = await readSql<Array<{ x_handle: string | null; auth_kind: string | null; write_enabled: boolean }>>`
    select t.x_handle, t.auth_kind, i.x_api_write_enabled as write_enabled
    from noelle.agent_instances i
    left join noelle.x_api_tokens t on t.agent_instance_id = i.id
    where i.org_id = ${orgId} and i.role = 'x_intern'
    limit 1
  `;
  const r = rows[0];
  return {
    connected: !!r?.auth_kind,
    handle: r?.x_handle ?? null,
    authKind: r?.auth_kind ?? null,
    writeEnabled: r?.write_enabled ?? false,
    hasVega: rows.length > 0,
  };
}

/**
 * Daily spend for the trailing 14 days, in cents. Returns a 14-length array
 * with `0` for any day that had no llm_calls — caller treats this as the raw
 * input to the Spend page sparkline.
 *
 * Reads from noelle.llm_calls (the per-invocation log), NOT org_spend_month —
 * the rollup table is bucketed by month, not by day, so it can't drive a daily
 * chart. Tenancy guard before the query.
 */
export async function getOrgSpendDaily14(orgId: string): Promise<number[]> {
  const sb = await createSupabaseServerClient();
  const userId = await getRequiredUserId(sb);
  await assertMember(orgId, userId);
  const rows = await readSql<Array<{ day: string; cents: string | number }>>`
    with days as (
      select generate_series(
        (current_date - interval '13 days')::date,
        current_date,
        interval '1 day'
      )::date as day
    )
    select
      d.day::text as day,
      coalesce(sum(l.cents), 0)::bigint as cents
    from days d
    left join noelle.llm_calls l
      on l.org_id = ${orgId}
     and l.started_at::date = d.day
    group by d.day
    order by d.day asc
  `;
  return rows.map((r) => Number(r.cents));
}

export interface SpendDayPoint {
  /** ISO date (YYYY-MM-DD) for this day. */
  day: string;
  /** LLM spend (engine <> 'apify') in cents — what counts toward the cap. */
  llmCents: number;
  /** Apify spend (engine = 'apify') in cents — never counts toward the cap. */
  apifyCents: number;
}

/**
 * Daily spend for the trailing `days` days (default 30), SPLIT into LLM vs Apify
 * so the spend-over-time chart can stack the cap-relevant LLM spend separately
 * from the Apify data-fetch cost. Reads noelle.llm_calls (the rollup is monthly,
 * so it can't drive a daily chart) and carries the `engine` column. Every day in
 * the window is present (0 for empty days). Tenancy guard before the query.
 */
export async function getOrgSpendDailyBySource(
  orgId: string,
  days = 30,
): Promise<SpendDayPoint[]> {
  const sb = await createSupabaseServerClient();
  const userId = await getRequiredUserId(sb);
  await assertMember(orgId, userId);
  const span = Math.max(1, Math.min(120, Math.floor(days))) - 1;
  const rows = await readSql<
    Array<{ day: string; llm_cents: string | number; apify_cents: string | number }>
  >`
    with days as (
      select generate_series(
        (current_date - (${span} || ' days')::interval)::date,
        current_date,
        interval '1 day'
      )::date as day
    )
    select
      d.day::text as day,
      coalesce(sum(l.cents) filter (where l.engine <> 'apify'), 0)::bigint as llm_cents,
      coalesce(sum(l.cents) filter (where l.engine = 'apify'), 0)::bigint  as apify_cents
    from days d
    left join noelle.llm_calls l
      on l.org_id = ${orgId}
     and l.started_at::date = d.day
    group by d.day
    order by d.day asc
  `;
  return rows.map((r) => ({
    day: r.day,
    llmCents: Number(r.llm_cents ?? 0),
    apifyCents: Number(r.apify_cents ?? 0),
  }));
}

export interface SpendByWorkerRow {
  /** Worker name ("drafter" | "classifier" | "discovery" | "profiler" | …). */
  worker: string;
  /** LLM spend for this worker (engine <> 'apify') in cents. */
  llmCents: number;
  /** Apify spend for this worker (engine = 'apify') in cents. */
  apifyCents: number;
}

/**
 * This month's spend grouped by WORKER, split into LLM vs Apify cents. Drives the
 * "by worker" chart on the spend page. Reads raw noelle.llm_calls (carries both
 * `worker` and `engine`). Coerces bigint sums. Tenancy guard before the query.
 */
export async function getOrgSpendByWorkerMonth(orgId: string): Promise<SpendByWorkerRow[]> {
  const sb = await createSupabaseServerClient();
  const userId = await getRequiredUserId(sb);
  await assertMember(orgId, userId);
  const rows = await readSql<
    Array<{ worker: string | null; llm_cents: string | number; apify_cents: string | number }>
  >`
    select
      coalesce(worker, 'other') as worker,
      coalesce(sum(cents) filter (where engine <> 'apify'), 0)::bigint as llm_cents,
      coalesce(sum(cents) filter (where engine = 'apify'), 0)::bigint  as apify_cents
    from noelle.llm_calls
    where org_id = ${orgId}
      and started_at >= date_trunc('month', now())
    group by 1
    order by (
      coalesce(sum(cents) filter (where engine <> 'apify'), 0)
      + coalesce(sum(cents) filter (where engine = 'apify'), 0)
    ) desc
  `;
  return rows.map((r) => ({
    worker: r.worker ?? "other",
    llmCents: Number(r.llm_cents ?? 0),
    apifyCents: Number(r.apify_cents ?? 0),
  }));
}

/** The time windows the Spend page can be viewed over (all are "to-date"). */
export type SpendRangeKey = "month" | "quarter" | "year" | "all";

export interface SpendRange {
  key: SpendRangeKey;
  /** Inclusive lower bound (UTC ISO). Everything from here to now is in range. */
  startIso: string;
  /** Full label, e.g. "This quarter". */
  label: string;
  /** Trend-chart bucketing: daily for short ranges, monthly for long ones. */
  granularity: "day" | "month";
}

/**
 * Resolve a `?range=` value into its UTC start bound + display metadata. Unknown
 * values fall back to "month". Ranges are cumulative to-date: quarter = this
 * quarter so far, year = year-to-date, all = since the account began. "all" uses
 * a fixed pre-history floor (Noelle did not exist before 2026).
 */
export function resolveSpendRange(key: string | undefined, now = new Date()): SpendRange {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const iso = (d: Date) => d.toISOString();
  switch (key) {
    case "quarter":
      return {
        key: "quarter",
        startIso: iso(new Date(Date.UTC(y, Math.floor(m / 3) * 3, 1))),
        label: "This quarter",
        granularity: "day",
      };
    case "year":
      return { key: "year", startIso: iso(new Date(Date.UTC(y, 0, 1))), label: "This year", granularity: "month" };
    case "all":
      return { key: "all", startIso: iso(new Date(Date.UTC(2000, 0, 1))), label: "All time", granularity: "month" };
    case "month":
    default:
      return { key: "month", startIso: iso(new Date(Date.UTC(y, m, 1))), label: "This month", granularity: "day" };
  }
}

export interface SpendBucketRow {
  bucket: string;
  cents: number;
}

/**
 * Spend grouped by bucket over an arbitrary window (started_at >= startIso), read
 * straight from noelle.llm_calls (the source of truth) rather than the monthly
 * rollup, so quarter/year/all-time views sum the real per-call cents. Coerces the
 * bigint sum. Tenancy guard before the query.
 */
export async function getOrgSpendByBucketRange(orgId: string, startIso: string): Promise<SpendBucketRow[]> {
  const sb = await createSupabaseServerClient();
  const userId = await getRequiredUserId(sb);
  await assertMember(orgId, userId);
  const rows = await readSql<Array<{ bucket: string | null; cents: string | number }>>`
    select coalesce(bucket, 'other') as bucket, coalesce(sum(cents), 0)::bigint as cents
    from noelle.llm_calls
    where org_id = ${orgId} and started_at >= ${startIso}
    group by 1
    order by 2 desc
  `;
  return rows.map((r) => ({ bucket: r.bucket ?? "other", cents: Number(r.cents ?? 0) }));
}

/** Spend grouped by WORKER (LLM vs Apify split) over an arbitrary window. */
export async function getOrgSpendByWorkerRange(orgId: string, startIso: string): Promise<SpendByWorkerRow[]> {
  const sb = await createSupabaseServerClient();
  const userId = await getRequiredUserId(sb);
  await assertMember(orgId, userId);
  const rows = await readSql<
    Array<{ worker: string | null; llm_cents: string | number; apify_cents: string | number }>
  >`
    select
      coalesce(worker, 'other') as worker,
      coalesce(sum(cents) filter (where engine <> 'apify'), 0)::bigint as llm_cents,
      coalesce(sum(cents) filter (where engine = 'apify'), 0)::bigint  as apify_cents
    from noelle.llm_calls
    where org_id = ${orgId} and started_at >= ${startIso}
    group by 1
    order by (
      coalesce(sum(cents) filter (where engine <> 'apify'), 0)
      + coalesce(sum(cents) filter (where engine = 'apify'), 0)
    ) desc
  `;
  return rows.map((r) => ({
    worker: r.worker ?? "other",
    llmCents: Number(r.llm_cents ?? 0),
    apifyCents: Number(r.apify_cents ?? 0),
  }));
}

/**
 * Spend trend (LLM vs Apify, stacked) over an arbitrary window, bucketed by day
 * or month. A gap-filled series (0 for empty buckets) so the chart has one column
 * per period. Monthly buckets keep long ranges (year/all) readable. Tenancy guard.
 */
export async function getOrgSpendTrendRange(
  orgId: string,
  startIso: string,
  granularity: "day" | "month",
): Promise<SpendDayPoint[]> {
  const sb = await createSupabaseServerClient();
  const userId = await getRequiredUserId(sb);
  await assertMember(orgId, userId);
  const rows =
    granularity === "month"
      ? await readSql<Array<{ day: string; llm_cents: string | number; apify_cents: string | number }>>`
          with bounds as (
            -- Clamp the series to the org's first activity so "all time" (which
            -- starts at a pre-history floor) doesn't emit hundreds of empty months.
            select greatest(
              ${startIso}::timestamptz,
              coalesce((select min(started_at) from noelle.llm_calls where org_id = ${orgId}), now())
            ) as start_at
          ),
          buckets as (
            select generate_series(
              date_trunc('month', (select start_at from bounds)),
              date_trunc('month', now()),
              interval '1 month'
            ) as b
          )
          select
            to_char(b.b, 'YYYY-MM') as day,
            coalesce(sum(l.cents) filter (where l.engine <> 'apify'), 0)::bigint as llm_cents,
            coalesce(sum(l.cents) filter (where l.engine = 'apify'), 0)::bigint  as apify_cents
          from buckets b
          left join noelle.llm_calls l
            on l.org_id = ${orgId}
           and date_trunc('month', l.started_at) = b.b
          group by b.b
          order by b.b asc
        `
      : await readSql<Array<{ day: string; llm_cents: string | number; apify_cents: string | number }>>`
          with buckets as (
            select generate_series(${startIso}::date, current_date, interval '1 day')::date as b
          )
          select
            b.b::text as day,
            coalesce(sum(l.cents) filter (where l.engine <> 'apify'), 0)::bigint as llm_cents,
            coalesce(sum(l.cents) filter (where l.engine = 'apify'), 0)::bigint  as apify_cents
          from buckets b
          left join noelle.llm_calls l
            on l.org_id = ${orgId}
           and l.started_at::date = b.b
          group by b.b
          order by b.b asc
        `;
  return rows.map((r) => ({
    day: r.day,
    llmCents: Number(r.llm_cents ?? 0),
    apifyCents: Number(r.apify_cents ?? 0),
  }));
}

export interface OrgSpendBySource {
  /** All LLM engines (vertex / bedrock / claude / openai). */
  ai: number;
  /** Apify data-fetch actors (engine='apify'). */
  apify: number;
}

/**
 * This month's spend split by SOURCE — AI (all LLM engines) vs Apify (LinkedIn
 * data fetch). Reads raw noelle.llm_calls because it carries the `engine` column;
 * the monthly rollup (org_spend_month) is keyed by bucket only, so it can't drive
 * this split. Tenancy guard before the query. `cents` is summed as bigint and
 * coerced (postgres.js returns bigint as a string).
 */
export async function getOrgSpendBySourceMonth(orgId: string): Promise<OrgSpendBySource> {
  const sb = await createSupabaseServerClient();
  const userId = await getRequiredUserId(sb);
  await assertMember(orgId, userId);
  const rows = await readSql<Array<{ source: string; cents: string | number }>>`
    select
      case when engine = 'apify' then 'apify' else 'ai' end as source,
      coalesce(sum(cents), 0)::bigint as cents
    from noelle.llm_calls
    where org_id = ${orgId}
      and started_at >= date_trunc('month', now())
    group by 1
  `;
  const out: OrgSpendBySource = { ai: 0, apify: 0 };
  for (const r of rows) {
    const cents = Number(r.cents ?? 0);
    if (r.source === "apify") out.apify += cents;
    else out.ai += cents;
  }
  return out;
}

export interface ApifyConnection {
  id: string;
  /** Masked display label (never the raw token). */
  label: string;
  createdAt: string;
  /**
   * When this token last hit its monthly usage cap (null = healthy). The worker
   * sets it on a 403 and rotates to the next token; clears it on the next success.
   */
  exhaustedAt: string | null;
  /**
   * Server-computed: 'invalid' = Apify rejected the token (401 — wrong/dead /
   * banned account, replace it); 'exhausted' = hit its cap and still inside its
   * retry/billing cooldown; 'live' = healthy, or its retry date has passed.
   */
  status: "live" | "exhausted" | "invalid";
  /** Short retry/billing date (e.g. "Jul 13") shown while exhausted; else null. */
  retryLabel: string | null;
  /**
   * true = IN USE (the agents rotate through it); false = SPARE (parked — visible +
   * testable here but no worker touches it until the operator promotes it).
   */
  inUse: boolean;
}

/**
 * All of the org's ACTIVE Apify tokens (masked), in fallback order — non-exhausted
 * first, then exhausted oldest-first (mirrors the worker's resolver). The operator
 * stacks several so discovery rotates to the next when one hits its monthly cap.
 */
export async function listApifyConnections(orgId: string): Promise<ApifyConnection[]> {
  const sb = await createSupabaseServerClient();
  const userId = await getRequiredUserId(sb);
  await assertMember(orgId, userId);
  const rows = await readSql<
    Array<{
      id: string;
      label: string;
      created_at: string;
      exhausted_at: string | null;
      status: "live" | "exhausted" | "invalid";
      retry_label: string | null;
      in_use: boolean;
    }>
  >`
    select id, label, created_at::text as created_at, exhausted_at::text as exhausted_at,
           case when invalid_at is not null then 'invalid'
                when exhausted_at is not null and (retry_at is null or retry_at > now())
                then 'exhausted' else 'live' end as status,
           to_char(retry_at, 'Mon DD') as retry_label,
           in_use
    from noelle.connections
    where org_id = ${orgId} and kind = 'apify' and active
    order by in_use desc,
             (invalid_at is null and (exhausted_at is null or retry_at <= now())) desc,
             invalid_at asc nulls first, exhausted_at asc nulls first, created_at asc
  `;
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    createdAt: r.created_at,
    exhaustedAt: r.exhausted_at,
    status: r.status,
    retryLabel: r.retry_label,
    inUse: r.in_use,
  }));
}

const loadApifySpendData = cache(async (orgId: string) => {
  const userId = await getRequiredUserId();
  await assertMember(orgId, userId);
  return readApifySpendData(sql, orgId);
});

/** Last successful provider balances survive invalidation and token removal. */
export async function getApifySpendByToken(orgId: string): Promise<ApifyTokenSpend[]> {
  await assertMember(orgId, await getRequiredUserId());
  const { snapshots, ledger } = await loadApifySpendData(orgId);
  return apifyTokenSpend(snapshots, ledger);
}

/** Calendar-range expenses use Apify's daily readings, counted once per account. */
export async function getApifyProviderSpend(orgId: string, startIso: string | null) {
  await assertMember(orgId, await getRequiredUserId());
  const { snapshots, ledger } = await loadApifySpendData(orgId);
  return summarizeApifyProviderSpend(snapshots, ledger, startIso);
}

/**
 * Add a single Apify token to the org's pool. It lands as SPARE (`in_use = false`) —
 * parked until the operator promotes it — so a freshly-pasted token never enters the
 * agents' rotation by surprise. Does NOT deactivate the existing tokens (stacking is
 * the point). Re-pasting a token already in the pool just re-arms its exhausted/
 * invalid flags and keeps its current bucket. Masked label for display; the raw
 * token lives only in `secret`. (Bulk paste uses {@link addApifyConnectionsBulk}.)
 */
export async function addApifyConnection(orgId: string, token: string): Promise<void> {
  await addApifyConnectionsBulk(orgId, [token]);
}

/** Shortest plausible Apify token — anything below this is treated as a typo/blank. */
const MIN_APIFY_TOKEN_LEN = 12;

/**
 * Parse a free-form paste into a clean list of candidate Apify tokens. Splits on any
 * whitespace, newline, or comma (so the operator can paste one-per-line, a CSV, or a
 * space-separated blob), trims each, drops blanks and anything shorter than
 * {@link MIN_APIFY_TOKEN_LEN}, and de-dupes (preserving first-seen order). Pure — no
 * DB, no I/O — so it's unit-testable on its own. `rejected` is the count of non-blank
 * fragments dropped for being too short, surfaced to the UI as "skipped".
 */
export function parseApifyTokens(raw: string): { tokens: string[]; rejected: number } {
  const fragments = raw
    .split(/[\s,]+/)
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
  const seen = new Set<string>();
  const tokens: string[] = [];
  let rejected = 0;
  for (const f of fragments) {
    if (f.length < MIN_APIFY_TOKEN_LEN) {
      rejected++;
      continue;
    }
    if (seen.has(f)) continue;
    seen.add(f);
    tokens.push(f);
  }
  return { tokens, rejected };
}

/** Outcome of a bulk add: how many new rows, how many were already in the pool. */
export interface ApifyBulkAddResult {
  added: number;
  alreadyPresent: number;
}

/**
 * Add many Apify tokens at once, each landing as SPARE (`in_use = false`) so the
 * agents don't touch them until the operator promotes one. Re-pasting a token that's
 * already in the pool re-arms its exhausted/invalid flags but does NOT change its
 * in-use bucket (so you can't accidentally demote a live token by re-pasting it).
 * One transaction. Caller is responsible for parsing/auth; pass already-clean tokens.
 */
export async function addApifyConnectionsBulk(
  orgId: string,
  tokens: string[],
): Promise<ApifyBulkAddResult> {
  let added = 0;
  let alreadyPresent = 0;
  if (tokens.length === 0) return { added, alreadyPresent };
  await sql.begin(async (tx) => {
    for (const token of tokens) {
      const label = token.length >= 8 ? `${token.slice(0, 4)}…${token.slice(-4)}` : "apify token";
      const existing = await tx<Array<{ id: string }>>`
        select id from noelle.connections
        where org_id = ${orgId} and kind = 'apify' and active and secret = ${token}
        limit 1
      `;
      if (existing[0]) {
        await tx`
          update noelle.connections
          set exhausted_at = null, retry_at = null, invalid_at = null, updated_at = now()
          where id = ${existing[0].id}
        `;
        alreadyPresent++;
      } else {
        await tx`
          insert into noelle.connections (org_id, kind, label, secret, active, in_use)
          values (${orgId}, 'apify', ${label}, ${token}, true, false)
        `;
        added++;
      }
    }
  });
  return { added, alreadyPresent };
}

/**
 * Move a token between the IN-USE and SPARE buckets — the manual promote/demote.
 * `inUse = true` puts it into the agents' rotation; `false` parks it. Org-scoped so
 * an id from another org can't be flipped. Spend history + exhausted/invalid flags
 * are untouched. Idempotent.
 */
export async function setApifyConnectionInUse(
  orgId: string,
  credentialId: string,
  inUse: boolean,
): Promise<void> {
  await sql`
    update noelle.connections set in_use = ${inUse}, updated_at = now()
    where id = ${credentialId} and org_id = ${orgId} and kind = 'apify' and active
  `;
}

/**
 * Remove a token from the org's Apify pool. Soft (active = false) so its spend
 * history (llm_calls.credential_id → connections) survives. Scoped by org so an id
 * from another org can't be touched.
 */
export async function removeApifyConnection(orgId: string, credentialId: string): Promise<void> {
  await sql`
    update noelle.connections set active = false, updated_at = now()
    where id = ${credentialId} and org_id = ${orgId} and kind = 'apify'
  `;
}

/** An org Apify token WITH its secret — server-only (the secret never leaves the server). */
export interface ApifyConnectionSecret {
  id: string;
  label: string;
  /** The raw token. NEVER return this to the client. */
  secret: string;
  /** Currently marked invalid (invalid_at not null) — the resurrect-on-alive target. */
  invalid: boolean;
}

/**
 * Load the org's ACTIVE Apify connections INCLUDING their secrets, for server-side
 * health-checking (the Test / Test-all actions). Mirrors listApifyConnections'
 * try-order but adds `secret` (and an `invalid` flag) — so it must stay server-only
 * and its result must never be returned to the client. Auth is enforced by the
 * caller (the action authorize() path); this is a plain DB read.
 */
export async function listApifyConnectionSecrets(orgId: string): Promise<ApifyConnectionSecret[]> {
  const rows = await readSql<
    Array<{ id: string; label: string; secret: string; invalid: boolean }>
  >`
    select id, label, secret, (invalid_at is not null) as invalid
    from noelle.connections
    where org_id = ${orgId} and kind = 'apify' and active
    order by (invalid_at is null and (exhausted_at is null or retry_at <= now())) desc,
             invalid_at asc nulls first, exhausted_at asc nulls first, created_at asc
  `;
  return rows.map((r) => ({ id: r.id, label: r.label, secret: r.secret, invalid: r.invalid }));
}

/**
 * Resurrect a token wrongly retired by a transient 401: clear invalid_at (and its
 * exhausted_at/retry_at siblings) so it re-enters the worker rotation cleanly.
 * Called from the Test action when checkApifyToken proves an invalid-marked token
 * is actually alive. Org-scoped; idempotent.
 */
export async function clearApifyConnectionInvalid(orgId: string, credentialId: string): Promise<void> {
  await sql`
    update noelle.connections
    set invalid_at = null, exhausted_at = null, retry_at = null, updated_at = now()
    where id = ${credentialId} and org_id = ${orgId} and kind = 'apify'
      and (invalid_at is not null or exhausted_at is not null)
  `;
}

export interface AgentActivityEvent {
  when: string;
  verb: string;
  what: string;
  cents: number | null;
  model: string | null;
  /** Live X permalink for a 'sent' row — Vega's reply on X. Null otherwise. */
  url: string | null;
}

/**
 * Recent activity for a single agent instance. Unions `noelle.llm_calls`
 * (one row per LLM invocation by any worker acting on this agent's role),
 * `noelle.approvals` (human decisions), and — for the X intern only —
 * `noelle.worker_runs` (heartbeat rows from each worker tick).
 *
 * Why worker_runs is in here: previously a discovery cycle that found
 * zero new tweets, or a drafter cycle that hit a code-path error before
 * reaching the LLM, left no llm_calls row. The feed went silent and the
 * founder saw nothing. With the worker_runs union, each tick shows up
 * as "06:30 · swept · 0 rows" so silent-but-running is distinguishable
 * from silent-because-broken.
 *
 * worker_runs is folded in only when `inst.role === 'x_intern'` because
 * the table is global (no `org_id`) and 0.0.1 only has one real x-intern.
 * For other agent roles, including them would attribute global ops noise
 * to an unrelated role.
 *
 * Tenancy guard piggybacks on `getAgentInstance(instanceId)`, which calls
 * `assertOrgMember` after fetching the row.
 */
export async function listRecentActivityForInstance(
  instanceId: string,
  limit = 12,
): Promise<AgentActivityEvent[]> {
  const inst = await getAgentInstance(instanceId);
  if (!inst) return [];

  const includeWorkerRuns = inst.role === "x_intern";

  const rows = await readSql<Array<{
    when_: string;
    verb: string;
    what: string;
    cents: number | null;
    model: string | null;
    sent_url: string | null;
    sent_external_id: string | null;
    author_handle: string | null;
  }>>`
    select * from (
      select
        l.started_at        as when_,
        case l.worker
          when 'drafter'    then 'drafted'
          when 'classifier' then 'classified'
          when 'discovery'  then 'discovered'
          when 'send'       then 'sent'
          else l.worker
        end                                       as verb,
        -- NEVER surface the engine (bedrock/vertex/codex) to users. The what
        -- column is unused for llm_call verbs (rowActivityFor hardcodes the
        -- detail); model is the raw id, cleaned to a user-safe name in the map.
        ''                                        as what,
        l.cents                                   as cents,
        l.model                                   as model,
        null::text                                as sent_url,
        null::text                                as sent_external_id,
        null::text                                as author_handle
      from noelle.llm_calls l
      where l.org_id = ${inst.org_id} and l.agent_role = ${inst.role}
      union all
      select
        a.decided_at                              as when_,
        case a.status
          when 'sent'    then 'sent'
          when 'skipped' then 'skipped'
          else a.status
        end                                       as verb,
        'reply ' || left(a.draft_id::text, 8)
          || coalesce(' · ' || a.skip_reason, '') as what,
        null::int                                 as cents,
        null::text                                as model,
        -- For 'sent' rows: the pieces the JS sentReplyUrl() helper turns into
        -- a live X permalink to Vega's reply (the post with the reply in it).
        d.payload->>'sent_url'                    as sent_url,
        d.sent_external_id                        as sent_external_id,
        l.payload->>'author_handle'               as author_handle
      from noelle.approvals a
      left join noelle.drafts d on d.id = a.draft_id
      left join noelle.leads  l on l.id = d.lead_id
      where a.agent_instance_id = ${inst.id}
        and a.status in ('sent', 'skipped')
        and a.decided_at is not null
      union all
      select
        coalesce(w.finished_at, w.started_at)     as when_,
        case
          when w.error is not null then 'errored'
          when w.worker = 'discovery'  then 'swept'
          when w.worker = 'classifier' then 'screened'
          when w.worker = 'drafter'    then 'cycled'
          when w.worker = 'send'       then 'posted'
          else w.worker
        end                                       as verb,
        case
          when w.error is not null
            then w.worker || ' · ' || left(w.error, 80)
          else w.worker || ' · '
               || coalesce(w.rows_processed, 0) || ' row'
               || case when coalesce(w.rows_processed, 0) = 1 then '' else 's' end
        end                                       as what,
        null::int                                 as cents,
        null::text                                as model,
        null::text                                as sent_url,
        null::text                                as sent_external_id,
        null::text                                as author_handle
      from noelle.worker_runs w
      where ${includeWorkerRuns}
    ) t
    where t.when_ is not null
    order by t.when_ desc
    limit ${limit}
  `;

  return rows.map((r) => ({
    when: r.when_,
    verb: r.verb,
    // Worker error rows carry the raw backend-prefixed message (e.g.
    // "drafter · vertex 503: …") — scrub the backend token before it can
    // reach any feed. Other `what` values contain no backend tokens.
    what: scrubBackendTokens(r.what),
    cents: r.cents,
    // Clean, engine-free model name (e.g. "Sonnet 4.6"); null for any model
    // we don't surface — the raw engine/id never reaches the UI.
    model: cleanModelLabel(r.model),
    // Live X permalink for sent replies (null for every other row).
    url: sentReplyUrl({
      sentUrl: r.sent_url,
      sentExternalId: r.sent_external_id,
      authorHandle: r.author_handle,
    }),
  }));
}

export interface AutoSendQueueRow {
  approvalId: string;
  draftId: string;
  leadId: string;
  targetAt: string;
  createdAt: string;
  authorHandle: string | null;
  bodyPreview: string | null;
  charCount: number | null;
}

/**
 * Auto-send queue for a single agent instance — pending approvals whose
 * drafter stamped `auto_send_target_at`. Ordered by target time so the
 * agent panel can render "next up in 4m 12s · …".
 *
 * Tenancy: piggybacks on `getAgentInstance` (assertOrgMember inside).
 * Reads off the partial index `approvals_auto_send_due_idx`.
 */
export async function listAutoSendQueueForInstance(
  instanceId: string,
  limit = 20,
): Promise<AutoSendQueueRow[]> {
  const inst = await getAgentInstance(instanceId);
  if (!inst) return [];
  const rows = await readSql<
    Array<{
      approval_id: string;
      draft_id: string;
      lead_id: string;
      target_at: string;
      created_at: string;
      lead_payload: unknown;
      draft_payload: unknown;
    }>
  >`
    select
      a.id                        as approval_id,
      a.draft_id                  as draft_id,
      a.lead_id                   as lead_id,
      a.auto_send_target_at       as target_at,
      a.created_at                as created_at,
      l.payload                   as lead_payload,
      d.payload                   as draft_payload
    from noelle.approvals a
    left join noelle.drafts d on d.id = a.draft_id
    left join noelle.leads  l on l.id = d.lead_id
    where a.agent_instance_id = ${inst.id}
      and a.status = 'pending'
      and a.auto_send_target_at is not null
    order by a.auto_send_target_at asc
    limit ${limit}
  `;
  return rows.map((r) => {
    const lead = leadPayload({ payload: r.lead_payload } as NoelleLead);
    const draft = draftPayload({ payload: r.draft_payload } as NoelleDraft);
    const body = bodyForSelectedAngle(draft);
    return {
      approvalId: r.approval_id,
      draftId: r.draft_id,
      leadId: r.lead_id,
      targetAt: r.target_at,
      createdAt: r.created_at,
      authorHandle: lead.author_handle ?? null,
      bodyPreview: body ? truncate(body, 200) : null,
      charCount: draft.char_count ?? (body ? body.length : null),
    };
  });
}

/**
 * Default anti-flag ceilings the dashboard LABELS. The real limits live in the
 * x-intern worker env (AUTOSEND_MAX_PER_30MIN / AUTOSEND_MAX_PER_DAY) — those
 * env vars are undefined in apps/app, and the worker remains the sole enforcer.
 * These constants only render a "default ceiling" for the operator; a worker
 * override changing the true limit is cosmetic drift here, never a gate on a
 * real send. Keep in sync with apps/x-intern/src/env.ts if the defaults move.
 */
export const AUTOSEND_MAX_PER_30MIN_DEFAULT = 6;
export const AUTOSEND_MAX_PER_DAY_DEFAULT = 50;

export interface AutoSendUsage {
  /** Auto-sends this instance completed in the last rolling 30 minutes. */
  per30Min: number;
  /** Auto-sends this instance completed in the last rolling 24 hours. */
  perDay: number;
  /** Labelled default ceiling (worker env is the real enforcer). */
  per30MinCap: number;
  /** Labelled default ceiling (worker env is the real enforcer). */
  perDayCap: number;
}

/**
 * How many auto-sends this instance has actually completed recently, for the
 * autopilot panel's "within human-plausible velocity" readout. Counts only
 * `status='sent' AND decided_by='auto-send'` rows (the exact predicate the
 * worker's own rate brake uses), off the partial index
 * `approvals_decided_inst_idx`.
 *
 * FAIL-CLOSED: returns null when the instance can't be resolved / the caller
 * isn't a member (getAgentInstance runs assertOrgMember). The page also wraps
 * this in `.catch(() => null)`, and the panel HIDES the caps row on null — it
 * never renders "0 of N", which would fabricate headroom and mislead the
 * operator into thinking it's safe to walk away.
 */
export async function getAutoSendUsage(
  instanceId: string,
): Promise<AutoSendUsage | null> {
  const inst = await getAgentInstance(instanceId);
  if (!inst) return null;
  const rows = await readSql<Array<{ per30min: string | number; perday: string | number }>>`
    select
      count(*) filter (where decided_at >= now() - interval '30 minutes') as per30min,
      count(*)                                                            as perday
    from noelle.approvals
    where agent_instance_id = ${inst.id}
      and status = 'sent'
      and decided_by = 'auto-send'
      and decided_at >= now() - interval '24 hours'
  `;
  const r = rows[0];
  return {
    per30Min: r ? Number(r.per30min) : 0,
    perDay: r ? Number(r.perday) : 0,
    per30MinCap: AUTOSEND_MAX_PER_30MIN_DEFAULT,
    perDayCap: AUTOSEND_MAX_PER_DAY_DEFAULT,
  };
}

export interface SentApprovalRow {
  approvalId: string;
  draftId: string;
  leadId: string;
  decidedAt: string | null;
  decidedBy: string | null;
  /** true when `decided_by = 'auto-send'`. */
  autoSent: boolean;
  /**
   * How the reply reached X, as three distinct states the UI can label:
   *  - "auto":      the send worker auto-posted it (decided_by = 'auto-send').
   *  - "dashboard": you clicked Send in the inbox; Noelle posted it via your X
   *                 token and captured the real tweet id (so it has a link).
   *  - "manual_x":  you posted it yourself on X by hand, then marked it sent —
   *                 no captured tweet id unless you pasted the link.
   */
  sendMethod: "auto" | "dashboard" | "manual_x";
  postedAt: string | null;
  /** Live X URL — present iff send worker wrote sent_external_id back. */
  postUrl: string | null;
  authorHandle: string | null;
  bodyPreview: string | null;
  charCount: number | null;
}

/**
 * Recently-sent approvals for an agent instance. Includes the live X URL
 * (built from `drafts.sent_external_id` if not already in payload) so the
 * agent panel can render "Posted to X →" deeplinks instead of asking the
 * operator to take it on faith. Ordered newest-first by `decided_at`.
 */
export async function listRecentSentForInstance(
  instanceId: string,
  limit = 12,
): Promise<SentApprovalRow[]> {
  const inst = await getAgentInstance(instanceId);
  if (!inst) return [];
  const rows = await readSql<
    Array<{
      approval_id: string;
      draft_id: string;
      lead_id: string;
      decided_at: string | null;
      decided_by: string | null;
      sent_external_id: string | null;
      posted_at: string | null;
      lead_payload: unknown;
      draft_payload: unknown;
    }>
  >`
    select
      a.id                        as approval_id,
      a.draft_id                  as draft_id,
      a.lead_id                   as lead_id,
      a.decided_at                as decided_at,
      a.decided_by                as decided_by,
      d.sent_external_id          as sent_external_id,
      d.posted_at                 as posted_at,
      l.payload                   as lead_payload,
      d.payload                   as draft_payload
    from noelle.approvals a
    left join noelle.drafts d on d.id = a.draft_id
    left join noelle.leads  l on l.id = d.lead_id
    where a.agent_instance_id = ${inst.id}
      and a.status = 'sent'
    order by a.decided_at desc nulls last, a.updated_at desc
    limit ${limit}
  `;
  return rows.map((r) => {
    const lead = leadPayload({ payload: r.lead_payload } as NoelleLead);
    const draft = draftPayload({ payload: r.draft_payload } as NoelleDraft);
    const body = bodyForSelectedAngle(draft);
    const handle = lead.author_handle ?? null;
    const postUrl = sentReplyUrl({
      sentUrl: draft.sent_url,
      sentExternalId: r.sent_external_id,
      authorHandle: handle,
    });
    // A hand-posted (mark-sent) reply is tagged either by the 'manual:' tweet-id
    // sentinel or payload.sent_via='manual'. Anything else with a human decider
    // is a dashboard send (real tweet id captured → has a link).
    const autoSent = r.decided_by === "auto-send";
    const sentVia = (r.draft_payload as { sent_via?: unknown } | null)?.sent_via;
    const manualX =
      sentVia === "manual" || (r.sent_external_id?.startsWith("manual:") ?? false);
    const sendMethod: SentApprovalRow["sendMethod"] = autoSent
      ? "auto"
      : manualX
        ? "manual_x"
        : "dashboard";
    return {
      approvalId: r.approval_id,
      draftId: r.draft_id,
      leadId: r.lead_id,
      decidedAt: r.decided_at,
      decidedBy: r.decided_by,
      autoSent,
      sendMethod,
      postedAt: r.posted_at,
      postUrl,
      authorHandle: handle,
      bodyPreview: body ? truncate(body, 240) : null,
      charCount: draft.char_count ?? (body ? body.length : null),
    };
  });
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + "…";
}

const normHandle = (h: string) => h.trim().toLowerCase().replace(/^@/, "");

// ── Watchlist person relationship view ──────────────────────────────────────

export interface WatchlistProfileView {
  handle: string;
  summary: string | null;
  topics: string[];
  tone: string | null;
  engagementNotes: string | null;
  postsAnalyzed: number;
  generatedAt: string | null;
}

export interface PersonStats {
  postsSeen: number;
  repliesSent: number;
  pendingReplies: number;
  lastInteractionAt: string | null;
  topTopics: string[];
}

export interface PersonInteraction {
  approvalId: string;
  status: string;
  decidedAt: string | null;
  kind: string | null;
  bodyPreview: string | null;
  /** Full draft text (un-truncated) — used to copy/send a parked DM. */
  body: string | null;
  /** Recipient's numeric X id (leads.author_id) — opens the X DM composer. */
  recipientId: string | null;
  /**
   * The ORIGINAL post the reply/DM is queued against (the lead's tweet). Built
   * from `leads.external_id` + `leads.author_handle` — both present the moment
   * discovery writes the lead, so this resolves for `pending` rows too. This is
   * the link the reviewer actually wants ("the post with a reply ready"). NULL
   * only when the lead row or its author handle is missing.
   */
  sourcePostUrl: string | null;
  /**
   * The LIVE reply once Vega has posted it (`drafts.sent_external_id`). NULL for
   * pending/skipped rows and for manually-dispatched replies.
   */
  postUrl: string | null;
}

/**
 * Build the x.com permalink for a post from its author handle + tweet id.
 * Used for both the source post (`leads.external_id`) and the sent reply
 * (`drafts.sent_external_id`). Returns null when either piece is missing or the
 * id is a `manual:` sentinel (hand-posted, no real tweet id).
 */
function xPostUrl(handle: string | null | undefined, tweetId: string | null | undefined): string | null {
  if (!handle || !tweetId) return null;
  if (tweetId.startsWith("manual:")) return null;
  return `https://x.com/${handle}/status/${tweetId}`;
}

/**
 * Shape one joined approval row into a `PersonInteraction`. Used by the
 * org-scoped `listPersonInteractionsForOrg` reader so the source/reply URL logic
 * lives in exactly one place.
 */
function toPersonInteraction(r: {
  approval_id: string;
  status: string;
  decided_at: string | null;
  sent_external_id: string | null;
  lead_external_id: string | null;
  lead_author_handle: string | null;
  lead_author_id: string | null;
  lead_payload: unknown;
  draft_payload: unknown;
}): PersonInteraction {
  const lead = leadPayload({ payload: r.lead_payload } as NoelleLead);
  const draft = draftPayload({ payload: r.draft_payload } as NoelleDraft);
  const body = bodyForSelectedAngle(draft);
  // Prefer the columns (always populated by discovery) over the jsonb payload,
  // which doesn't carry post_id/external_id.
  const authorHandle = r.lead_author_handle ?? lead.author_handle ?? null;
  const sourcePostUrl =
    lead.originalPostUrl ?? xPostUrl(authorHandle, r.lead_external_id);
  const postUrl = draft.sent_url ?? xPostUrl(authorHandle, r.sent_external_id);
  return {
    approvalId: r.approval_id,
    status: r.status,
    decidedAt: r.decided_at,
    kind: draft.kind ?? "reply",
    bodyPreview: body ? truncate(body, 200) : null,
    body: body ?? null,
    recipientId: r.lead_author_id ?? lead.author_id ?? null,
    sourcePostUrl,
    postUrl,
  };
}

interface PersonInteractionRaw {
  approval_id: string;
  status: string;
  decided_at: string | null;
  created_at: string;
  sent_external_id: string | null;
  lead_id: string | null;
  lead_external_id: string | null;
  lead_author_handle: string | null;
  lead_author_id: string | null;
  lead_payload: unknown;
  draft_payload: unknown;
}

// ── Contacts CRM (org-scoped persons) ───────────────────────────────────────

export interface PersonSocialAccountView {
  platform: SocialPlatform;
  handle: string | null;
  url: string | null;
}

export interface PersonListItem {
  id: string;
  displayName: string;
  xHandle: string | null;
  /** LinkedIn public_id (vanity slug), when the contact has a LinkedIn account. */
  linkedinHandle: string | null;
  platforms: SocialPlatform[];
  repliesSent: number;
  pendingReplies: number;
  lastInteractionAt: string | null;
  /**
   * Display names of the agents that watch this contact — across BOTH the X
   * (x_watchlist_people) and LinkedIn (linkedin_watchlist_people) watchlists.
   * Empty = not on any watchlist. Drives the "Watched" badge + filter so
   * Contacts is the single combined view of persons + watchlist.
   */
  watchedBy: string[];
}

export interface PersonDetail {
  id: string;
  displayName: string;
  notes: string | null;
  accounts: PersonSocialAccountView[];
  xHandle: string | null;
  /** LinkedIn public_id (vanity slug), when the contact has a LinkedIn account. */
  linkedinHandle: string | null;
}

/** display_name, else the X handle, else a stable fallback. */
function personDisplayName(displayName: string | null, xHandle: string | null): string {
  return displayName?.trim() || (xHandle ? `@${xHandle}` : "Unknown contact");
}

/**
 * Per-handle interaction rollup for an org, keyed by lowercased X handle. One
 * query feeds both the contacts list (join in JS) and is cheap because
 * approvals is indexed on org_id. NULL author handles are skipped.
 */
async function orgHandleStats(orgId: string): Promise<
  Map<string, { repliesSent: number; pendingReplies: number; lastInteractionAt: string | null }>
> {
  const rows = await readSql<
    Array<{
      handle: string;
      replies_sent: number;
      pending_replies: number;
      last_interaction: string | null;
    }>
  >`
    select
      lower(l.author_handle) as handle,
      count(*) filter (where a.status = 'sent')::int    as replies_sent,
      count(*) filter (where a.status = 'pending')::int as pending_replies,
      max(a.decided_at) filter (where a.status = 'sent') as last_interaction
    from noelle.approvals a
    join noelle.leads l on l.id = a.lead_id
    where a.org_id = ${orgId} and l.author_handle is not null
    group by lower(l.author_handle)
  `;
  const m = new Map<string, { repliesSent: number; pendingReplies: number; lastInteractionAt: string | null }>();
  for (const r of rows) {
    m.set(r.handle, {
      repliesSent: r.replies_sent,
      pendingReplies: r.pending_replies,
      lastInteractionAt: r.last_interaction,
    });
  }
  return m;
}

/**
 * For each watched handle in an org, the display names of the agents that watch
 * it — unioning the X watchlist (keyed by handle) and the LinkedIn watchlist
 * (keyed by public_id). A CRM person's 'x' account handle matches the former and
 * its 'linkedin' account handle (= public_id) the latter, so the contacts list
 * can flag who is watched on either platform without per-person round-trips.
 */
async function orgWatchersByHandle(orgId: string): Promise<Map<string, string[]>> {
  const rows = await readSql<Array<{ handle: string; agent_name: string | null }>>`
    select lower(wp.handle) as handle, ai.display_name as agent_name
    from noelle.x_watchlist_people wp
    join noelle.agent_instances ai on ai.id = wp.agent_instance_id
    where wp.org_id = ${orgId}
    union all
    select lower(lp.public_id) as handle, ai.display_name as agent_name
    from noelle.linkedin_watchlist_people lp
    join noelle.agent_instances ai on ai.id = lp.agent_instance_id
    where lp.org_id = ${orgId} and lp.public_id is not null
  `;
  const m = new Map<string, string[]>();
  for (const r of rows) {
    const name = r.agent_name?.trim() || "Agent";
    const list = m.get(r.handle);
    if (!list) m.set(r.handle, [name]);
    else if (!list.includes(name)) list.push(name);
  }
  return m;
}

/**
 * Self-heal the Contacts CRM: ensure every person an agent watches or has
 * actually replied to exists as a `noelle.persons` row. The Contacts page
 * lists `persons`, so anything that never got a person row is invisible there.
 *
 * Sources (idempotent — only handles without an account row are materialized):
 *   1. X watchlist people            → an 'x' account
 *   2. LinkedIn watchlist people     → a 'linkedin' account
 *   3. authors we SENT a reply to    → an account on the lead's platform
 *
 * "Engaged" deliberately means a SENT reply only — pending/skipped drafts don't
 * make someone a contact. This is the reconcile path the live `ensurePerson*`
 * write-hooks lean on: watchlists seeded straight into the DB (bypassing those
 * hooks) are healed here on the next contacts load, so the page can't drift.
 * Best-effort: a failure here must never blank the page, so callers swallow.
 */
export async function reconcileContactsForOrg(orgId: string): Promise<void> {
  const sb = await createSupabaseServerClient();
  const userId = await getRequiredUserId(sb);
  await assertMember(orgId, userId);

  // One idempotent pass: collect candidate (platform, handle, name, url) tuples
  // from every source, dedupe, drop any that already have an account, mint a
  // person + account for the rest. The person id is generated in-CTE so the
  // account insert can reference it without a second round-trip.
  await sql`
    with candidates as (
      select org_id, 'x'::text as platform, lower(handle) as handle,
             lower(handle) as display_name, null::text as url
      from noelle.x_watchlist_people
      where org_id = ${orgId} and handle is not null
      union all
      select l.org_id, 'x', lower(l.author_handle), lower(l.author_handle), null
      from noelle.approvals ap join noelle.leads l on l.id = ap.lead_id
      where ap.org_id = ${orgId} and ap.status = 'sent'
        and l.platform = 'x' and l.author_handle is not null
      union all
      select org_id, 'linkedin', lower(public_id),
             coalesce(nullif(name, ''), public_id),
             'https://www.linkedin.com/in/' || lower(public_id)
      from noelle.linkedin_watchlist_people
      where org_id = ${orgId} and public_id is not null
      union all
      select l.org_id, 'linkedin', lower(l.author_handle),
             coalesce(nullif(l.payload->>'authorName', ''), l.author_handle),
             'https://www.linkedin.com/in/' || lower(l.author_handle)
      from noelle.approvals ap join noelle.leads l on l.id = ap.lead_id
      where ap.org_id = ${orgId} and ap.status = 'sent'
        and l.platform = 'linkedin' and l.author_handle is not null
      union all
      -- 4. Account-Feeder STYLE SOURCES → a contact on the source's platform, so
      --    every account Lyra learns its writing style from shows up in Contacts
      --    (and the style-source card can link back to the Styles page).
      select s.org_id, s.platform, lower(s.handle),
             coalesce(nullif(s.display_name, ''), s.handle),
             case when s.platform = 'linkedin'
                  then 'https://www.linkedin.com/in/' || lower(s.handle)
                  else null end
      from noelle.account_feeder_sources s
      where s.org_id = ${orgId} and s.handle is not null
    ),
    -- LinkedIn vanity slugs often carry a trailing -<hex id> (e.g.
    -- kaia-tham-7bb065343) when the person has no custom vanity URL. The same
    -- human can be added once with the raw slug (a feeder source) and once with
    -- the clean vanity (kaia-tham, a watchlist contact) — two handles, one
    -- person. We dedupe/match LinkedIn on the SUFFIX-STRIPPED handle so they
    -- collapse to a single contact. X / Reddit have no such suffix and match
    -- exactly. Mirrors prettyHandle() in StyleSourceBadge.tsx.
    normed as (
      select org_id, platform, handle, display_name, url,
             case when platform = 'linkedin'
                  then regexp_replace(handle, '-[0-9a-f]{6,}$', '')
                  else handle end as norm_handle
      from candidates
    ),
    dedup as (
      -- One row per (org, platform, normalized handle). When the same person was
      -- supplied under both a clean and a suffixed handle, prefer the clean
      -- (shortest) one as the representative so the minted contact reads nicely.
      select distinct on (org_id, platform, norm_handle)
        org_id, platform, handle, norm_handle, display_name, url, gen_random_uuid() as new_id
      from normed
      order by org_id, platform, norm_handle, length(handle), display_name
    ),
    todo as (
      select d.* from dedup d
      where not exists (
        select 1 from noelle.person_social_accounts a
        where a.org_id = d.org_id and a.platform = d.platform
          and case when d.platform = 'linkedin'
                   then regexp_replace(lower(a.handle), '-[0-9a-f]{6,}$', '') = d.norm_handle
                   else lower(a.handle) = d.handle end
      )
    ),
    ins_persons as (
      insert into noelle.persons (id, org_id, display_name)
      select new_id, org_id, display_name from todo
      returning id
    )
    insert into noelle.person_social_accounts (org_id, person_id, platform, handle, url)
    select org_id, new_id, platform, handle, url from todo
  `;

  // Point any still-unlinked X watchlist rows at their freshly-minted person, so
  // the detail page's "Watched by" can match on person_id as well as handle.
  await sql`
    update noelle.x_watchlist_people wp
    set person_id = a.person_id
    from noelle.person_social_accounts a
    where wp.org_id = ${orgId} and wp.person_id is null
      and a.org_id = wp.org_id and a.platform = 'x'
      and lower(a.handle) = lower(wp.handle)
  `;
}

/** Interaction rollup for one handle (from orgHandleStats). */
export interface HandleInteractionStats {
  repliesSent: number;
  pendingReplies: number;
  lastInteractionAt: string | null;
}

/** A contact's interaction + watch rollup, summed across all their handles. */
export interface PersonRollup {
  repliesSent: number;
  pendingReplies: number;
  lastInteractionAt: string | null;
  watchedBy: string[];
}

/**
 * Roll a contact's interaction stats + watchers up across every handle they're
 * reachable on (X + LinkedIn), since both feed the same per-handle maps. Reply
 * counts sum, lastInteractionAt takes the most recent, and watchers union
 * (deduped) so an agent watching the same person on two platforms counts once.
 * Pure so it can be unit-tested without a DB.
 */
export function rollUpPersonInteractions(
  handleKeys: string[],
  stats: Map<string, HandleInteractionStats>,
  watchers: Map<string, string[]>,
): PersonRollup {
  let repliesSent = 0;
  let pendingReplies = 0;
  let lastInteractionAt: string | null = null;
  const watchedBy = new Set<string>();
  for (const key of handleKeys) {
    const s = stats.get(key);
    if (s) {
      repliesSent += s.repliesSent;
      pendingReplies += s.pendingReplies;
      if (s.lastInteractionAt && (!lastInteractionAt || s.lastInteractionAt > lastInteractionAt)) {
        lastInteractionAt = s.lastInteractionAt;
      }
    }
    for (const agent of watchers.get(key) ?? []) watchedBy.add(agent);
  }
  return { repliesSent, pendingReplies, lastInteractionAt, watchedBy: [...watchedBy] };
}

/** All contacts in an org, with their social accounts + interaction rollup. */
export async function listPersonsForOrg(orgId: string): Promise<PersonListItem[]> {
  const sb = await createSupabaseServerClient();
  const userId = await getRequiredUserId(sb);
  await assertMember(orgId, userId);

  const rows = await readSql<
    Array<{
      id: string;
      display_name: string | null;
      accounts: Array<{ platform: SocialPlatform; handle: string | null; url: string | null }>;
    }>
  >`
    select
      p.id,
      p.display_name,
      coalesce(
        json_agg(
          json_build_object('platform', a.platform, 'handle', a.handle, 'url', a.url)
          order by a.platform
        ) filter (where a.id is not null),
        '[]'
      ) as accounts
    from noelle.persons p
    left join noelle.person_social_accounts a on a.person_id = p.id
    where p.org_id = ${orgId}
    group by p.id, p.display_name
  `;
  const [stats, watchers] = await Promise.all([
    orgHandleStats(orgId),
    orgWatchersByHandle(orgId),
  ]);
  return rows
    .map((r) => {
      const accounts = Array.isArray(r.accounts) ? r.accounts : [];
      const xHandle = accounts.find((a) => a.platform === "x")?.handle ?? null;
      const linkedinHandle = accounts.find((a) => a.platform === "linkedin")?.handle ?? null;
      // A contact can be reachable on several platforms; roll the interaction
      // stats + watchers up across every linked handle so the row reflects all
      // of them (X reply counts + LinkedIn watch, etc.), not just the X one.
      const keys = accounts
        .map((a) => a.handle?.toLowerCase())
        .filter((h): h is string => Boolean(h));
      const rollup = rollUpPersonInteractions(keys, stats, watchers);
      return {
        id: r.id,
        displayName: personDisplayName(r.display_name, xHandle ?? linkedinHandle),
        xHandle,
        linkedinHandle,
        platforms: accounts.map((a) => a.platform),
        repliesSent: rollup.repliesSent,
        pendingReplies: rollup.pendingReplies,
        lastInteractionAt: rollup.lastInteractionAt,
        watchedBy: rollup.watchedBy,
      };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** One contact (id-scoped to the org) with its social accounts. */
export async function getPersonForOrg(orgId: string, personId: string): Promise<PersonDetail | null> {
  const sb = await createSupabaseServerClient();
  const userId = await getRequiredUserId(sb);
  await assertMember(orgId, userId);

  const rows = await readSql<
    Array<{
      id: string;
      display_name: string | null;
      notes: string | null;
      accounts: Array<{ platform: SocialPlatform; handle: string | null; url: string | null }>;
    }>
  >`
    select
      p.id,
      p.display_name,
      p.notes,
      coalesce(
        json_agg(
          json_build_object('platform', a.platform, 'handle', a.handle, 'url', a.url)
          order by a.platform
        ) filter (where a.id is not null),
        '[]'
      ) as accounts
    from noelle.persons p
    left join noelle.person_social_accounts a on a.person_id = p.id
    where p.id = ${personId} and p.org_id = ${orgId}
    group by p.id, p.display_name, p.notes
    limit 1
  `;
  const r = rows[0];
  if (!r) return null;
  const accounts = Array.isArray(r.accounts) ? r.accounts : [];
  const xHandle = accounts.find((a) => a.platform === "x")?.handle ?? null;
  const linkedinHandle = accounts.find((a) => a.platform === "linkedin")?.handle ?? null;
  return {
    id: r.id,
    displayName: personDisplayName(r.display_name, xHandle ?? linkedinHandle),
    notes: r.notes,
    accounts,
    xHandle,
    linkedinHandle,
  };
}

/** One agent that has a contact on its always-reply watchlist. */
export interface PersonWatcher {
  /**
   * Which watchlist this row lives on. 'x' rows are editable inline (objective
   * kind + remove); 'linkedin' rows are read-only here (Lyra's objective is
   * free-text and managed on her own watchlist page).
   */
  platform: "x" | "linkedin";
  /** x_watchlist_people.id / linkedin_watchlist_people.id — used by row actions. */
  watchlistRowId: string;
  agentInstanceId: string;
  agentName: string;
  agentRole: string;
  objectiveKind: WatchlistObjectiveKind | null;
  objectiveNote: string | null;
  addedAt: string;
}

/**
 * The agents that watch a contact, so the Contacts detail can show + edit
 * watchlist membership in one place — Contacts is the single person surface.
 * Unions the X watchlist (matched on the CRM `person_id` link, or the X handle
 * as a fallback for legacy rows that predate the link) and the LinkedIn
 * watchlist (matched via the person's 'linkedin' account = public_id, so a
 * dual-platform contact still surfaces a LinkedIn watcher). Tenancy piggybacks
 * on the page's earlier asserted read (getPersonForOrg) on the same request,
 * like the sibling getPersonProfileForOrg/getPersonStatsForOrg.
 */
export async function getWatchersForPerson(
  orgId: string,
  personId: string,
  handle?: string | null,
): Promise<PersonWatcher[]> {
  const h = handle ? normHandle(handle) : null;
  const rows = await readSql<
    Array<{
      platform: "x" | "linkedin";
      watchlist_row_id: string;
      agent_instance_id: string;
      agent_name: string | null;
      agent_role: string;
      objective_kind: WatchlistObjectiveKind | null;
      objective_note: string | null;
      added_at: string;
    }>
  >`
    select
      'x'                  as platform,
      wp.id                as watchlist_row_id,
      wp.agent_instance_id as agent_instance_id,
      ai.display_name      as agent_name,
      ai.role              as agent_role,
      wp.objective_kind    as objective_kind,
      wp.objective_note    as objective_note,
      wp.added_at          as added_at
    from noelle.x_watchlist_people wp
    join noelle.agent_instances ai on ai.id = wp.agent_instance_id
    where wp.org_id = ${orgId}
      and (wp.person_id = ${personId} or lower(wp.handle) = ${h})
    union all
    select
      'linkedin'           as platform,
      lp.id                as watchlist_row_id,
      lp.agent_instance_id as agent_instance_id,
      ai.display_name      as agent_name,
      ai.role              as agent_role,
      null::text           as objective_kind,
      lp.objective         as objective_note,
      lp.added_at          as added_at
    from noelle.linkedin_watchlist_people lp
    join noelle.agent_instances ai on ai.id = lp.agent_instance_id
    join noelle.person_social_accounts a
      on a.org_id = lp.org_id and a.platform = 'linkedin'
      and lower(a.handle) = lower(lp.public_id)
    where lp.org_id = ${orgId} and a.person_id = ${personId}
    order by added_at asc
  `;
  return rows.map((r) => ({
    platform: r.platform,
    watchlistRowId: r.watchlist_row_id,
    agentInstanceId: r.agent_instance_id,
    agentName: r.agent_name?.trim() || "Agent",
    agentRole: r.agent_role,
    objectiveKind: r.objective_kind,
    objectiveNote: r.objective_note,
    addedAt: r.added_at,
  }));
}

/**
 * Resolve the Contacts person id for an X handle in an org, if one exists.
 * Lets the approvals detail page deep-link a lead's author into the Contacts
 * CRM. Tenancy: the caller already ran an asserted read on the same request
 * (the approvals page loads the approval via getApprovalDetail → assertMember).
 */
export async function getPersonIdForHandle(orgId: string, handle: string): Promise<string | null> {
  const h = normHandle(handle);
  const rows = await readSql<Array<{ person_id: string }>>`
    select person_id
    from noelle.person_social_accounts
    where org_id = ${orgId} and platform = 'x' and lower(handle) = ${h}
    limit 1
  `;
  return rows[0]?.person_id ?? null;
}

/**
 * The most-recent profiler-built profile for a handle across ANY of the org's
 * agent instances (x_watchlist_profiles is per-instance; we collapse to the
 * freshest for the org-level contact view).
 */
export async function getPersonProfileForOrg(
  orgId: string,
  handle: string,
): Promise<WatchlistProfileView | null> {
  const h = normHandle(handle);
  const rows = await readSql<
    Array<{
      handle: string;
      summary: string | null;
      topics: unknown;
      tone: string | null;
      engagement_notes: string | null;
      posts_analyzed: number;
      generated_at: string | null;
    }>
  >`
    select pr.handle, pr.summary, pr.topics, pr.tone, pr.engagement_notes,
           pr.posts_analyzed, pr.generated_at
    from noelle.x_watchlist_profiles pr
    join noelle.agent_instances ai on ai.id = pr.agent_instance_id
    where ai.org_id = ${orgId} and pr.handle = ${h} and pr.summary is not null
    order by pr.generated_at desc nulls last
    limit 1
  `;
  const r = rows[0];
  if (!r || r.summary == null) return null;
  return {
    handle: r.handle,
    summary: r.summary,
    topics: Array.isArray(r.topics) ? (r.topics as string[]) : [],
    tone: r.tone,
    engagementNotes: r.engagement_notes,
    postsAnalyzed: r.posts_analyzed,
    generatedAt: r.generated_at,
  };
}

/**
 * The freshest LinkedIn profile the profiler built for a public_id across the
 * org's LinkedIn-intern instances — the Lyra counterpart to
 * getPersonProfileForOrg, reading linkedin_watchlist_profiles. Lets the Contacts
 * detail show "What Lyra knows" for a LinkedIn contact.
 */
export async function getLinkedInProfileForOrg(
  orgId: string,
  publicId: string,
): Promise<WatchlistProfileView | null> {
  const h = normHandle(publicId);
  const rows = await readSql<
    Array<{
      public_id: string;
      summary: string | null;
      topics: unknown;
      tone: string | null;
      engagement_notes: string | null;
      posts_analyzed: number;
      generated_at: string | null;
    }>
  >`
    select pr.public_id, pr.summary, pr.topics, pr.tone, pr.engagement_notes,
           pr.posts_analyzed, pr.generated_at
    from noelle.linkedin_watchlist_profiles pr
    join noelle.agent_instances ai on ai.id = pr.agent_instance_id
    where ai.org_id = ${orgId} and lower(pr.public_id) = ${h} and pr.summary is not null
    order by pr.generated_at desc nulls last
    limit 1
  `;
  const r = rows[0];
  if (!r || r.summary == null) return null;
  return {
    handle: r.public_id,
    summary: r.summary,
    topics: Array.isArray(r.topics) ? (r.topics as string[]) : [],
    tone: r.tone,
    engagementNotes: r.engagement_notes,
    postsAnalyzed: r.posts_analyzed,
    generatedAt: r.generated_at,
  };
}

/** Org-wide interaction stats for a handle (across every agent instance). */
export async function getPersonStatsForOrg(orgId: string, handle: string): Promise<PersonStats> {
  const h = normHandle(handle);
  const [leadAgg] = await readSql<Array<{ posts_seen: number }>>`
    select count(*)::int as posts_seen
    from noelle.leads
    where org_id = ${orgId} and lower(author_handle) = ${h}
  `;
  const topics = await readSql<Array<{ classifier_label: string }>>`
    select classifier_label
    from noelle.leads
    where org_id = ${orgId} and lower(author_handle) = ${h}
      and classifier_label is not null
    group by classifier_label
    order by count(*) desc
    limit 5
  `;
  const [apprAgg] = await readSql<
    Array<{ replies_sent: number; pending_replies: number; last_interaction: string | null }>
  >`
    select
      count(*) filter (where a.status = 'sent')::int    as replies_sent,
      count(*) filter (where a.status = 'pending')::int as pending_replies,
      max(a.decided_at) filter (where a.status = 'sent') as last_interaction
    from noelle.approvals a
    join noelle.leads l on l.id = a.lead_id
    where a.org_id = ${orgId} and lower(l.author_handle) = ${h}
  `;
  return {
    postsSeen: leadAgg?.posts_seen ?? 0,
    repliesSent: apprAgg?.replies_sent ?? 0,
    pendingReplies: apprAgg?.pending_replies ?? 0,
    lastInteractionAt: apprAgg?.last_interaction ?? null,
    topTopics: topics.map((t) => t.classifier_label),
  };
}

/** Org-wide interaction history for a handle, newest-first (any agent). */
export async function listPersonInteractionsForOrg(
  orgId: string,
  handle: string,
  limit = 30,
): Promise<PersonInteraction[]> {
  const h = normHandle(handle);
  const rows = await readSql<PersonInteractionRaw[]>`
    select
      a.id             as approval_id,
      a.lead_id        as lead_id,
      a.status         as status,
      a.decided_at     as decided_at,
      a.created_at     as created_at,
      d.sent_external_id as sent_external_id,
      l.external_id    as lead_external_id,
      l.author_handle  as lead_author_handle,
      l.author_id      as lead_author_id,
      l.payload        as lead_payload,
      d.payload        as draft_payload
    from noelle.approvals a
    left join noelle.drafts d on d.id = a.draft_id
    left join noelle.leads  l on l.id = a.lead_id
    where a.org_id = ${orgId} and lower(l.author_handle) = ${h}
    order by coalesce(a.decided_at, a.created_at) desc
    limit ${limit}
  `;
  // NOT grouped (unlike the per-instance history): the Contacts surface relies on
  // each DM row standing alone so a parked/deferred DM keeps its own "fire it now"
  // action. Collapsing per post would hide those.
  return rows.map((r) => toPersonInteraction(r));
}

/**
 * Spend (cents) charged to a single agent instance in the current calendar
 * month, for the Budget panel. Reads `noelle.llm_calls` directly (not
 * `org_spend_month`) because the rollup is org-level, not instance-level. Cheap
 * query — indexed on `(org_id, started_at desc)`.
 *
 * EXCLUDES `engine='apify'` — Apify is metered separately (the Connections card
 * shows per-token Apify spend, and the Spend page splits AI vs Apify), and the
 * budget *enforcement* already excludes it (see packages/runtime/src/pgBudgetAdapters.ts), so the
 * panel must match: the LinkedIn data fetch never counts against the LLM budget.
 */
export async function getInstanceSpendThisMonth(
  instanceId: string,
): Promise<number> {
  const inst = await getAgentInstance(instanceId);
  if (!inst) return 0;
  const rows = await readSql<Array<{ cents: number }>>`
    select coalesce(sum(cents), 0)::int as cents
    from noelle.llm_calls
    where org_id = ${inst.org_id}
      and agent_role = ${inst.role}
      and engine <> 'apify'
      and started_at >= date_trunc('month', now())
  `;
  return rows[0]?.cents ?? 0;
}

/**
 * Most-recent successful run for a worker, used by engagement status.
 *
 * Cloud SQL has `noelle.worker_runs` (not `sync_runs`). The `worker` column
 * holds 'discovery' | 'classifier' | 'drafter' | 'send'. Success is
 * inferred from `finished_at IS NOT NULL AND error IS NULL`.
 *
 * No `assertOrgMember`: `worker_runs` is a global ops table, not org-scoped.
 */
export async function getLastSyncRun(
  kind: "discovery" | "classifier" | "drafter" | "send",
): Promise<NoelleSyncRun | null> {
  const rows = await readSql<NoelleSyncRun[]>`
    select * from noelle.worker_runs
    where worker = ${kind}
      and finished_at is not null
      and error is null
    order by finished_at desc nulls last
    limit 1
  `;
  return rows[0] ?? null;
}

/**
 * Workers with an in-flight run right now. "In-flight" = `finished_at IS NULL`
 * AND `started_at` within the last 15 minutes — the bound discards crashed
 * runs whose heartbeat row was never closed.
 *
 * Returned set drives the pulsing dot on Vega's card so the founder can
 * actually see when a worker is doing something live.
 *
 * No `assertOrgMember`: `worker_runs` is a global ops table.
 */
export async function listActiveWorkers(): Promise<Set<"discovery" | "classifier" | "drafter" | "send">> {
  const rows = await readSql<Array<{ worker: "discovery" | "classifier" | "drafter" | "send" }>>`
    select distinct worker
    from noelle.worker_runs
    where finished_at is null
      and error is null
      and started_at > now() - interval '15 minutes'
  `;
  return new Set(rows.map((r) => r.worker));
}

// ── Shared memory bus reads ──────────────────────────────────────────────────
// Read side of the bus (noelle.bus_events + noelle.bus_state, migration 0032).
// Org-scoped + membership-guarded like every other read here. Powers a future
// in-product orchestration view and the live HTML generator.
// See docs/shared-memory-bus.md.

export interface DashboardBusEvent {
  id: string;
  agentInstanceId: string | null;
  agentRole: string;
  worker: string | null;
  topic: string;
  severity: string;
  summary: string | null;
  payload: Record<string, unknown>;
  correlationId: string | null;
  createdAt: string;
}

export interface DashboardBusStateEntry {
  bucket: string;
  key: string;
  value: unknown;
  version: number;
  updatedByWorker: string | null;
  updatedAt: string;
}

const toIso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : String(v);

/** Recent bus_events for an org, newest first. Optional topic/instance filter. */
export async function listBusEvents(
  orgId: string,
  opts: { topic?: string; instanceId?: string; limit?: number } = {},
): Promise<DashboardBusEvent[]> {
  const userId = await getRequiredUserId();
  await assertMember(orgId, userId);
  const limit = BusEventsQuerySchema.shape.limit.parse(
    Math.max(1, Math.min(Math.floor(opts.limit ?? 100), 500)),
  );
  const rows = await readSql<
    Array<{
      id: string;
      agent_instance_id: string | null;
      agent_role: string;
      worker: string | null;
      topic: string;
      severity: string;
      summary: string | null;
      payload: Record<string, unknown> | null;
      correlation_id: string | null;
      created_at: unknown;
    }>
  >`
    select id, agent_instance_id, agent_role, worker, topic,
           severity, summary, payload, correlation_id, created_at
    from noelle.bus_events
    where org_id = ${orgId}
      ${opts.topic ? sql`and topic = ${opts.topic}` : sql``}
      ${opts.instanceId ? sql`and agent_instance_id = ${opts.instanceId}` : sql``}
    order by created_at desc
    limit ${limit}
  `;
  return rows.map((r) => ({
    id: r.id,
    agentInstanceId: r.agent_instance_id,
    agentRole: r.agent_role,
    worker: r.worker,
    topic: r.topic,
    severity: r.severity,
    summary: r.summary,
    payload: r.payload ?? {},
    correlationId: r.correlation_id,
    createdAt: toIso(r.created_at),
  }));
}

/** Current-value bus_state for an org (unexpired), optionally one bucket. */
export async function getBusState(
  orgId: string,
  bucket?: string,
): Promise<DashboardBusStateEntry[]> {
  const userId = await getRequiredUserId();
  await assertMember(orgId, userId);
  const rows = await readSql<
    Array<{
      bucket: string;
      key: string;
      value: unknown;
      version: string | number;
      updated_by_worker: string | null;
      updated_at: unknown;
    }>
  >`
    select bucket, key, value, version, updated_by_worker, updated_at
    from noelle.bus_state
    where org_id = ${orgId}
      and (expires_at is null or expires_at > now())
      ${bucket ? sql`and bucket = ${bucket}` : sql``}
    order by bucket, key
  `;
  return rows.map((r) => ({
    bucket: r.bucket,
    key: r.key,
    value: r.value ?? null,
    version: Number(r.version), // bigint → string from postgres.js
    updatedByWorker: r.updated_by_worker,
    updatedAt: toIso(r.updated_at),
  }));
}

/**
 * Derived per-worker status for the Vega observability panel.
 *
 * `state` collapses the raw `worker_runs` history into the one word the
 * founder cares about:
 *   - "running"  — a row with `finished_at IS NULL` and `started_at` in
 *                  the last 15 minutes (matches `listActiveWorkers` so the
 *                  pulsing dot and this panel never disagree)
 *   - "stalled"  — `finished_at IS NULL` but `started_at` older than 15min
 *                  (the worker died mid-tick and never wrote its closer)
 *   - "errored"  — most-recent finished row has `error IS NOT NULL`
 *   - "idle"     — everything else
 *
 * `idleFor` is the seconds since the most recent `finished_at` (regardless
 * of error). It powers "Idle 14h — last error: codex oauth expired" lines.
 */
export type VegaWorkerKind = "discovery" | "classifier" | "drafter" | "send" | "profiler" | "watchlist";
export type VegaWorkerState = "running" | "idle" | "stalled" | "errored" | "disabled";

/** Per-worker enable flags (agent_instances.*_enabled). Absent = treat as on. */
export type WorkerEnabledMap = Partial<Record<VegaWorkerKind, boolean>>;

export interface VegaWorkerStatus {
  kind: VegaWorkerKind;
  state: VegaWorkerState;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastRowsProcessed: number | null;
  lastError: string | null;
  runningSince: string | null;
  idleForSeconds: number | null;
}

const VEGA_WORKERS: VegaWorkerKind[] = [
  "discovery",
  "classifier",
  "drafter",
  "send",
  "profiler",
];

const FIFTEEN_MIN_MS = 15 * 60 * 1000;

export interface VegaWorkerRow {
  worker: VegaWorkerKind;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_rows_processed: number | null;
  last_error: string | null;
  running_started_at: string | null;
}

/**
 * Pure derivation: takes the per-worker "latest finished" + "current
 * running" join rows and folds them into the four `VegaWorkerStatus`
 * entries the UI consumes. Extracted from `listVegaWorkerStatus` so unit
 * tests can pin the state-transition table without mocking postgres.
 */
export function deriveVegaWorkerStatus(
  rows: VegaWorkerRow[],
  nowMs: number = Date.now(),
  enabledByKind?: WorkerEnabledMap,
): VegaWorkerStatus[] {
  const byWorker = new Map(rows.map((r) => [r.worker, r] as const));
  return VEGA_WORKERS.map((kind) => {
    const r = byWorker.get(kind);
    const lastFinishedAt = r?.last_finished_at ?? null;
    const runningStartedAt = r?.running_started_at ?? null;

    let state: VegaWorkerState = "idle";
    if (runningStartedAt) {
      const ageMs = nowMs - new Date(runningStartedAt).getTime();
      state = ageMs < FIFTEEN_MIN_MS ? "running" : "stalled";
    } else if (r?.last_error) {
      state = "errored";
    }
    // A worker the operator deliberately turned off (per-worker flag = false)
    // reads as 'disabled', not idle/stalled/errored — so an intentional
    // off-switch isn't mistaken for a silent failure or ever-climbing idle. A
    // live in-flight run still wins (the worker is demonstrably doing work).
    if (enabledByKind && enabledByKind[kind] === false && state !== "running") {
      state = "disabled";
    }

    const idleForSeconds = lastFinishedAt
      ? Math.max(0, Math.floor((nowMs - new Date(lastFinishedAt).getTime()) / 1000))
      : null;

    return {
      kind,
      state,
      lastStartedAt: r?.last_started_at ?? null,
      lastFinishedAt,
      lastRowsProcessed: r?.last_rows_processed ?? null,
      lastError: r?.last_error ?? null,
      runningSince: state === "running" ? runningStartedAt : null,
      idleForSeconds,
    };
  });
}

/**
 * Per-worker status for Vega's status panel. Single query that picks the
 * most recent row per worker plus the most recent in-flight row, so we can
 * tell the founder "discovery is running right now" vs "drafter last
 * errored 14h ago" without firing four separate queries.
 *
 * No `assertOrgMember`: `worker_runs` is a global ops table.
 */
export async function listVegaWorkerStatus(
  enabledByKind?: WorkerEnabledMap,
): Promise<VegaWorkerStatus[]> {
  const rows = await readSql<VegaWorkerRow[]>`
    with latest as (
      select distinct on (worker)
        worker,
        started_at  as last_started_at,
        finished_at as last_finished_at,
        rows_processed as last_rows_processed,
        error       as last_error
      from noelle.worker_runs
      where finished_at is not null
      order by worker, finished_at desc
    ),
    running as (
      select distinct on (worker)
        worker,
        started_at as running_started_at
      from noelle.worker_runs
      where finished_at is null
      order by worker, started_at desc
    )
    select
      w.worker,
      l.last_started_at,
      l.last_finished_at,
      l.last_rows_processed,
      l.last_error,
      r.running_started_at
    from (values ('discovery'),('classifier'),('drafter'),('send'),('profiler')) w(worker)
    left join latest  l using (worker)
    left join running r using (worker)
  `;

  return deriveVegaWorkerStatus(rows, Date.now(), enabledByKind);
}

// ── Unified pipeline snapshot (live work + goal-run) ─────────────────────────

export interface PipelineWorkerSnapshot {
  kind: VegaWorkerKind;
  enabled: boolean;
  toggleable: boolean;
  // The profiler (0024) is decoupled from Start/Pause — it runs for paused
  // instances too — so the UI must not dim/disable it when the pipeline is
  // paused. The four pipeline workers are false (pause stops them).
  runsWhilePaused: boolean;
  state: VegaWorkerState;
  lifetime: number;
  today: number;
  sinceStart: number;
  lastFinishedAt: string | null;
  runningSince: string | null;
  /**
   * The reason a worker last failed (worker_runs.error), surfaced so the UI shows
   * "errored: Apify tokens exhausted" instead of a silent "stalled". Null when the
   * last run was clean.
   */
  lastError: string | null;
}

export interface PipelineSnapshot {
  status: string;
  pipelineStartedAt: string | null;
  /**
   * Distinct leads with at least one pending approval — i.e. leads waiting for
   * you to review/reply, NOT the raw approval-row count (a lead has a reply +
   * DM draft, so rows ≈ 4×). This is the human-facing "N leads ready" number.
   */
  leadsReady: number;
  /**
   * Distinct pending leads produced since the most recent goal-run started
   * (`goal_started_at`). Scopes the "Leads ready" card to the LAST run so a
   * small experiment isn't buried under leads piled up from earlier runs.
   * Null when this instance has never had a goal-run (no run boundary to
   * scope by — callers fall back to `leadsReady`).
   */
  leadsReadyLastRun: number | null;
  /** Start of the most recent goal-run, or null if there's never been one. */
  lastRunStartedAt: string | null;
  goal: {
    target: number | null;
    startedAt: string | null;
    produced: number;
    ready: number;
  };
  /**
   * The saved discovery default (agent_instances.discovery_config) used to
   * prefill the "Tailor this run" form. null when the intern doesn't support
   * run tailoring (e.g. the LinkedIn intern, which doesn't use Bird operators).
   */
  discoveryConfig: DiscoveryConfig | null;
  /**
   * The recurring scheduled run (0085_run_schedule.sql), or null when none is
   * armed. `nextAt` is the next fire time the api-vm scheduler triggers on
   * (null when disabled). Drives the Pipeline panel's Schedule block.
   */
  schedule: PipelineScheduleSnapshot | null;
  workers: PipelineWorkerSnapshot[];
}

export interface PipelineScheduleSnapshot {
  enabled: boolean;
  mode: "interval" | "daily";
  intervalHours: number | null;
  dailyTime: string | null;
  timezone: string;
  goal: number;
  nextAt: string | null;
}

/** Validate a raw discovery_config jsonb blob, defaulting bad/empty to {}. */
function parseDiscoveryConfig(raw: unknown): DiscoveryConfig {
  if (raw == null || typeof raw !== "object") return {};
  const res = DiscoveryConfigSchema.safeParse(raw);
  return res.success ? res.data : {};
}

/** Shape the saved run_schedule (+ next_at) for the panel. null = no schedule. */
function pipelineSchedule(inst: NoelleAgentInstance): PipelineScheduleSnapshot | null {
  const s = parseRunSchedule(inst.run_schedule);
  if (!s) return null;
  return {
    enabled: s.enabled,
    mode: s.mode,
    intervalHours: s.intervalHours ?? null,
    dailyTime: s.dailyTime ?? null,
    timezone: s.timezone,
    goal: s.goal,
    nextAt: inst.run_schedule_next_at,
  };
}

/**
 * One read powering the live Pipeline panel: instance status + goal-run state,
 * per-worker run state (worker_runs) and three count windows (lifetime / today /
 * since pipeline_started_at), plus the goal "ready/produced" numbers. Tenancy via
 * getAgentInstance (assertOrgMember).
 */
export async function getPipelineSnapshot(instanceId: string): Promise<PipelineSnapshot | null> {
  const inst = await getAgentInstance(instanceId);
  if (!inst) return null;
  const since = inst.pipeline_started_at ?? "1970-01-01T00:00:00Z";
  const goalStart = inst.goal_started_at ?? "1970-01-01T00:00:00Z";

  const [leads] = await readSql<
    Array<{ disc_life: number; disc_today: number; disc_since: number; cls_life: number; cls_today: number; cls_since: number }>
  >`
    select
      count(*)::int as disc_life,
      count(*) filter (where created_at >= date_trunc('day', now()))::int as disc_today,
      count(*) filter (where created_at >= ${since})::int as disc_since,
      count(*) filter (where classifier_label is not null)::int as cls_life,
      count(*) filter (where classifier_label is not null and created_at >= date_trunc('day', now()))::int as cls_today,
      count(*) filter (where classifier_label is not null and created_at >= ${since})::int as cls_since
    from noelle.leads where agent_instance_id = ${inst.id}
      and coalesce(nullif(payload->>'post_kind', ''), payload->>'postKind', '') not in ('intro_dm', 'relationship_dm')
      and external_id not like '%:intro%'
  `;
  const [drafts] = await readSql<Array<{ life: number; today: number; since: number }>>`
    select
      count(distinct l.id)::int as life,
      count(distinct l.id) filter (where d.synced_at >= date_trunc('day', now()))::int as today,
      count(distinct l.id) filter (where d.synced_at >= ${since})::int as since
    from noelle.drafts d join noelle.leads l on l.id = d.lead_id
    where l.agent_instance_id = ${inst.id}
      and coalesce(d.payload->>'kind', 'reply') = 'reply'
      and coalesce(nullif(l.payload->>'post_kind', ''), l.payload->>'postKind', '') not in ('intro_dm', 'relationship_dm')
      and l.external_id not like '%:intro%'
  `;
  const [appr] = await readSql<
    Array<{
      sent_life: number;
      sent_today: number;
      sent_since: number;
      leads_ready: number;
      leads_ready_run: number;
      produced: number;
    }>
  >`
    select
      count(distinct a.lead_id) filter (where a.status = 'sent')::int as sent_life,
      count(distinct a.lead_id) filter (where a.status = 'sent' and a.decided_at >= date_trunc('day', now()))::int as sent_today,
      count(distinct a.lead_id) filter (where a.status = 'sent' and a.decided_at >= ${since})::int as sent_since,
      count(distinct a.lead_id) filter (where a.status = 'pending')::int as leads_ready,
      count(distinct a.lead_id) filter (where a.status = 'pending' and a.created_at >= ${goalStart})::int as leads_ready_run,
      count(distinct a.lead_id) filter (where a.created_at >= ${goalStart})::int as produced
    from noelle.approvals a
    join noelle.drafts d on d.id = a.draft_id and d.lead_id = a.lead_id
    join noelle.leads l on l.id = a.lead_id
    where a.agent_instance_id = ${inst.id}
      and coalesce(d.payload->>'kind', 'reply') = 'reply'
      and coalesce(nullif(l.payload->>'post_kind', ''), l.payload->>'postKind', '') not in ('intro_dm', 'relationship_dm')
      and l.external_id not like '%:intro%'
  `;
  const [profiles] = await readSql<Array<{ life: number; today: number; since: number }>>`
    select
      count(*) filter (where summary is not null)::int as life,
      count(*) filter (where summary is not null and generated_at >= date_trunc('day', now()))::int as today,
      count(*) filter (where summary is not null and generated_at >= ${since})::int as since
    from noelle.x_watchlist_profiles where agent_instance_id = ${inst.id}
  `;
  // Watchlist lane "produced" count = distinct watched-people posts that got a
  // reply draft (one per person), not raw angle rows.
  const [wdrafts] = await readSql<Array<{ life: number; today: number; since: number }>>`
    select
      count(distinct l.id)::int as life,
      count(distinct l.id) filter (where d.synced_at >= date_trunc('day', now()))::int as today,
      count(distinct l.id) filter (where d.synced_at >= ${since})::int as since
    from noelle.drafts d join noelle.leads l on l.id = d.lead_id
    where l.agent_instance_id = ${inst.id} and l.priority = true
      and coalesce(d.payload->>'kind','reply') = 'reply'
      and coalesce(nullif(l.payload->>'post_kind', ''), l.payload->>'postKind', '') not in ('intro_dm', 'relationship_dm')
      and l.external_id not like '%:intro%'
  `;

  const states = await listVegaWorkerStatus({
    discovery: inst.discovery_enabled,
    classifier: inst.classifier_enabled,
    drafter: inst.drafter_enabled,
    send: inst.send_enabled,
    profiler: inst.profiler_enabled,
  });
  const stateByKind = new Map(states.map((s) => [s.kind, s] as const));

  const counts: Record<VegaWorkerKind, { lifetime: number; today: number; sinceStart: number }> = {
    discovery: { lifetime: leads?.disc_life ?? 0, today: leads?.disc_today ?? 0, sinceStart: leads?.disc_since ?? 0 },
    classifier: { lifetime: leads?.cls_life ?? 0, today: leads?.cls_today ?? 0, sinceStart: leads?.cls_since ?? 0 },
    drafter: { lifetime: drafts?.life ?? 0, today: drafts?.today ?? 0, sinceStart: drafts?.since ?? 0 },
    send: { lifetime: appr?.sent_life ?? 0, today: appr?.sent_today ?? 0, sinceStart: appr?.sent_since ?? 0 },
    profiler: { lifetime: profiles?.life ?? 0, today: profiles?.today ?? 0, sinceStart: profiles?.since ?? 0 },
    watchlist: { lifetime: wdrafts?.life ?? 0, today: wdrafts?.today ?? 0, sinceStart: wdrafts?.since ?? 0 },
  };
  const enabledByKind: Record<VegaWorkerKind, boolean> = {
    discovery: inst.discovery_enabled,
    classifier: inst.classifier_enabled,
    drafter: inst.drafter_enabled,
    send: inst.send_enabled,
    profiler: inst.profiler_enabled,
    watchlist: inst.watchlist_enabled ?? true,
  };

  const workers: PipelineWorkerSnapshot[] = VEGA_WORKERS.map((kind) => {
    const s = stateByKind.get(kind);
    return {
      kind,
      enabled: enabledByKind[kind],
      toggleable: true,
      runsWhilePaused: kind === "profiler",
      state: s?.state ?? "idle",
      lifetime: counts[kind].lifetime,
      today: counts[kind].today,
      sinceStart: counts[kind].sinceStart,
      lastFinishedAt: s?.lastFinishedAt ?? null,
      runningSince: s?.runningSince ?? null,
      lastError: s?.lastError ?? null,
    };
  });
  // The always-on Watchlist lane has no worker_runs of its own — discovery /
  // classifier / drafter produce its replies — so mirror the drafter's freshness
  // and report the watched-people reply count. runsWhilePaused so it doesn't dim
  // when the keyword pipeline is paused (it's still working).
  {
    const ws = enabledByKind.watchlist;
    const ds = stateByKind.get("drafter");
    workers.push({
      kind: "watchlist",
      enabled: ws,
      toggleable: true,
      runsWhilePaused: true,
      state: ws ? ds?.state ?? "idle" : "disabled",
      lifetime: counts.watchlist.lifetime,
      today: counts.watchlist.today,
      sinceStart: counts.watchlist.sinceStart,
      lastFinishedAt: ds?.lastFinishedAt ?? null,
      runningSince: ds?.runningSince ?? null,
      // Synthetic lane (no worker_runs of its own); the real workers surface their
      // own failures on their rows, so this convenience row never shows an error.
      lastError: null,
    });
  }

  return {
    status: inst.status as string,
    pipelineStartedAt: inst.pipeline_started_at,
    leadsReady: appr?.leads_ready ?? 0,
    leadsReadyLastRun: inst.goal_started_at ? appr?.leads_ready_run ?? 0 : null,
    lastRunStartedAt: inst.goal_started_at,
    goal: {
      target: inst.goal_target,
      startedAt: inst.goal_started_at,
      produced: inst.goal_started_at ? appr?.produced ?? 0 : 0,
      // "currently waiting" matches the inbox + cap: distinct reply leads.
      ready: appr?.leads_ready ?? 0,
    },
    discoveryConfig: parseDiscoveryConfig(inst.discovery_config),
    schedule: pipelineSchedule(inst),
    workers,
  };
}

// LinkedIn intern (Lyra) is draft-only — no send worker. Her four stages match
// Vega's minus 'send': discovery → classifier → drafter (+ profiler).
const LINKEDIN_WORKERS: VegaWorkerKind[] = [
  "discovery",
  "classifier",
  "drafter",
  "profiler",
];

/**
 * Pipeline snapshot for the LinkedIn intern (Lyra) — the draft-only sibling of
 * getPipelineSnapshot. Same shape so it feeds the SAME <PipelinePanel> +
 * <LeadsReadyCard>, with three differences:
 *   1. NO 'send' worker (Lyra never posts to LinkedIn) — the funnel ends at the
 *      drafter, and "ready / produced" counts pending approvals only (no sent).
 *   2. The profiler count comes from noelle.linkedin_watchlist_profiles (the
 *      LinkedIn analogue of x_watchlist_profiles), keyed by fsd_profile_id.
 *   3. Lead/draft/approval COUNTS are scoped to this instance AND
 *      platform='linkedin' — accurate even if a future row shares the instance.
 *
 * Tenancy: getAgentInstance asserts org membership before any read.
 *
 * Worker-freshness limitation: noelle.worker_runs has only a `worker` (kind)
 * column — no agent_instance_id / org_id / platform discriminator — and Lyra's
 * workers (apps/linkedin-intern) record the SAME kinds ('discovery',
 * 'classifier', 'drafter', 'profiler') as Vega's. So the "ran Xm ago" / running
 * state per stage is derived GLOBALLY per-kind via listVegaWorkerStatus and, on
 * a host running both interns, may reflect Vega's most-recent run for the same
 * kind. The COUNTS above are always correctly scoped to LinkedIn; only the
 * freshness timestamps are best-effort until worker_runs carries an instance id.
 */
export async function getLinkedInPipelineSnapshot(
  instanceId: string,
): Promise<PipelineSnapshot | null> {
  const inst = await getAgentInstance(instanceId);
  if (!inst) return null;
  const since = inst.pipeline_started_at ?? "1970-01-01T00:00:00Z";
  const goalStart = inst.goal_started_at ?? "1970-01-01T00:00:00Z";

  const [leads] = await readSql<
    Array<{ disc_life: number; disc_today: number; disc_since: number; cls_life: number; cls_today: number; cls_since: number }>
  >`
    select
      count(*)::int as disc_life,
      count(*) filter (where created_at >= date_trunc('day', now()))::int as disc_today,
      count(*) filter (where created_at >= ${since})::int as disc_since,
      count(*) filter (where classifier_label is not null)::int as cls_life,
      count(*) filter (where classifier_label is not null and created_at >= date_trunc('day', now()))::int as cls_today,
      count(*) filter (where classifier_label is not null and created_at >= ${since})::int as cls_since
    from noelle.leads
    where agent_instance_id = ${inst.id} and platform = 'linkedin'
      and coalesce(nullif(payload->>'post_kind', ''), payload->>'postKind', '') not in ('intro_dm', 'relationship_dm')
      and external_id not like '%:intro%'
  `;
  const [drafts] = await readSql<Array<{ life: number; today: number; since: number }>>`
    select
      count(distinct l.id)::int as life,
      count(distinct l.id) filter (where d.synced_at >= date_trunc('day', now()))::int as today,
      count(distinct l.id) filter (where d.synced_at >= ${since})::int as since
    from noelle.drafts d join noelle.leads l on l.id = d.lead_id
    where l.agent_instance_id = ${inst.id} and l.platform = 'linkedin'
      and coalesce(d.payload->>'kind', 'reply') = 'reply'
      and coalesce(nullif(l.payload->>'post_kind', ''), l.payload->>'postKind', '') not in ('intro_dm', 'relationship_dm')
      and l.external_id not like '%:intro%'
  `;
  // Reply approvals only; the browser actor may mark replies sent. Count each
  // post once even when its lead has multiple reply angles or a companion DM.
  const [appr] = await readSql<
    Array<{
      leads_ready: number;
      leads_ready_run: number;
      produced: number;
    }>
  >`
    select
      count(distinct a.lead_id) filter (where a.status = 'pending')::int as leads_ready,
      count(distinct a.lead_id) filter (where a.status = 'pending' and a.created_at >= ${goalStart})::int as leads_ready_run,
      count(distinct a.lead_id) filter (where a.created_at >= ${goalStart})::int as produced
    from noelle.approvals a
    join noelle.drafts d on d.id = a.draft_id and d.lead_id = a.lead_id
    join noelle.leads l on l.id = a.lead_id
    where a.agent_instance_id = ${inst.id} and l.platform = 'linkedin'
      and coalesce(d.payload->>'kind', 'reply') = 'reply'
      and coalesce(nullif(l.payload->>'post_kind', ''), l.payload->>'postKind', '') not in ('intro_dm', 'relationship_dm')
      and l.external_id not like '%:intro%'
  `;
  const [profiles] = await readSql<Array<{ life: number; today: number; since: number }>>`
    select
      count(*) filter (where summary is not null)::int as life,
      count(*) filter (where summary is not null and generated_at >= date_trunc('day', now()))::int as today,
      count(*) filter (where summary is not null and generated_at >= ${since})::int as since
    from noelle.linkedin_watchlist_profiles where agent_instance_id = ${inst.id}
  `;
  // Watchlist lane "produced" count = distinct watched-connection posts that got a
  // reply draft (one per post). Unlike Vega, Lyra inserts every lead priority=false
  // (the classifier scores each post), and Lyra is watchlist-only — every lead is
  // already a watched-connection post — so there is NO priority filter here; the
  // count is simply Lyra's distinct non-DM reply-drafts.
  const [wdrafts] = await readSql<Array<{ life: number; today: number; since: number }>>`
    select
      count(distinct l.id)::int as life,
      count(distinct l.id) filter (where d.synced_at >= date_trunc('day', now()))::int as today,
      count(distinct l.id) filter (where d.synced_at >= ${since})::int as since
    from noelle.drafts d join noelle.leads l on l.id = d.lead_id
    where l.agent_instance_id = ${inst.id} and l.platform = 'linkedin'
      and coalesce(d.payload->>'kind','reply') = 'reply'
      and coalesce(nullif(l.payload->>'post_kind', ''), l.payload->>'postKind', '') not in ('intro_dm', 'relationship_dm')
      and l.external_id not like '%:intro%'
  `;

  // Best-effort per-kind freshness (global worker_runs — see the doc comment).
  const states = await listVegaWorkerStatus({
    discovery: inst.discovery_enabled,
    classifier: inst.classifier_enabled,
    drafter: inst.drafter_enabled,
    profiler: inst.profiler_enabled,
  });
  const stateByKind = new Map(states.map((s) => [s.kind, s] as const));

  const counts: Record<VegaWorkerKind, { lifetime: number; today: number; sinceStart: number }> = {
    discovery: { lifetime: leads?.disc_life ?? 0, today: leads?.disc_today ?? 0, sinceStart: leads?.disc_since ?? 0 },
    classifier: { lifetime: leads?.cls_life ?? 0, today: leads?.cls_today ?? 0, sinceStart: leads?.cls_since ?? 0 },
    drafter: { lifetime: drafts?.life ?? 0, today: drafts?.today ?? 0, sinceStart: drafts?.since ?? 0 },
    send: { lifetime: 0, today: 0, sinceStart: 0 },
    profiler: { lifetime: profiles?.life ?? 0, today: profiles?.today ?? 0, sinceStart: profiles?.since ?? 0 },
    watchlist: { lifetime: wdrafts?.life ?? 0, today: wdrafts?.today ?? 0, sinceStart: wdrafts?.since ?? 0 },
  };
  const enabledByKind: Record<VegaWorkerKind, boolean> = {
    discovery: inst.discovery_enabled,
    classifier: inst.classifier_enabled,
    drafter: inst.drafter_enabled,
    send: inst.send_enabled,
    profiler: inst.profiler_enabled,
    watchlist: inst.watchlist_enabled ?? true,
  };

  // Only the four LinkedIn stages — 'send' is intentionally omitted from the
  // funnel so the panel never renders a Send row for Lyra.
  const workers: PipelineWorkerSnapshot[] = LINKEDIN_WORKERS.map((kind) => {
    const s = stateByKind.get(kind);
    return {
      kind,
      enabled: enabledByKind[kind],
      toggleable: true,
      runsWhilePaused: kind === "profiler",
      state: s?.state ?? "idle",
      lifetime: counts[kind].lifetime,
      today: counts[kind].today,
      sinceStart: counts[kind].sinceStart,
      lastFinishedAt: s?.lastFinishedAt ?? null,
      runningSince: s?.runningSince ?? null,
      lastError: s?.lastError ?? null,
    };
  });
  // Lyra's always-on Watchlist lane (mirrors Vega). It has no worker_runs of its
  // own — discovery / classifier / drafter produce its replies — so it mirrors the
  // drafter's freshness and reports the watched-connection reply count.
  // runsWhilePaused so it stays bright (and keeps working) while the funnel is
  // paused. Pushed separately, after the four funnel stages, so it always renders
  // last regardless of LINKEDIN_WORKERS.
  {
    const ws = enabledByKind.watchlist;
    const ds = stateByKind.get("drafter");
    workers.push({
      kind: "watchlist",
      enabled: ws,
      toggleable: true,
      runsWhilePaused: true,
      state: ws ? ds?.state ?? "idle" : "disabled",
      lifetime: counts.watchlist.lifetime,
      today: counts.watchlist.today,
      sinceStart: counts.watchlist.sinceStart,
      lastFinishedAt: ds?.lastFinishedAt ?? null,
      runningSince: ds?.runningSince ?? null,
      // Synthetic lane (no worker_runs of its own); the real workers surface their
      // own failures on their rows, so this convenience row never shows an error.
      lastError: null,
    });
  }

  return {
    status: inst.status as string,
    pipelineStartedAt: inst.pipeline_started_at,
    leadsReady: appr?.leads_ready ?? 0,
    leadsReadyLastRun: inst.goal_started_at ? appr?.leads_ready_run ?? 0 : null,
    lastRunStartedAt: inst.goal_started_at,
    goal: {
      target: inst.goal_target,
      startedAt: inst.goal_started_at,
      produced: inst.goal_started_at ? appr?.produced ?? 0 : 0,
      ready: appr?.leads_ready ?? 0,
    },
    // Lyra's per-connection Apify sweep carries each post's posted-at + reaction
    // /comment counts, so the tailored run DOES apply (time window + engagement
    // floors + posts-per-connection). Same saved-default column as Vega; the
    // panel renders the LinkedIn-applicable subset of fields (no X search ops).
    discoveryConfig: parseDiscoveryConfig(inst.discovery_config),
    schedule: pipelineSchedule(inst),
    workers,
  };
}

/**
 * Whether at least one ACTIVE x_intern instance has the given worker enabled.
 * Used by the staleness banner so a deliberately-disabled worker doesn't read
 * as a silent sync failure. Global (no org scope), matching getLastSyncRun and
 * the dashboard-wide banner it feeds.
 */
export async function anyActiveXInternWorkerEnabled(
  worker: "discovery" | "classifier" | "drafter" | "send",
): Promise<boolean> {
  const col = {
    discovery: "discovery_enabled",
    classifier: "classifier_enabled",
    drafter: "drafter_enabled",
    send: "send_enabled",
  }[worker];
  const rows = await readSql<{ n: number }[]>`
    select count(*)::int as n
    from noelle.agent_instances
    where role = 'x_intern' and status = 'active' and ${sql(col)} = true
  `;
  return (rows[0]?.n ?? 0) > 0;
}

/**
 * Most recent worker_runs rows across all workers, for the activity feed
 * folding (so zero-result discovery cycles are visible — those produce a
 * worker_runs row but no llm_calls row, which is exactly the case where
 * the founder sees nothing happening today).
 *
 * No `assertOrgMember`: `worker_runs` is a global ops table.
 */
export async function listRecentWorkerRuns(limit = 20): Promise<NoelleSyncRun[]> {
  const rows = await readSql<NoelleSyncRun[]>`
    select *
    from noelle.worker_runs
    order by coalesce(finished_at, started_at) desc
    limit ${limit}
  `;
  return rows;
}

// ── LinkedIn intern (Lyra) — draft-only approvals ───────────────────────────
//
// The LinkedIn intern writes the SAME noelle.approvals / noelle.drafts /
// noelle.leads tables as the X intern, distinguished only by:
//   - agent_instances.role = 'linkedin_intern'
//   - leads.platform = 'linkedin'
//   - drafts.payload.kind ∈ {'reply','dm'} (no per-angle bundle quirks)
//
// Lyra NEVER posts to LinkedIn (no send worker, no X client). The approvals UI
// these readers feed is draft-only: copy + "Mark sent". The author name/headline
// live in noelle.linkedin_watchlist_people (the drafter's outbound overwrite
// drops them from leads.payload), so we join that in by author_id = fsd_profile_id.

/** The org's LinkedIn intern instance, if one is provisioned. Tenancy via assertMember. */
export const getLinkedInInternInstance = cache(async (
  orgId: string,
): Promise<NoelleAgentInstance | null> => {
  const userId = await getRequiredUserId();
  await assertMember(orgId, userId);
  const rows = await readSql<NoelleAgentInstance[]>`
    select * from noelle.agent_instances
    where org_id = ${orgId} and role = 'linkedin_intern'
    limit 1
  `;
  return rows[0] ?? null;
});

/**
 * Pattern Breaker alerts still actionable for an instance (open | refining |
 * refined), newest first, joined to the live rule text. Drives the approvals-
 * page popup. Org-scoped via the instance's org + assertMember (Cloud SQL has
 * no RLS). Explicit pages preserve continuation; unavailable owners reject.
 */
export type PatternAlertRow = StoredPatternAlertRow;
export type PatternRuleRow = PatternRulesPage["rules"][number];
async function authorizedPatternScope(instanceId: string): Promise<PatternScope | null> {
  const inst = await getAgentInstance(instanceId);
  if (!inst) return null;
  const userId = await getRequiredUserId();
  await assertMember(inst.org_id, userId);
  const scope = {
    orgId: inst.org_id,
    agentInstanceId: inst.id,
    role: inst.role as PatternScope["role"],
    userId,
  };
  return validPatternScope(scope) ? scope : null;
}
export async function listVisiblePatternAlerts(
  instanceId: string,
  input: PatternAlertsPageInput = {},
): Promise<StoredPatternAlertsPage> {
  const scope = await authorizedPatternScope(instanceId);
  if (!scope) throw new Error("Current pattern owner is unavailable");
  return loadVisibleAlerts({ query: readSql, fragments: sql }, scope, input);
}
/** Explicit bounded pages preserve continuation for active and disabled rule history. */
export async function listPatternRules(
  instanceId: string,
  input: PatternRulesPageInput = {},
): Promise<PatternRulesPage> {
  const scope = await authorizedPatternScope(instanceId);
  if (!scope) throw new Error("Current pattern owner is unavailable");
  return readPatternRules({ query: readSql, fragments: sql }, scope, input);
}
export async function countPatternRules(
  instanceId: string,
): Promise<{ active: number; total: number }> {
  const scope = await authorizedPatternScope(instanceId);
  return scope
    ? readPatternCounts({ query: readSql, fragments: sql }, scope)
    : { active: 0, total: 0 };
}

/** Count of people on the LinkedIn intern's watchlist (its whole targeting model). */
export async function countLinkedInWatchlistPeople(
  instanceId: string,
): Promise<number> {
  const inst = await getAgentInstance(instanceId);
  if (!inst) return 0;
  const rows = await readSql<Array<{ n: number }>>`
    select count(*)::int as n
    from noelle.linkedin_watchlist_people
    where agent_instance_id = ${inst.id} and org_id = ${inst.org_id}
  `;
  return rows[0]?.n ?? 0;
}

/**
 * A person on the LinkedIn intern's watchlist, for the dashboard editor. The
 * LinkedIn analogue of WatchlistPersonRow: keyed by fsd_profile_id (no @handle),
 * displayed by name/headline, linked out to linkedin.com/in/<public_id>. The
 * `profiled` flag reflects whether the profiler has built a profile yet (drives
 * the "profiled" badge, the analogue of Vega's person-detail page link target).
 * `objective` is a single free-text engagement steer (the LinkedIn drafter reads
 * the raw string), not X's preset-kind + note pair.
 */
export interface LinkedInWatchlistPersonRow {
  id: string;
  fsd_profile_id: string;
  public_id: string | null;
  name: string | null;
  headline: string | null;
  objective: string | null;
  added_at: string;
  profiled: boolean;
