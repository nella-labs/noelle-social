import type { JSONValue, Sql } from "postgres";
import { summarizeOwnPerformance, type OwnPerfInputRow, type OwnPerformance } from "./own-performance.js";

// DB access for the X learn loop. The pure ranking/rollup lives in
// own-performance.ts; this file is the SQL boundary: which own posts to
// re-measure, writing a metrics snapshot, and reading the latest-per-tweet
// rollup that biases ideation.

/** A published own post that should have its engagement (re)measured. */
export interface OwnPublishedPost {
  /** The X tweet id. */
  tweetId: string;
  /** The idea that produced it (for pillar/angle attribution). Null if unknown. */
  ideaId: string | null;
  /** The author handle, parsed from the post URL — needed to fetch engagement. */
  handle: string;
}

// Match both x.com and twitter.com status URLs. Two single-capture variants so
// [1] is unambiguous: one captures the handle, one the numeric tweet id.
const RE_ID = "https?://(?:x|twitter)\\.com/[^/]+/status/([0-9]+)";
const RE_HANDLE = "https?://(?:x|twitter)\\.com/([^/]+)/status/[0-9]+";

/**
 * The operator's own published X posts to (re)measure, from BOTH publish paths:
 *   - autonomous: content_schedule_slots (posted_tweet_id + idea_id), and
 *   - manual: post_drafts marked published (the operator pastes posted_url; the
 *     tweet id + handle are parsed from it, idea_id comes from the draft).
 * Manual is how Vega actually posts today (the interns are draft-only), so this
 * is the primary source. The handle is parsed from the URL, so no connected X
 * account or configured handle is required. Rows without a parseable id+handle
 * are dropped. Capped at `limit` (per-handle Apify pull size downstream).
 */
export async function listOwnPublishedPosts(
  sql: Sql,
  args: { instanceId: string; windowDays: number; limit: number },
): Promise<OwnPublishedPost[]> {
  const win = `${args.windowDays} days`;
  const rows = await sql<Array<{ external_id: string | null; idea_id: string | null; handle: string | null }>>`
    select external_id, idea_id, handle from (
      select coalesce(s.posted_tweet_id, (regexp_match(s.posted_url, ${RE_ID}))[1]) as external_id,
             s.idea_id as idea_id,
             lower((regexp_match(s.posted_url, ${RE_HANDLE}))[1]) as handle
        from noelle.content_schedule_slots s
       where s.agent_instance_id = ${args.instanceId} and s.platform = 'x'
         and s.status = 'published'
         and s.published_at >= now() - ${win}::interval
      union
      select (regexp_match(d.posted_url, ${RE_ID}))[1] as external_id,
             d.idea_id as idea_id,
             lower((regexp_match(d.posted_url, ${RE_HANDLE}))[1]) as handle
        from noelle.post_drafts d
       where d.agent_instance_id = ${args.instanceId} and d.platform = 'x'
         and d.status = 'published' and d.posted_url is not null
         and d.updated_at >= now() - ${win}::interval
    ) q
    where q.external_id is not null and q.handle is not null
    order by q.external_id
    limit ${args.limit}
  `;
  return rows
    .filter((r): r is { external_id: string; idea_id: string | null; handle: string } => !!r.external_id && !!r.handle)
    .map((r) => ({ tweetId: r.external_id, ideaId: r.idea_id, handle: r.handle }));
}

/** A published own post to re-measure via the official X API (by tweet id). */
export interface PublishedTweetRef {
  tweetId: string;
  /** The slot that published it (autonomous path); null for a manual post. */
  slotId: string | null;
  /** The idea that produced it (pillar/angle attribution). Null if unknown. */
  ideaId: string | null;
}

/**
 * The operator's own published X posts to re-measure through the official X API
 * (GET /2/tweets — impressions included), from BOTH publish paths:
 *   - autonomous: content_schedule_slots.posted_tweet_id (carries slot_id + idea_id);
 *   - manual: post_drafts marked published (tweet id parsed from posted_url; no slot).
 * Deduped by tweet id, preferring the slot row (so slot_id is populated when we
 * have it). Unlike the Apify path this keys purely on the tweet id — no handle
 * needed — because GET /2/tweets looks up by id. Capped at `limit` (X allows 100
 * ids/request; the tick chunks anything above that).
 */
