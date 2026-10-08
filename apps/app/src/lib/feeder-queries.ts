import { cache } from "react";
import { approvalMemoryJoins } from "@noelle/runtime";
import { corpusEngagementSql } from "@noelle/runtime/account-feeder-db";
import { readSourceCount, readSourceTimestamp } from "@noelle/runtime/source-values";
import { readSql as sql, sql as fragmentSql } from "@/lib/db";
import { getAgentInstance } from "@/lib/queries";
import { normalizeLinkedinHandle } from "@/lib/utils";

// Read helpers for the Account Feeder (the "style sources" surface).
//
// The feeder learns a writing style from admired source accounts: it pulls
// their posts + authored comments, distils each into an "ultra profile", and
// builds a corpus the drafter samples per-lead. This module backs the dashboard
// subpage (the source list + the cost-gated Run card). The actual pull is done
// by the F5 worker; here we only read the curated source list and the run state.
//
// Tenancy: Cloud SQL has no RLS. Every read here goes through getAgentInstance,
// which runs assertOrgMember on the row's real org_id (the cross-tenant IDOR
// guard) before any feeder query, and every SQL statement also matches org_id in
// its WHERE clause. Run status additionally matches the heartbeat instance
// against its current parent organization after the membership check.

/** One curated source account (a noelle.account_feeder_sources row). */
export interface FeederSourceRow {
  id: string;
  platform: string;
  handle: string;
  display_name: string | null;
  note: string | null;
  enabled: boolean;
  last_pulled_at: string | null;
  created_at: string;
  /** Contact (noelle.persons) this source resolves to, for a deep link. */
  contact_person_id: string | null;
}

/**
 * Every curated source account for an instance, for the dashboard editor.
 * Oldest-first (stable add order). Tenancy: getAgentInstance asserts membership
 * on the instance's real org_id, and the org_id match in the WHERE clause is the
 * IDOR guard.
 */
export async function listFeederSources(
  instanceId: string,
): Promise<FeederSourceRow[]> {
  const inst = await getAgentInstance(instanceId);
  if (!inst) return [];
  const rows = await sql<FeederSourceRow[]>`
    select
      s.id, s.platform, s.handle, s.display_name, s.note, s.enabled,
      s.last_pulled_at::text as last_pulled_at,
      s.created_at::text as created_at,
      contact.person_id as contact_person_id
    from noelle.account_feeder_sources s
    left join lateral (
      select psa.person_id from noelle.person_social_accounts psa
      where psa.org_id = s.org_id and psa.platform = s.platform
        and regexp_replace(lower(psa.handle), '-[0-9a-f]{6,}$', '')
            = regexp_replace(lower(s.handle), '-[0-9a-f]{6,}$', '')
      limit 1
    ) contact on true
    where s.agent_instance_id = ${inst.id} and s.org_id = ${inst.org_id}
    order by s.created_at asc
  `;
  return [...rows];
}

/** Count of curated source accounts (drives the "Style sources" entry card). */
export async function countFeederSources(instanceId: string): Promise<number> {
  const inst = await getAgentInstance(instanceId);
  if (!inst) return 0;
  // count(*) is bigint → postgres.js returns it as a JS string. Cast to int in
  // SQL so the value arrives as a number and never gets string-concatenated.
  const rows = await sql<Array<{ n: number }>>`
    select count(*)::int as n
    from noelle.account_feeder_sources
    where agent_instance_id = ${inst.id} and org_id = ${inst.org_id}
  `;
  return rows[0]?.n ?? 0;
}

/** Collapsed run state for the feeder, shown on the Run card. */
export type FeederRunState = "running" | "requested" | "stalled" | "errored" | "idle";

