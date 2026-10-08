import type { JSONValue, Sql } from "postgres";
import { replyApprovalContextSql } from "@noelle/runtime";

export interface ProfilePerson {
  handle: string;
  addedAt: string;
}

/**
 * Watchlist people whose profile is missing or stale (refreshed_at null or older
 * than staleDays) — the profiler's work queue, oldest-first. Scoped to the
 * instance. `batch` caps how many we (re)profile per tick.
 */
export async function listWatchlistPeopleNeedingProfile(
  sql: Sql,
  args: { agentInstanceId: string; staleDays: number; batch: number },
): Promise<ProfilePerson[]> {
  const rows = await sql<{ handle: string; added_at: string }[]>`
    select p.handle, p.added_at
    from noelle.x_watchlist_people p
    join noelle.agent_instances owner on owner.id=p.agent_instance_id and owner.org_id=p.org_id
    left join noelle.x_watchlist_profiles pr
      on pr.agent_instance_id = p.agent_instance_id and pr.org_id=p.org_id and pr.handle = p.handle
    where p.agent_instance_id = ${args.agentInstanceId} and owner.role='x_intern'
      and (
        pr.refreshed_at is null
        or pr.refreshed_at < now() - make_interval(days => ${args.staleDays})
      )
    order by pr.refreshed_at asc nulls first
    limit ${args.batch}
  `;
  return rows.map((r) => ({ handle: r.handle, addedAt: r.added_at }));
}

/**
 * Authors we have SENT strictly more than `minReplies` replies to, whose profile
 * is missing or stale — the second half of the profiler's work queue, unioned
 * with the watchlist half.
 *
 * Vega's auto-promote (see lib/watchlist-promote.ts) already sweeps most of these
 * onto the watchlist, but it doesn't catch everyone: it only runs on the keyword
 * lane, it's disabled when WATCHLIST_AUTOPROMOTE_MAX=0, and removing someone from
 * the watchlist orphans their profile so it never refreshes again. Reply count is
 * the durable "we actually talk to this person" signal, so it backstops all three.
 *
 * Handles are compared case-insensitively and the EXISTING profile row's handle
 * is carried forward — `x_watchlist_profiles` is unique on the raw
 * (agent_instance_id, handle), so re-profiling "ElonMusk" when the row says
 * "elonmusk" would insert a twin instead of refreshing it.
 *
 * Only replies sent within `windowDays` count. A lifetime tally would make this
 * lane monotonic — a person could never leave it, so removing them from the
 * watchlist would no longer stop the profiler re-fetching them every
 * PROFILE_REFRESH_DAYS, forever. The window keeps the signal meaning "someone we
 * are ACTIVELY talking to" and bounds the queue by the reply rate, not history.
 */
export async function listRepliedPeopleNeedingProfile(
  sql: Sql,
  args: {
    agentInstanceId: string;
    minReplies: number;
    /** Only replies sent within this many days count. */
    windowDays: number;
    staleDays: number;
    batch: number;
  },
): Promise<ProfilePerson[]> {
  if (args.batch <= 0 || args.minReplies < 0 || args.windowDays <= 0) return [];
  const rows = await sql<{ handle: string; added_at: string }[]>`
    with replied as (
      select lower(l.author_handle) as handle_lc,
             min(l.author_handle)   as handle_raw,
             count(*)::int          as replies
      from noelle.approvals a
      join noelle.drafts d on d.id = a.draft_id
      join noelle.leads  l on l.id = d.lead_id
      where l.agent_instance_id = ${args.agentInstanceId}
        and a.agent_instance_id = ${args.agentInstanceId}
        and ${replyApprovalContextSql(sql)}
        and l.platform = 'x'
        and a.status = 'sent'
        and d.payload->>'kind' = 'reply'
        and (d.sent_at is not null or nullif(btrim(d.sent_external_id),'') is not null)
        and coalesce(d.sent_at, a.decided_at, a.updated_at) > now() - make_interval(days => ${args.windowDays})
        and coalesce(l.author_handle, '') <> ''
      group by 1
      having count(*) > ${args.minReplies}
    ),
    matched as (
      select r.handle_lc, r.handle_raw, r.replies,
             pr.handle as profile_handle, pr.refreshed_at
      from replied r
      left join noelle.x_watchlist_profiles pr
        on pr.agent_instance_id = ${args.agentInstanceId}
       and pr.org_id = (select org_id from noelle.agent_instances where id=${args.agentInstanceId})
       and lower(pr.handle) = r.handle_lc
    )
    select coalesce(profile_handle, handle_raw) as handle, now()::text as added_at
    from matched
    where refreshed_at is null
       or refreshed_at < now() - make_interval(days => ${args.staleDays})
    order by refreshed_at asc nulls first, replies desc
    limit ${args.batch}
  `;
  return rows.map((r) => ({ handle: r.handle, addedAt: r.added_at }));
}

