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