export interface FeederRunStatus {
  /** Collapsed status word for the Run card's dot. */
  state: FeederRunState;
  /** account_feeder_last_run_at — when the worker last finished a pull. */
  lastRunAt: string | null;
  /** account_feeder_run_requested_at — set by the Run button, cleared by the worker. */
  runRequestedAt: string | null;
  /** Latest worker_runs row's started_at (worker='linkedin_feeder'). */
  lastStartedAt: string | null;
  /** Latest worker_runs row's finished_at. */
  lastFinishedAt: string | null;
  /** Latest worker_runs row's error, if the last run failed. */
  lastError: string | null;
}

const FIFTEEN_MIN_MS = 15 * 60 * 1000;

/**
 * Worker name written to noelle.worker_runs by the F5 account-feeder worker.
 * Kept in sync with the feeder's heartbeat writes (spec §7 F5 / §2.18).
 */
export const FEEDER_WORKER = "linkedin_feeder" as const;

/**
 * Run state for the feeder, for the dashboard Run card. Folds three signals:
 *  - the instance's request/last-run timestamps (the flag the Run button flips
 *    + the stamp the worker writes when it finishes), and
 *  - the latest noelle.worker_runs heartbeat for worker='linkedin_feeder'.
 *
 * State precedence (mirrors deriveVegaWorkerStatus, plus a "requested" pre-run
 * state unique to the cost-gated manual trigger):
 *   - "running"   — a worker_runs row is open (finished_at NULL) < 15 min old.
 *   - "stalled"   — a worker_runs row is open but older than 15 min (died mid-tick).
 *   - "requested" — the Run flag is set and newer than the last finished run, but
 *                   no live heartbeat yet (the worker hasn't picked it up). The
 *                   button disables in this state so we never double-request.
 *   - "errored"   — the most recent finished worker_runs row carries an error.
 *   - "idle"      — everything else.
 *
 * Until the F5 worker is deployed nothing writes worker_runs for the feeder, so
 * after a click this correctly reads "requested" (the flag is set, no heartbeat),
 * which is exactly the state we want to surface pre-worker.
 *
 * Tenancy: the instance read is membership-guarded via getAgentInstance;
 * the heartbeat is bound to this instance and its current organization.
 */
export async function getFeederRunStatus(
  instanceId: string,
  nowMs: number = Date.now(),
): Promise<FeederRunStatus | null> {
  const inst = await getAgentInstance(instanceId);
  if (!inst) return null;

  const instRows = await sql<
    Array<{ run_requested_at: string | null; last_run_at: string | null }>
  >`
    select
      account_feeder_run_requested_at::text as run_requested_at,
      account_feeder_last_run_at::text      as last_run_at
    from noelle.agent_instances
    where id = ${inst.id} and org_id = ${inst.org_id}
    limit 1
  `;
  const runRequestedAt = instRows[0]?.run_requested_at ?? null;
  const lastRunAt = instRows[0]?.last_run_at ?? null;

  // Latest heartbeat for this feeder instance under its current organization.
  const runRows = await sql<
    Array<{
      started_at: string | null;
      finished_at: string | null;
      error: string | null;
    }>
  >`
    select
      r.started_at::text  as started_at,
      r.finished_at::text as finished_at,
      r.error
    from noelle.worker_runs r
    join noelle.agent_instances ai on ai.id = r.instance_id and ai.org_id = ${inst.org_id}
    where r.worker = ${FEEDER_WORKER} and r.instance_id = ${inst.id}
    order by r.started_at desc nulls last
    limit 1
  `;
  const run = runRows[0];
  const lastStartedAt = run?.started_at ?? null;
  const lastFinishedAt = run?.finished_at ?? null;
  const lastError = run?.error ?? null;

  let state: FeederRunState = "idle";
  if (run && run.started_at && run.finished_at == null) {
    const ageMs = nowMs - new Date(run.started_at).getTime();
    state = ageMs < FIFTEEN_MIN_MS ? "running" : "stalled";
  } else if (
    runRequestedAt &&
    (lastRunAt == null || new Date(runRequestedAt) > new Date(lastRunAt))
  ) {
    // Flag set + the worker hasn't recorded a finish for it yet.
    state = "requested";
  } else if (lastError) {
    state = "errored";
  }

  return {
    state,
    lastRunAt,
    runRequestedAt,
    lastStartedAt,
    lastFinishedAt,
    lastError,
  };
}