/**
 * Record a (re)profile ATTEMPT that produced no usable profile — no fetchable
 * tweets, unparseable LLM output, or an error. Stamps refreshed_at=now() so the
 * person backs off for the normal refresh window instead of re-queuing every
 * tick (which would starve healthy people out of the batch and re-spend LLM
 * calls forever). Never writes a summary — a person with a prior good profile
 * keeps it; a never-profiled person gets a tombstone row (summary stays null).
 */
export async function markProfileAttempted(
  sql: Sql,
  args: { orgId: string; agentInstanceId: string; handle: string },
): Promise<void> {
  await sql`
    with owner as (${profileWriteOwnerSql(sql, args)})
    insert into noelle.x_watchlist_profiles as profile
      (org_id, agent_instance_id, handle, refreshed_at)
    select org_id, id, ${args.handle}, now() from owner
    on conflict (agent_instance_id, handle) do update set
      refreshed_at = now(), updated_at = now()
    where profile.org_id=excluded.org_id
  `;
}

export interface WatchlistProfileUpsert {
  orgId: string;
  agentInstanceId: string;
  handle: string;
  summary: string;
  topics: string[];
  tone: string;
  engagementNotes: string;
  postsAnalyzed: number;
  model: string;
}

/**
 * Insert or refresh a person's profile. Stamps generated_at + refreshed_at to
 * now() so the row drops out of the needs-profile queue until it goes stale.
 */
export async function upsertWatchlistProfile(
  sql: Sql,
  p: WatchlistProfileUpsert,
): Promise<void> {
  await sql`
    with owner as (${profileWriteOwnerSql(sql, p)})
    insert into noelle.x_watchlist_profiles as profile
      (org_id, agent_instance_id, handle, summary, topics, tone,
       engagement_notes, posts_analyzed, model, generated_at, refreshed_at)
    select org_id, id, ${p.handle}, ${p.summary},
       ${sql.json(p.topics as unknown as JSONValue)}, ${p.tone},
       ${p.engagementNotes}, ${p.postsAnalyzed}, ${p.model}, now(), now() from owner
    on conflict (agent_instance_id, handle) do update set
      summary = excluded.summary,
      topics = excluded.topics,
      tone = excluded.tone,
      engagement_notes = excluded.engagement_notes,
      posts_analyzed = excluded.posts_analyzed,
      model = excluded.model,
      generated_at = excluded.generated_at,
      refreshed_at = excluded.refreshed_at,
      updated_at = now()
    where profile.org_id=excluded.org_id
  `;
}

export interface WatchlistProfileRow {
  handle: string;
  summary: string | null;
  topics: string[];
  tone: string | null;
  engagementNotes: string | null;
}

/**
 * Per-person profiles for the instance, keyed by lowercased @-stripped handle.
 * The drafter looks a lead's author up here to ground the reply in who the
 * person is (summary/topics/tone/engagement notes). Only rows with a generated
 * summary are returned (attempt tombstones — summary null — are skipped).
 *
 * The profiler writes these rows (upsertWatchlistProfile) but the drafter never
 * read them, so the profiler's work was orphaned on X — this closes that loop
 * (the LinkedIn intern has read this since day one; see
 * apps/linkedin-intern/src/lib/watchlist-db.ts getWatchlistProfiles).
 */
export async function getWatchlistProfiles(
  sql: Sql,
  instanceId: string,
): Promise<Map<string, WatchlistProfileRow>> {
  const rows = await sql<
    {
      handle: string;
      summary: string | null;
      topics: unknown;