export async function listPublishedTweetsForMetrics(
  sql: Sql,
  args: { instanceId: string; windowDays: number; limit: number; excludeTweetIds?: string[] },
): Promise<PublishedTweetRef[]> {
  const limit = Math.min(200, Math.max(0, Number.isFinite(args.limit) ? Math.trunc(args.limit) : 0));
  if (limit === 0) return [];
  const win = `${args.windowDays} days`;
  const rows = await sql<Array<{ tweet_id: string | null; slot_id: string | null; idea_id: string | null }>>`
    with published as (
      select coalesce(s.posted_tweet_id, (regexp_match(s.posted_url, ${RE_ID}))[1]) as tweet_id,
             s.id as slot_id,
             s.idea_id as idea_id,
             1 as pref
        from noelle.content_schedule_slots s
       where s.agent_instance_id = ${args.instanceId} and s.platform = 'x'
         and s.status = 'published'
         and s.published_at >= now() - ${win}::interval
      union all
      select (regexp_match(d.posted_url, ${RE_ID}))[1] as tweet_id,
             null::uuid as slot_id,
             d.idea_id as idea_id,
             2 as pref
        from noelle.post_drafts d
       where d.agent_instance_id = ${args.instanceId} and d.platform = 'x'
         and d.status = 'published' and d.posted_url is not null
         and d.updated_at >= now() - ${win}::interval
    ), unique_posts as (
      select distinct on (tweet_id) tweet_id, slot_id, idea_id
      from published where tweet_id is not null
      order by tweet_id, pref
    )
    select p.tweet_id, p.slot_id, p.idea_id
    from unique_posts p
    left join lateral (
      select max(m.captured_at) as measured_at
      from noelle.own_post_metrics m
      where m.agent_instance_id = ${args.instanceId} and m.platform = 'x'
        and m.external_id = p.tweet_id
        and (m.views is not null or to_jsonb(m)->>'quotes' is not null or to_jsonb(m)->>'bookmarks' is not null)
    ) measured on true
    where not (p.tweet_id = any(${(args.excludeTweetIds ?? []).slice(0, 200)}::text[]))
    order by measured.measured_at asc nulls first, p.tweet_id
    limit ${limit}
  `;
  const seen = new Set<string>();
  const out: PublishedTweetRef[] = [];
  for (const r of rows) {
    if (!r.tweet_id || seen.has(r.tweet_id)) continue; // 'pref' order keeps the slot row first
    seen.add(r.tweet_id);
    out.push({ tweetId: r.tweet_id, slotId: r.slot_id, ideaId: r.idea_id });
    if (out.length >= limit) break;
  }
  return out;
}

/** One engagement snapshot to append. */
export interface OwnPostMetricInsert {
  orgId: string;
  instanceId: string;
  externalId: string;
  slotId: string | null;
  ideaId: string | null;
  likes: number;
  reposts: number;
  replies: number;
  views: number | null;
  authorFollowerCount: number | null;
  quotes?: number | null;
  bookmarks?: number | null;
}

/** Append engagement snapshots (append-only time-series). Best-effort per row. */
export async function recordOwnPostMetrics(sql: Sql, rows: OwnPostMetricInsert[]): Promise<number> {
  let n = 0;
  for (const r of rows) {
    const snapshot = {
      org_id: r.orgId, agent_instance_id: r.instanceId, platform: "x", external_id: r.externalId,
      slot_id: r.slotId, idea_id: r.ideaId, likes: r.likes, reposts: r.reposts, replies: r.replies,
      views: r.views, author_follower_count: r.authorFollowerCount,
      quotes: r.quotes ?? null, bookmarks: r.bookmarks ?? null,
    };
    // Schema-directed records ignore additive fields during a rolling update.
    // Database-generated identity and capture time remain authoritative.
    await sql`
      insert into noelle.own_post_metrics
      select (jsonb_populate_record(null::noelle.own_post_metrics,
        jsonb_build_object('id', gen_random_uuid(), 'captured_at', now())
        || ${sql.json(snapshot as JSONValue)}::jsonb)).*
    `;
    n++;
  }
  return n;
}

/**
 * Bounded learning population, preferring each post's latest exposure snapshot.
 * Counts and views always come from the same observation. A later count-only
 * scrape cannot inflate the numerator against an older impression denominator.
 * Posts without usable exposure retain their latest count-only observation.
 *
 * bigint columns come back as strings from postgres.js, so counts are coerced to
 * Number here before the pure summariser (which assumes numbers) sees them.
 */
export async function getOwnPostPerformance(
  sql: Sql,
  args: { instanceId: string; windowDays: number; topPosts: number; maxPosts?: number },
): Promise<OwnPerformance> {
  const rows = await sql<
    Array<{
      external_id: string;
      hook: string | null;
      pillar: string | null;
      angle: string | null;
      likes: string;
      reposts: string;
      replies: string;
      views: string | null;
      quotes: string | null;
      bookmarks: string | null;
    }>
  >`
    with population as (
      select external_id, max(captured_at) as latest_at
      from noelle.own_post_metrics
      where agent_instance_id = ${args.instanceId} and platform = 'x'
        and captured_at >= now() - ${`${args.windowDays} days`}::interval
      group by external_id
      order by latest_at desc, external_id
      limit ${Math.min(500, Math.max(0, Math.trunc(args.maxPosts ?? 500) || 0))}
    )
    select
           m.external_id,
           i.hook   as hook,
           i.pillar as pillar,
           i.angle  as angle,
           m.likes, m.reposts, m.replies, m.views,
           to_jsonb(m)->>'quotes' as quotes, to_jsonb(m)->>'bookmarks' as bookmarks
      from population p
      cross join lateral (
        select snapshot.* from noelle.own_post_metrics snapshot
        where snapshot.agent_instance_id = ${args.instanceId} and snapshot.platform = 'x'
          and snapshot.external_id = p.external_id
          and snapshot.captured_at >= now() - ${`${args.windowDays} days`}::interval
        order by (coalesce(snapshot.views, 0) > 0) desc, snapshot.captured_at desc, snapshot.id desc
        limit 1
      ) m
      left join noelle.post_ideas i on i.id = m.idea_id
  `;
  const input: OwnPerfInputRow[] = rows.map((r) => ({
    externalId: r.external_id,
    hook: r.hook,
    pillar: r.pillar,
    angle: r.angle,
    likes: Number(r.likes) || 0,
    reposts: Number(r.reposts) || 0,
    replies: Number(r.replies) || 0,
    views: r.views == null ? null : Number(r.views),
    quotes: r.quotes == null ? null : Number(r.quotes),
    bookmarks: r.bookmarks == null ? null : Number(r.bookmarks),
  }));
  return summarizeOwnPerformance(input, { topPosts: args.topPosts });
}