/** The extracted Gemini "ultra profile" for a style source, as the UI renders it. */
export interface UltraProfileView {
  voiceSummary: string | null;
  tone: string | null;
  structureNotes: string | null;
  hookPatterns: string[];
  signaturePhrases: string[];
  topTopics: string[];
  postsAnalyzed: number;
  model: string | null;
  generatedAt: string | null;
}

/**
 * The style-source face of a contact: when a person (by their X or LinkedIn
 * handle) is also one of Lyra's Account-Feeder source accounts, this is what the
 * contacts page shows — the source row's status + how much corpus was pulled +
 * the Gemini ultra-profile (or null when the feeder pulled posts but hasn't
 * distilled a profile yet). `null` from the query means "not a style source".
 */
export interface PersonStyleSource {
  sourceId: string;
  agentInstanceId: string;
  platform: string;
  handle: string;
  enabled: boolean;
  lastPulledAt: string | null;
  postCount: number;
  commentCount: number;
  /** The distilled style profile, or null if pulled-but-not-yet-extracted. */
  profile: UltraProfileView | null;
}

/** jsonb array column → string[] (postgres.js parses jsonb; guard the shape). */
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Is this contact also one of Lyra's style sources? Matches the person's X or
 * LinkedIn handle against noelle.account_feeder_sources (org-scoped), and joins
 * the account's ultra profile + corpus counts. Returns null when the person is
 * not a source. Tenancy: scoped by org_id, same trust model as the sibling
 * contact reads (getLinkedInProfileForOrg) — the page already membership-guards
 * the org via getOrgBySlug.
 */
export async function getStyleSourceForPerson(
  orgId: string,
  handles: { xHandle: string | null; linkedinHandle: string | null },
): Promise<PersonStyleSource | null> {
  const x = handles.xHandle?.trim().toLowerCase() || null;
  // Match LinkedIn on the suffix-stripped handle so a contact merged onto the
  // clean vanity (`kaia-tham`) still resolves a feeder source stored under the
  // raw slug (`kaia-tham-7bb065343`). See normalizeLinkedinHandle / reconcile.
  const li = handles.linkedinHandle ? normalizeLinkedinHandle(handles.linkedinHandle) : null;
  if (!x && !li) return null;

  const rows = await sql<
    Array<{
      source_id: string;
      agent_instance_id: string;
      platform: string;
      handle: string;
      enabled: boolean;
      last_pulled_at: string | null;
      post_count: number;
      comment_count: number;
      voice_summary: string | null;
      tone: string | null;
      structure_notes: string | null;
      hook_patterns: unknown;
      signature_phrases: unknown;
      top_topics: unknown;
      posts_analyzed: number | null;
      model: string | null;
      generated_at: string | null;
    }>
  >`
    select
      s.id as source_id, s.agent_instance_id, s.platform, s.handle, s.enabled,
      s.last_pulled_at::text as last_pulled_at,
      (
        select count(*)::int from noelle.account_style_posts p
        where p.agent_instance_id = s.agent_instance_id and p.platform = s.platform
          and lower(p.account_handle) = lower(s.handle) and p.kind = 'post'
      ) as post_count,
      (
        select count(*)::int from noelle.account_style_posts p
        where p.agent_instance_id = s.agent_instance_id and p.platform = s.platform
          and lower(p.account_handle) = lower(s.handle) and p.kind = 'comment'
      ) as comment_count,
      up.voice_summary, up.tone, up.structure_notes,
      up.hook_patterns, up.signature_phrases, up.top_topics,
      up.posts_analyzed, up.model, up.generated_at::text as generated_at
    from noelle.account_feeder_sources s
    left join noelle.account_ultra_profiles up
      on up.agent_instance_id = s.agent_instance_id and up.platform = s.platform
      and lower(up.account_handle) = lower(s.handle) and up.org_id = s.org_id
    where s.org_id = ${orgId}
      and (
        (s.platform = 'linkedin' and ${li}::text is not null
           and regexp_replace(lower(s.handle), '-[0-9a-f]{6,}$', '') = ${li}) or
        (s.platform = 'x' and ${x}::text is not null and lower(s.handle) = ${x})
      )
    order by s.enabled desc, s.last_pulled_at desc nulls last
    limit 1
  `;
  const r = rows[0];
  if (!r) return null;

  const hasProfile = r.voice_summary != null || r.tone != null || (r.posts_analyzed ?? 0) > 0;
  return {
    sourceId: r.source_id,
    agentInstanceId: r.agent_instance_id,
    platform: r.platform,
    handle: r.handle,
    enabled: r.enabled,
    lastPulledAt: r.last_pulled_at,
    postCount: r.post_count,
    commentCount: r.comment_count,
    profile: hasProfile
      ? {
          voiceSummary: r.voice_summary,
          tone: r.tone,
          structureNotes: r.structure_notes,
          hookPatterns: asStringArray(r.hook_patterns),
          signaturePhrases: asStringArray(r.signature_phrases),
          topTopics: asStringArray(r.top_topics),
          postsAnalyzed: r.posts_analyzed ?? 0,
          model: r.model,
          generatedAt: r.generated_at,
        }
      : null,
  };
}

