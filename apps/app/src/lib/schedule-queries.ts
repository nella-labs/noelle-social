import { cache } from "react";
import { assertOrgMember } from "@noelle/runtime";
import { pgOrgMembersClient, readSql as sql } from "@/lib/db";
import { getUserFromCookies } from "@/lib/auth-cookie";
import type { ScheduleSlotRow } from "@/components/posts/schedule-slots";
export type { ScheduleSlotRow } from "@/components/posts/schedule-slots";

/**
 * Read helpers for the Schedule calendar (noelle.content_schedule_slots).
 * Tenancy: Cloud SQL has no RLS, so every helper asserts org membership before
 * returning rows (same contract as posts-queries.ts / queries.ts).
 */

const requiredUserId = cache(async (): Promise<string> => {
  const user = await getUserFromCookies();
  if (!user) throw new Error("not signed in");
  return user.id;
});

async function assertMember(orgId: string, userId: string): Promise<void> {
  await assertOrgMember(pgOrgMembersClient(), userId, orgId);
}

/**
 * Slots in `[from, to)` for an org, optionally one platform. `skipped` slots are
 * hidden. Joins the bound draft/idea for the calendar chip preview.
 */
export const listScheduleSlotsForOrg = cache(async (
  orgId: string,
  range: { from: string; to: string },
  platform: string | null = null,
): Promise<ScheduleSlotRow[]> => {
  const userId = await requiredUserId();
  await assertMember(orgId, userId);
  const rows = await sql<ScheduleSlotRow[]>`
    select
      s.id,
      s.agent_instance_id,
      s.platform,
      to_char(s.slot_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as slot_at,
      s.status,
      s.idea_id,
      s.draft_id,
      s.auto_publish,
      s.window_source,
      s.batch_id,
      s.target_kind,
      s.posted_url,
      to_char(s.published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as published_at,
      coalesce(d.final_body, d.body, i.hook) as preview,
      coalesce(d.hook, i.hook) as hook
    from noelle.content_schedule_slots s
    join noelle.agent_instances ai on ai.id = s.agent_instance_id and ai.org_id = s.org_id
    left join noelle.post_drafts d on d.id = s.draft_id
      and d.org_id = s.org_id and d.agent_instance_id = s.agent_instance_id and d.platform = s.platform
      and (s.idea_id is null or d.idea_id = s.idea_id)
      and exists (select 1 from noelle.post_ideas di where di.id = d.idea_id
        and di.org_id = d.org_id and di.agent_instance_id = d.agent_instance_id)
    left join noelle.post_ideas i on i.id = coalesce(s.idea_id, d.idea_id)
      and i.org_id = s.org_id and i.agent_instance_id = s.agent_instance_id
      and (s.draft_id is null or d.id is not null)
    where s.org_id = ${orgId}
      and s.status <> 'skipped'
      and s.slot_at >= ${range.from}
      and s.slot_at < ${range.to}
      and (${platform}::text is null or s.platform = ${platform})
    order by s.slot_at asc
  `;
  return rows;
});

/** The agent instance id for a role in an org (the Compose target), or null. */
export const getInstanceIdForRole = cache(async (orgId: string, role: string): Promise<string | null> => {
  const userId = await requiredUserId();
  await assertMember(orgId, userId);
  const rows = await sql<Array<{ id: string }>>`
    select id from noelle.agent_instances where org_id = ${orgId} and role = ${role} limit 1
  `;
  return rows[0]?.id ?? null;
});

export interface ComposeJobRow {
  id: string;
  status: string;
  items_total: number;
  items_drafted: number;
  prompt: string | null;
  created_at: string;
}

/** Recent Compose batches for an instance, with how many slots are drafted/published. */
export const listComposeJobsForInstance = cache(async (orgId: string, instanceId: string): Promise<ComposeJobRow[]> => {
  const userId = await requiredUserId();
  await assertMember(orgId, userId);
  return await sql<ComposeJobRow[]>`
    select
      j.id, j.status, j.items_total, j.prompt,
      to_char(j.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at,
      (
        select count(*)::int from noelle.content_schedule_slots s
        where s.batch_id = j.id and s.status in ('ready', 'publishing', 'published')
          and s.org_id = j.org_id and s.agent_instance_id = j.agent_instance_id
      ) as items_drafted
    from noelle.agent_compose_jobs j
    join noelle.agent_instances ai on ai.id = j.agent_instance_id and ai.org_id = j.org_id
    where j.org_id = ${orgId} and j.agent_instance_id = ${instanceId}
    order by j.created_at desc
    limit 8
  `;
});

