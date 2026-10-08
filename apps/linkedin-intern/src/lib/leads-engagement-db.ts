import type { Sql } from "postgres";
import type { AuthorEngagement, SamplePost } from "./engagement-analyst.js";

// Reads the REAL engagement already captured on watchlist people's posts in
// noelle.leads. Each LinkedIn lead's payload carries reactions + comments (set
// by discovery from Apify); we aggregate them per author, joined to the
// instance's watchlist so only watched people are ranked.

interface EngagementRow {
  author_handle: string;
  author_id: string | null;
  author_name: string | null;
  author_headline: string | null;
  post_count: number;
  avg_engagement: string;
  total_engagement: string;
  sample_posts: unknown;
}

/**
 * Top watchlist authors for this instance ranked by average post engagement
 * (reactions + comments), within the last `windowDays`. Each row carries its
 * `samplePosts` (the author's best posts, for the analyst to teardown). Authors
 * with fewer than `minPosts` posts in the window are dropped (too little signal).
 */
export async function getWatchlistAuthorEngagement(
  sql: Sql,
  args: {
    agentInstanceId: string;
    windowDays: number;
    limitAuthors: number;
    samplePosts: number;
    minPosts: number;
  },
): Promise<AuthorEngagement[]> {
  const rows = await sql<EngagementRow[]>`
    with scored as (
      select
        l.author_handle,
        l.author_id,
        coalesce(l.payload->>'authorName', '')     as author_name,
        coalesce(l.payload->>'authorHeadline', '') as author_headline,
        l.external_id,
        l.payload->>'text' as text,
        l.payload->>'url'  as url,
        coalesce(nullif(l.payload->>'reactions', '')::numeric, 0) as reactions,
        coalesce(nullif(l.payload->>'comments', '')::numeric, 0)  as comments,
        coalesce(nullif(l.payload->>'reactions', '')::numeric, 0)
          + coalesce(nullif(l.payload->>'comments', '')::numeric, 0) as engagement,
        row_number() over (
          partition by l.author_handle
          order by coalesce(nullif(l.payload->>'reactions', '')::numeric, 0)
            + coalesce(nullif(l.payload->>'comments', '')::numeric, 0) desc
        ) as rn
      from noelle.leads l
      join noelle.linkedin_watchlist_people p
        on p.agent_instance_id = l.agent_instance_id
       and p.public_id = l.author_handle
      where l.agent_instance_id = ${args.agentInstanceId}
        and l.platform = 'linkedin'
        and l.created_at >= now() - make_interval(days => ${args.windowDays})
    )
    select
      author_handle,
      max(author_id)                                    as author_id,
      max(nullif(author_name, ''))                      as author_name,
      max(nullif(author_headline, ''))                  as author_headline,
      count(*)::int                                     as post_count,
      avg(engagement)::float8                           as avg_engagement,
      sum(engagement)::float8                           as total_engagement,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'externalId', external_id,
            'text', text,
            'url', url,
            'reactions', reactions,
            'comments', comments
          ) order by engagement desc
        ) filter (where rn <= ${args.samplePosts}),
        '[]'::jsonb
      )                                                 as sample_posts
    from scored
    group by author_handle
    having count(*) >= ${args.minPosts}
    order by avg_engagement desc
    limit ${args.limitAuthors}
  `;

  return rows.map((r) => ({
    authorHandle: r.author_handle,
    authorId: r.author_id,
    authorName: r.author_name,
    authorHeadline: r.author_headline,
    postCount: r.post_count,
    avgEngagement: Number(r.avg_engagement ?? 0),
    totalEngagement: Number(r.total_engagement ?? 0),
    samplePosts: normalizeSamplePosts(r.sample_posts),
  }));
}

/**
 * The set of LinkedIn author handles the operator has already ENGAGED for this
 * instance — everyone on the watchlist (people Lyra reacts to) plus anyone Lyra
 * has already drafted a reply to. Used to EXCLUDE these authors from the net-new
 * ideation lane: ideas should borrow viral structure from people the operator is
 * NOT visibly engaging, so connections never see a post that looks copied from
 * their own. Handles are lowercased for case-insensitive matching.
 */
export async function getEngagedAuthorHandles(
  sql: Sql,
  args: { agentInstanceId: string },
): Promise<Set<string>> {
  const rows = await sql<{ handle: string }[]>`
    select distinct lower(handle) as handle from (
      select public_id as handle
        from noelle.linkedin_watchlist_people
        where agent_instance_id = ${args.agentInstanceId}
      union
      select author_handle as handle
        from noelle.leads
        where agent_instance_id = ${args.agentInstanceId}
          and platform = 'linkedin'
          and status = 'drafted'
    ) h
    where h.handle is not null and h.handle <> ''
  `;
  return new Set(rows.map((r) => r.handle));
}

function normalizeSamplePosts(raw: unknown): SamplePost[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((p) => {
    const o = p as Record<string, unknown>;
    return {
      externalId: String(o.externalId ?? ""),
      text: typeof o.text === "string" ? o.text : null,
      url: typeof o.url === "string" ? o.url : null,
      reactions: Number(o.reactions ?? 0),
      comments: Number(o.comments ?? 0),
    };
  });
}