/** One feeder source's pull status + distilled profile, for the Styles page. */
export interface FeederSourceProfile {
  /** account_feeder_sources.id — drives the inline enable/disable toggle. */
  sourceId: string;
  platform: string;
  handle: string;
  displayName: string | null;
  enabled: boolean;
  lastPulledAt: string | null;
  postCount: number;
  commentCount: number;
  /** The Gemini ultra-profile, or null if pulled-but-not-yet-extracted. */
  profile: UltraProfileView | null;
  /** Contact (noelle.persons) this source resolves to, or null if not yet a contact. */
  contactPersonId: string | null;
  /**
   * Usage attribution: how often this source's voice was actually sampled into a
   * draft. `draftsUsed` of `totalStyledDrafts` styled drafts blended in this
   * source; `avgWeight` is its mean share (0..1) on the drafts that used it.
   */
  draftsUsed: number;
  totalStyledDrafts: number;
  avgWeight: number | null;
}

/**
 * Per-source pull status + ultra-profile for every Account-Feeder source on an
 * instance — backs the Styles page "what's been pulled / how the feeder
 * interpreted it / already styled?" view. Membership-guarded via getAgentInstance.
 */
export async function listFeederSourceProfiles(
  instanceId: string,
): Promise<FeederSourceProfile[]> {
  const inst = await getAgentInstance(instanceId);
  if (!inst) return [];
  const rows = await sql<
    Array<{
      source_id: string;
      platform: string;
      handle: string;
      display_name: string | null;
      enabled: boolean;
      last_pulled_at: string | null;
      post_count: number;
      comment_count: number;
      contact_person_id: string | null;
      drafts_used: number;
      total_styled_drafts: number;
      avg_weight: string | null;
      voice_summary: string | null;
      tone: string | null;
      structure_notes: string | null;
      hook_patterns: unknown;
      signature_phrases: unknown;
      top_topics: unknown;
      posts_analyzed: number | null;
      model: string | null;
      generated_at: string | null;
    }>
  >`
    with scoped_styles as materialized (
      select distinct d.id, l.platform,
        case when jsonb_typeof(d.payload->'style_source'->'blend') = 'array'
          then d.payload->'style_source'->'blend' else '[]'::jsonb end as blend
      from noelle.approvals a
      ${approvalMemoryJoins(fragmentSql)}
      where a.agent_instance_id = ${inst.id} and a.org_id = ${inst.org_id}
    ), style_usage as (
      select d.platform, b->>'handle' as handle, count(distinct d.id)::int as drafts_used,
        avg(case when jsonb_typeof(b->'weight') = 'number' then (b->>'weight')::numeric end)::text as avg_weight
      from scoped_styles d cross join lateral jsonb_array_elements(d.blend) b
      where jsonb_typeof(b->'handle') = 'string'
      group by d.platform, b->>'handle'
    ), style_totals as (
      select platform, count(*)::int as total_styled_drafts
      from scoped_styles where jsonb_array_length(blend) > 0 group by platform
    )
    select
      s.id as source_id, s.platform,
      s.handle, s.display_name, s.enabled, s.last_pulled_at::text as last_pulled_at,
      (
        select count(*)::int from noelle.account_style_posts p
        where p.agent_instance_id = s.agent_instance_id and p.org_id = s.org_id and p.platform = s.platform
          and lower(p.account_handle) = lower(s.handle) and p.kind = 'post'
      ) as post_count,
      (
        select count(*)::int from noelle.account_style_posts p
        where p.agent_instance_id = s.agent_instance_id and p.org_id = s.org_id and p.platform = s.platform
          and lower(p.account_handle) = lower(s.handle) and p.kind = 'comment'
      ) as comment_count,
      contact.person_id as contact_person_id,
      coalesce(usage.drafts_used, 0) as drafts_used,
      coalesce(totals.total_styled_drafts, 0) as total_styled_drafts,
      usage.avg_weight,
      up.voice_summary, up.tone, up.structure_notes,
      up.hook_patterns, up.signature_phrases, up.top_topics,
      up.posts_analyzed, up.model, up.generated_at::text as generated_at
    from noelle.account_feeder_sources s
    left join style_usage usage on usage.platform = s.platform and usage.handle = s.handle
    left join style_totals totals on totals.platform = s.platform
    left join noelle.account_ultra_profiles up
      on up.agent_instance_id = s.agent_instance_id and up.platform = s.platform
      and lower(up.account_handle) = lower(s.handle) and up.org_id = s.org_id
    -- Resolve the contact this source maps to (suffix-normalized for LinkedIn) so
    -- the Styles row can deep-link to the person's profile in Contacts.
    left join lateral (
      select psa.person_id from noelle.person_social_accounts psa
      where psa.org_id = s.org_id and psa.platform = s.platform
        and regexp_replace(lower(psa.handle), '-[0-9a-f]{6,}$', '')
            = regexp_replace(lower(s.handle), '-[0-9a-f]{6,}$', '')
      limit 1
    ) contact on true
    where s.agent_instance_id = ${inst.id} and s.org_id = ${inst.org_id}
    order by s.created_at asc
  `;
  return rows.map((r) => {
    const hasProfile = r.voice_summary != null || r.tone != null || (r.posts_analyzed ?? 0) > 0;
    return {
      sourceId: r.source_id,
      platform: r.platform,
      handle: r.handle,
      displayName: r.display_name,
      enabled: r.enabled,
      lastPulledAt: r.last_pulled_at,
      postCount: r.post_count,
      commentCount: r.comment_count,
      contactPersonId: r.contact_person_id,
      draftsUsed: r.drafts_used,
      totalStyledDrafts: r.total_styled_drafts,
      avgWeight: r.avg_weight !== null && Number.isFinite(Number(r.avg_weight)) ? Number(r.avg_weight) : null,
      profile: hasProfile
        ? {
            voiceSummary: r.voice_summary,
            tone: r.tone,
            structureNotes: r.structure_notes,
            hookPatterns: asStringArray(r.hook_patterns),
            signaturePhrases: asStringArray(r.signature_phrases),
            topTopics: asStringArray(r.top_topics),
            postsAnalyzed: r.posts_analyzed ?? 0,
            model: r.model,
            generatedAt: r.generated_at,
          }
        : null,
    };
  });
}