export interface TrendRef {
  author: string | null;
  note: string | null;
  url: string | null;
}

/** Recent high-engagement posts that have fuelled this agent's ideas — the
 *  Trending "fuel" feed (deduped, from post_ideas.inspiration_refs). */
export const getTrendingRefs = cache(async (orgId: string, instanceId: string): Promise<TrendRef[]> => {
  const userId = await requiredUserId();
  await assertMember(orgId, userId);
  const rows = await sql<Array<{ inspiration_refs: unknown }>>`
    select i.inspiration_refs from noelle.post_ideas i
    join noelle.agent_instances ai on ai.id = i.agent_instance_id and ai.org_id = i.org_id
    where i.org_id = ${orgId} and i.agent_instance_id = ${instanceId}
      and i.inspiration_refs is not null and i.inspiration_refs <> '[]'::jsonb
    order by i.created_at desc
    limit 40
  `;
  const out: TrendRef[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const refs = Array.isArray(r.inspiration_refs) ? r.inspiration_refs : [];
    for (const ref of refs) {
      if (!ref || typeof ref !== "object") continue;
      const o = ref as { author?: unknown; note?: unknown; url?: unknown };
      const author = typeof o.author === "string" ? o.author : null;
      const note = typeof o.note === "string" ? o.note : null;
      const url = typeof o.url === "string" ? o.url : null;
      const key = url ?? note ?? "";
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ author, note, url });
      if (out.length >= 12) return out;
    }
  }
  return out;
});

/** The raw brand_config jsonb for an instance (caller runs parseBrandConfig). */
export const getInstanceBrandConfig = cache(async (orgId: string, instanceId: string): Promise<unknown> => {
  const userId = await requiredUserId();
  await assertMember(orgId, userId);
  const rows = await sql<Array<{ brand_config: unknown }>>`
    select brand_config from noelle.agent_instances where id = ${instanceId} and org_id = ${orgId} limit 1
  `;
  return rows[0]?.brand_config ?? {};
});

export interface AgentPerformance {
  byStatus: { status: string; n: number }[];
  scheduledAhead: number;
  publishedAllTime: number;
  publishedThisWeek: number;
  draftsThisWeek: number;
  /** 14-day daily drafts-created series (oldest→newest), for the trend. */
  draftTrend: { day: string; n: number }[];
}

/** Per-agent activity metrics for the Performance dashboard. */
export const getAgentPerformance = cache(async (orgId: string, instanceId: string): Promise<AgentPerformance> => {
  const userId = await requiredUserId();
  await assertMember(orgId, userId);
  const [byStatus, drafts, pubWeek, pubAll, trend] = await Promise.all([
    sql<Array<{ status: string; n: number }>>`
      select s.status, count(*)::int as n from noelle.content_schedule_slots s
      join noelle.agent_instances ai on ai.id = s.agent_instance_id and ai.org_id = s.org_id
      where s.org_id = ${orgId} and s.agent_instance_id = ${instanceId} and s.status <> 'skipped'
      group by s.status
    `,
    sql<Array<{ n: number }>>`
      select count(*)::int as n from noelle.post_drafts d
      join noelle.agent_instances ai on ai.id = d.agent_instance_id and ai.org_id = d.org_id
      where d.org_id = ${orgId} and d.agent_instance_id = ${instanceId} and d.created_at >= now() - interval '7 days'
    `,
    sql<Array<{ n: number }>>`
      select count(*)::int as n from noelle.content_schedule_slots s
      join noelle.agent_instances ai on ai.id = s.agent_instance_id and ai.org_id = s.org_id
      where s.org_id = ${orgId} and s.agent_instance_id = ${instanceId} and s.status = 'published' and s.published_at >= now() - interval '7 days'
    `,
    sql<Array<{ n: number }>>`
      select count(*)::int as n from noelle.content_schedule_slots s
      join noelle.agent_instances ai on ai.id = s.agent_instance_id and ai.org_id = s.org_id
      where s.org_id = ${orgId} and s.agent_instance_id = ${instanceId} and s.status = 'published'
    `,
    sql<Array<{ day: string; n: number }>>`
      select to_char(d.created_at at time zone 'UTC', 'YYYY-MM-DD') as day, count(*)::int as n
      from noelle.post_drafts d
      join noelle.agent_instances ai on ai.id = d.agent_instance_id and ai.org_id = d.org_id
      where d.org_id = ${orgId} and d.agent_instance_id = ${instanceId} and d.created_at >= now() - interval '14 days'
      group by day order by day
    `,
  ]);
  const ahead = byStatus
    .filter((s) => ["empty", "drafting", "drafted", "ready"].includes(s.status))
    .reduce((a, s) => a + s.n, 0);
  return {
    byStatus,
    scheduledAhead: ahead,
    publishedAllTime: pubAll[0]?.n ?? 0,
    publishedThisWeek: pubWeek[0]?.n ?? 0,
    draftsThisWeek: drafts[0]?.n ?? 0,
    draftTrend: trend,
  };
});

