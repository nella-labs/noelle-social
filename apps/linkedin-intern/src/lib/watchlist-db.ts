import type { JSONValue, Sql } from "postgres";

// Queries for the LinkedIn intern's watchlist tables:
//   - noelle.linkedin_watchlist_people    (0027) — the operator's connections (the WATCH lane)
//   - noelle.linkedin_watchlist_profiles  (0028) — LLM profile per person
//   - noelle.linkedin_watchlist           (0037) — keyword topics (the SEARCH lane)
//
// People are keyed by fsd_profile_id (urn:li:fsd_profile:<id>, prefix stripped),
// since LinkedIn has no @handle. Lyra now has TWO discovery lanes: the always-on
// WATCH lane (re-read these people's posts) and the SEARCH lane (keyword search
// LinkedIn-wide for high-engagement posts from outside the network).

export interface WatchlistPerson {
  id: string;
  /** urn:li:fsd_profile:<id>, prefix stripped — the stable person key. */
  fsdProfileId: string;
  /** Vanity slug (linkedin.com/in/<publicId>); used as the lead author_handle. */
  publicId: string | null;
  name: string | null;
  headline: string | null;
  /** Optional per-person engagement steer for the drafter. */
  objective: string | null;
  /** ISO timestamp the person was added — discovery only ingests posts on/after. */
  addedAt: string;
}

/**
 * Every person on the instance's LinkedIn watchlist. Drives discovery (fetch
 * their posts) and profiling. Oldest-added first.
 */
export async function getWatchlistPeople(
  sql: Sql,
  instanceId: string,
): Promise<WatchlistPerson[]> {
  const rows = await sql<
    {
      id: string;
      fsd_profile_id: string;
      public_id: string | null;
      name: string | null;
      headline: string | null;
      objective: string | null;
      added_at: string;
    }[]
  >`
    select id, fsd_profile_id, public_id, name, headline, objective, added_at
    from noelle.linkedin_watchlist_people
    where agent_instance_id = ${instanceId}
    order by added_at asc
  `;
  return rows.map((r) => ({
    id: r.id,
    fsdProfileId: r.fsd_profile_id,
    publicId: r.public_id,
    name: r.name,
    headline: r.headline,
    objective: r.objective,
    addedAt: r.added_at,
  }));
}

/**
 * The instance's SEARCH-lane keywords (noelle.linkedin_watchlist, kind='keyword').
 * Free-text topics discovery searches LinkedIn-wide for high-engagement posts from
 * OUTSIDE the network. Empty = the search lane is off and Lyra only watches her
 * connections. Oldest-added first (stable order). Mirrors Vega's x_watchlist keywords.
 */
export async function getLinkedinKeywords(sql: Sql, instanceId: string): Promise<string[]> {
  const rows = await sql<{ value: string }[]>`
    select value
    from noelle.linkedin_watchlist
    where agent_instance_id = ${instanceId} and kind = 'keyword'
    order by created_at asc
  `;
  return rows.map((r) => r.value);
}

export interface ProfilePerson {
  fsdProfileId: string;
  publicId: string | null;
  name: string | null;
  headline: string | null;
}

/**
 * Watchlist people whose profile is missing or stale (refreshed_at null or older
 * than staleDays) — the profiler's work queue, oldest-first. `batch` caps how
 * many we (re)profile per tick.
 */
export async function listWatchlistPeopleNeedingProfile(
  sql: Sql,
  args: { agentInstanceId: string; staleDays: number; batch: number },
): Promise<ProfilePerson[]> {
  const rows = await sql<
    { fsd_profile_id: string; public_id: string | null; name: string | null; headline: string | null }[]
  >`
    select p.fsd_profile_id, p.public_id, p.name, p.headline
    from noelle.linkedin_watchlist_people p
    left join noelle.linkedin_watchlist_profiles pr
      on pr.agent_instance_id = p.agent_instance_id and pr.fsd_profile_id = p.fsd_profile_id
    where p.agent_instance_id = ${args.agentInstanceId}
      and (
        pr.refreshed_at is null
        or pr.refreshed_at < now() - make_interval(days => ${args.staleDays})
      )
    order by pr.refreshed_at asc nulls first
    limit ${args.batch}
  `;
  return rows.map((r) => ({
    fsdProfileId: r.fsd_profile_id,
    publicId: r.public_id,
    name: r.name,
    headline: r.headline,
  }));
}