/** A sample pulled corpus item, for the Styles page "show the posts pulled" view. */
export interface StyleSamplePost {
  handle: string;
  kind: "post" | "comment";
  body: string;
  likeCount: number | null;
  commentCount: number | null;
  postedAt: string | null;
}

/**
 * Top-`perSource` highest-engagement corpus items per source for an instance —
 * the actual pulled posts/comments, so the operator can see what the feeder
 * learned from. Membership-guarded via getAgentInstance.
 */
export async function listStyleSamples(
  instanceId: string,
  perSource = 4,
): Promise<StyleSamplePost[]> {
  const inst = await getAgentInstance(instanceId);
  if (!inst) return [];
  const rows = await sql<
    Array<{
      account_handle: string;
      kind: "post" | "comment";
      body: string;
      like_count: string | null;
      comment_count: string | null;
      posted_at: string | null;
    }>
  >`
    select account_handle, kind, body, like_count::text, comment_count::text, posted_at::text as posted_at
    from (
      select p.account_handle, p.kind, p.body, p.like_count, p.comment_count, p.posted_at,
        row_number() over (
          partition by p.account_handle
          order by ${corpusEngagementSql(fragmentSql)} desc nulls last,
                   p.posted_at desc nulls last,p.id
        ) as rn
      from noelle.account_style_posts p
      join noelle.agent_instances a on a.id=p.agent_instance_id and a.org_id=p.org_id
      where p.agent_instance_id = ${inst.id} and p.org_id = ${inst.org_id} and p.body <> ''
    ) r
    where rn <= ${perSource}
    order by account_handle, rn
  `;
  return rows.map((r) => ({
    handle: r.account_handle,
    kind: r.kind,
    body: r.body,
    likeCount: readSourceCount(r.like_count),
    commentCount: readSourceCount(r.comment_count),
    postedAt: readSourceTimestamp(r.posted_at),
  }));
}