export interface PublishedPostPerf {
  /** X tweet id. */
  externalId: string;
  /** The live post URL (from the slot / manual draft), when known. */
  url: string | null;
  /** The published body (or the idea hook as a fallback) for the row label. */
  preview: string | null;
  likes: number;
  reposts: number;
  replies: number;
  /** Real impressions from the official X API; null when only Apify measured it. */
  views: number | null;
  /** Total public engagement (likes + reposts + replies). */
  engagement: number;
  /** ISO-8601 UTC of the latest snapshot. */
  capturedAt: string;
}

export interface PublishedPerformance {
  /** Measured own posts, best-engagement first. */
  posts: PublishedPostPerf[];
  totals: {
    posts: number;
    likes: number;
    reposts: number;
    replies: number;
    /** Sum of impressions across posts that have a real (X API) number; null when none do. */
    impressions: number | null;
    postsWithImpressions: number;
  };
}

/**
 * REAL per-post engagement for the operator's own published posts, from
 * noelle.own_post_metrics — what the Performance tab shows (as opposed to the
 * drafting/pipeline counts in getAgentPerformance).
 *
 * Two sweeps append snapshots for the same tweet: the Apify self-track (likes/
 * reposts/replies, views always null) and the X-API metrics sweep (all four,
 * with real impressions). So we take the freshest engagement snapshot AND,
 * separately, the freshest snapshot that actually carried impressions — that way
 * a newer Apify row never blanks out a known impression count. bigint columns
 * arrive as strings from postgres.js, so every count is coerced to Number.
 */