/**
 * People we have actually TALKED TO — authors with more than `minReplies` SENT
 * replies — whose profile is missing or stale. The second half of the profiler's
 * work queue, unioned with the watchlist half.
 *
 * Why this exists: the watchlist is the list of people we *intend* to engage,
 * and on LinkedIn it is 100% hand-curated. Everyone Lyra meets through the
 * keyword/search lane and then replies to over and over was invisible to the
 * profiler, so every one of those replies was drafted blind. Reply count is the
 * strongest "this person matters" signal we have and it costs nothing to read.
 *
 * Deliberately NOT implemented as an auto-promote into
 * `linkedin_watchlist_people` (the way Vega promotes on X): watchlist membership
 * also grants always-reply priority and makes the person eligible for an intro
 * DM (`intro_dm_drafted_at is null`), so promoting on reply count would fire
 * outbound DMs as a side effect of wanting a profile. Widening the read-only
 * work queue gets the grounding with no blast radius.
 *
 * `publicId` is best-effort: the stored author id is sometimes an opaque member
 * URN, so we also hand back a sample post URL and let `resolveVanitySlug` mine
 * the slug out of it. Oldest-profiled first, `batch` caps the tick.
 *
 * Only replies sent within `windowDays` count. A lifetime tally would make this
 * lane monotonic — a person could never leave it, so removing them from the
 * watchlist would no longer stop the profiler re-fetching them every
 * PROFILE_REFRESH_DAYS, forever. The window keeps the signal meaning "someone we
 * are ACTIVELY talking to" and bounds the queue by the reply rate rather than by
 * all of history.
 */
export async function listRepliedPeopleNeedingProfile(
  sql: Sql,
  args: {
    agentInstanceId: string;
    minReplies: number;
    /** Only replies sent within this many days count — see windowDays note above. */
    windowDays: number;
    staleDays: number;
    batch: number;
  },
): Promise<RepliedProfileCandidate[]> {
  if (args.batch <= 0 || args.minReplies < 0 || args.windowDays <= 0) return [];
  const rows = await sql<
    {
      fsd_profile_id: string;
      author_public_id: string | null;
      name: string | null;
      headline: string | null;
      post_url: string | null;
      replies: number;
    }[]
  >`
    with replied as (
      select l.author_handle as handle, count(*)::int as replies
      from noelle.approvals a
      join noelle.drafts d on d.id = a.draft_id
      join noelle.leads  l on l.id = d.lead_id
      where l.agent_instance_id = ${args.agentInstanceId}
        -- Scope on BOTH sides: an approval carries its own agent_instance_id
        -- and the two can diverge (27 such rows exist today, all on leads with
        -- a null instance). Filtering the lead alone would let another agent's
        -- reply count toward this one's relationship tally.
        and a.agent_instance_id = ${args.agentInstanceId}
        and l.platform = 'linkedin'
        and a.status = 'sent'
        and coalesce(a.decided_at, a.updated_at) > now() - make_interval(days => ${args.windowDays})
        and coalesce(l.author_handle, '') <> ''
      group by 1
      having count(*) > ${args.minReplies}
    ),
    -- Profiles are keyed by fsd_profile_id, but a lead's author_handle is
    -- whatever the discovery lane captured — sometimes the vanity slug,
    -- sometimes the member urn. Match on EITHER and carry the existing row's
    -- key forward, so a re-profile UPDATES that row instead of inserting a twin.
    matched as (
      select r.handle, r.replies, pr.fsd_profile_id as profile_key, pr.refreshed_at
      from replied r
      left join lateral (
        select p2.fsd_profile_id, p2.refreshed_at
        from noelle.linkedin_watchlist_profiles p2
        where p2.agent_instance_id = ${args.agentInstanceId}
          and (
            lower(p2.fsd_profile_id) = lower(r.handle)
            or lower(coalesce(p2.public_id, '')) = lower(r.handle)
          )