/**
 * All style-source keys (`platform:handle`, lowercased) for an org — for the
 * contacts LIST to badge which contacts are also Account-Feeder sources without
 * a per-row query. LinkedIn handles are suffix-normalized (see
 * normalizeLinkedinHandle) so the key matches a contact merged onto the clean
 * vanity even when the source is stored under the raw `-<hex>` slug. The
 * consumer (ContactsBrowser.isStyleSource) normalizes the contact handle the
 * same way. Org-scoped (same trust model as the other contact reads).
 */
export async function listStyleSourceKeysForOrg(orgId: string): Promise<string[]> {
  const rows = await sql<Array<{ key: string }>>`
    select distinct (
      platform || ':' ||
      case when platform = 'linkedin'
           then regexp_replace(lower(handle), '-[0-9a-f]{6,}$', '')
           else lower(handle) end
    ) as key
    from noelle.account_feeder_sources
    where org_id = ${orgId} and handle is not null
  `;
  return rows.map((r) => r.key);
}

/**
 * Convenience for the agent detail page: source count + a "feeder is configured"
 * flag (account_feeder_config present) in one membership-guarded round trip.
 * The card always renders for the LinkedIn intern; the flag just tweaks copy.
 */
export const getFeederSummary = cache(async (
  instanceId: string,
): Promise<{ sourceCount: number; configured: boolean }> => {
  const inst = await getAgentInstance(instanceId);
  if (!inst) return { sourceCount: 0, configured: false };
  const [counts] = await sql<Array<{ n: number; configured: boolean }>>`
    select
      (
        select count(*)::int from noelle.account_feeder_sources s
        where s.agent_instance_id = ${inst.id} and s.org_id = ${inst.org_id}
      ) as n,
      (account_feeder_config is not null) as configured
    from noelle.agent_instances
    where id = ${inst.id} and org_id = ${inst.org_id}
    limit 1
  `;
  return { sourceCount: counts?.n ?? 0, configured: counts?.configured ?? false };
});