export const getPublishedPostPerformance = cache(async (
  orgId: string,
  instanceId: string,
  opts: { windowDays?: number; limit?: number } = {},
): Promise<PublishedPerformance> => {
  const userId = await requiredUserId();
  await assertMember(orgId, userId);
  const windowDays = opts.windowDays ?? 90;
  const limit = opts.limit ?? 50;
  const win = `${windowDays} days`;
  const rows = await sql<
    Array<{
      external_id: string;
      url: string | null;
      preview: string | null;
      likes: string;
      reposts: string;
      replies: string;
      views: string | null;
      captured_at: string;
    }>
  >`
    with latest as (
      select distinct on (m.external_id)
             m.external_id, m.org_id, m.agent_instance_id, m.platform, m.slot_id, m.idea_id, m.likes, m.reposts, m.replies, m.captured_at
        from noelle.own_post_metrics m
        join noelle.agent_instances ai on ai.id = m.agent_instance_id and ai.org_id = m.org_id
       where m.org_id = ${orgId} and m.agent_instance_id = ${instanceId} and m.platform = 'x'
         and m.captured_at >= now() - ${win}::interval
       order by m.external_id, m.captured_at desc
    ),
    latest_views as (
      select distinct on (m.external_id) m.external_id, m.views
        from noelle.own_post_metrics m
        join noelle.agent_instances ai on ai.id = m.agent_instance_id and ai.org_id = m.org_id
       where m.org_id = ${orgId} and m.agent_instance_id = ${instanceId} and m.platform = 'x'
         and m.captured_at >= now() - ${win}::interval and m.views is not null
       order by m.external_id, m.captured_at desc
    )
    select
      m.external_id,
      coalesce(s.posted_url, dm.posted_url) as url,
      coalesce(d.final_body, d.body, dm.final_body, dm.body, i.hook) as preview,
      m.likes, m.reposts, m.replies,
      lv.views as views,
      to_char(m.captured_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as captured_at
    from latest m
    left join latest_views lv on lv.external_id = m.external_id
    left join noelle.content_schedule_slots s on s.id = m.slot_id
      and s.org_id = m.org_id and s.agent_instance_id = m.agent_instance_id and s.platform = m.platform
      and (m.idea_id is null or s.idea_id is null or s.idea_id = m.idea_id)
    left join noelle.post_drafts d on d.id = s.draft_id
      and d.org_id = m.org_id and d.agent_instance_id = m.agent_instance_id and d.platform = m.platform
      and (s.idea_id is null or d.idea_id = s.idea_id) and (m.idea_id is null or d.idea_id = m.idea_id)
      and exists (select 1 from noelle.post_ideas di where di.id = d.idea_id
        and di.org_id = d.org_id and di.agent_instance_id = d.agent_instance_id)
    left join noelle.post_ideas i on i.id = m.idea_id
      and i.org_id = m.org_id and i.agent_instance_id = m.agent_instance_id
    left join lateral (
      select dm.posted_url, dm.final_body, dm.body from noelle.post_drafts dm
      join noelle.post_ideas di on di.id = dm.idea_id and di.org_id = dm.org_id and di.agent_instance_id = dm.agent_instance_id
      where dm.org_id = m.org_id and dm.agent_instance_id = m.agent_instance_id and dm.platform = m.platform
        and dm.posted_url like '%/status/' || m.external_id
      limit 1
    ) dm on true
  `;
  const posts: PublishedPostPerf[] = rows
    .map((r) => {
      const likes = Number(r.likes) || 0;
      const reposts = Number(r.reposts) || 0;
      const replies = Number(r.replies) || 0;
      const views = r.views == null ? null : Number(r.views);
      return {
        externalId: r.external_id,
        url: r.url,
        preview: r.preview ? r.preview.replace(/\s+/g, " ").trim() : null,
        likes,
        reposts,
        replies,
        views,
        engagement: likes + reposts + replies,
        capturedAt: r.captured_at,
      };
    })
    .sort((a, b) => b.engagement - a.engagement || (b.views ?? 0) - (a.views ?? 0))
    .slice(0, limit);

  const withImpr = posts.filter((p) => p.views != null);
  return {
    posts,
    totals: {
      posts: posts.length,
      likes: posts.reduce((a, p) => a + p.likes, 0),
      reposts: posts.reduce((a, p) => a + p.reposts, 0),
      replies: posts.reduce((a, p) => a + p.replies, 0),
      impressions: withImpr.length ? withImpr.reduce((a, p) => a + (p.views ?? 0), 0) : null,
      postsWithImpressions: withImpr.length,
    },
  };
});

export interface BatchDayRow {
  day: string;
  total: number;
  drafted: number;
}

/** Per-day slot counts for one Compose batch (the day-card progress strip). */
export const listBatchSlotDays = cache(async (orgId: string, batchId: string): Promise<BatchDayRow[]> => {
  const userId = await requiredUserId();
  await assertMember(orgId, userId);
  return await sql<BatchDayRow[]>`
    select
      to_char(slot_at at time zone 'UTC', 'YYYY-MM-DD') as day,
      count(*)::int as total,
      count(*) filter (where status in ('ready', 'publishing', 'published'))::int as drafted
    from noelle.content_schedule_slots
    where batch_id = ${batchId} and org_id = ${orgId}
    group by day
    order by day
  `;
});
