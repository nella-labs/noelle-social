import { readSql as sql } from "@/lib/db";
import { reachMultiple } from "@/lib/video-metrics";
import { readSourceCount, readSourceTimestamp } from "@noelle/runtime/source-values";
import { loadVideoAccountTracking, type PrimaryVideoAccount, type VideoFollowerPoint } from "@noelle/runtime/video-account-db";

// Read model for Nova's analytics/admin page: the operator's OWN tracked posts
// (source_kind='account'), their performance + reach-multiple, the growth Nova
// has observed since it started tracking, the Nova draft each post came from (if
// linked), and the account's follower trend. Tenancy is enforced by the caller
// (the page resolves the instance via the membership-gated org lookup).

export interface OwnPostRow {
  id: string;
  externalId: string;
  caption: string;
  url: string;
  thumbUrl: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  followerCount: number | null;
  reachMultiple: number | null;
  postedAt: string | null;
  /** Views gained since Nova began tracking this post (null if <2 snapshots). */
  viewsGained: number | null;
  /** The Nova draft this post was published from, if linked. */
  draftId: string | null;
  draftHook: string | null;
  qualityScore: number | null;
}

export type FollowerPoint = VideoFollowerPoint;

export interface OwnAccountAnalytics {
  handle: string | null;
  platform: PrimaryVideoAccount["platform"] | null;
  followerCount: number | null;
  /** Complete selected-account measured window, independent of the bounded chart series. */
  followerDelta: number | null;
  followerSeries: FollowerPoint[];
  posts: OwnPostRow[];
  /** True when an own-account source exists but no posts have been pulled yet. */
  trackingHandle: string | null;
}

export interface LinkableDraft {
  id: string;
  hook: string | null;
  status: string;
  /** Clip id this draft is already linked to (so the UI can show "linked elsewhere"). */
  publishedClipId: string | null;
}

/**
 * Drafts the operator could attribute a published post to — Nova drafts for this
 * instance, newest first, with the idea hook for display. Used by the analytics
 * page's "which draft did this post come from" picker.
 */
export async function listLinkableDrafts(instanceId: string, limit = 60): Promise<LinkableDraft[]> {
  const rows = await sql<{ id: string; hook: string | null; status: string; published_clip_id: string | null }[]>`
    select d.id, vi.hook, d.status, d.published_clip_id
    from noelle.video_drafts d
    left join noelle.video_ideas vi on vi.id = d.idea_id
    where d.agent_instance_id = ${instanceId} and d.status <> 'dismissed'
    order by d.updated_at desc
    limit ${limit}`;
  return rows.map((r) => ({ id: r.id, hook: r.hook, status: r.status, publishedClipId: r.published_clip_id }));
}

export async function getOwnAccountAnalytics(instanceId: string): Promise<OwnAccountAnalytics> {
  const tracking = await loadVideoAccountTracking(sql, instanceId);
  const account = tracking.account;
  if (!account) return { handle: null, platform: null, followerCount: null, followerDelta: null, followerSeries: [], posts: [], trackingHandle: null };

  const rows = await sql<
    {
      id: string;
      external_id: string;
      caption: string;
      url: string;
      thumb_url: string | null;
      views: string | null;
      likes: string | null;
      comments: string | null;
      shares: string | null;
      saves: string | null;
      author_follower_count: string | null;
      posted_at: string | null;
      first_views: string | null;
      latest_views: string | null;
      draft_id: string | null;
      draft_hook: string | null;
      quality_score: number | null;
    }[]
  >`
    select
      c.id, c.external_id, c.caption, c.url, c.thumb_url,
      c.views::text,c.likes::text,c.comments::text,c.shares::text,c.saves::text,
      c.author_follower_count::text,c.posted_at::text,
      m.first_views::text,m.latest_views::text,
      d.id as draft_id, vi.hook as draft_hook, d.quality_score
    from noelle.video_clips c
    join noelle.agent_instances a on a.id=c.agent_instance_id and a.org_id=c.org_id
    left join lateral (
      select (array_agg(views order by captured_at asc))[1] as first_views,
             (array_agg(views order by captured_at desc))[1] as latest_views
      from noelle.video_clip_metrics
      where clip_id=c.id and agent_instance_id=c.agent_instance_id and org_id=c.org_id
      having count(*) >= 2
    ) m on true
    left join lateral (
      select id, idea_id, quality_score from noelle.video_drafts
      where published_clip_id=c.id and agent_instance_id=c.agent_instance_id and org_id=c.org_id
      order by updated_at desc limit 1
    ) d on true
    left join noelle.video_ideas vi on vi.id=d.idea_id and vi.org_id=c.org_id and vi.agent_instance_id=c.agent_instance_id
    where c.agent_instance_id=${instanceId} and c.org_id=${account.orgId}
      and c.platform=${account.platform} and lower(btrim(c.author_handle))=${account.handle} and c.source_kind='account'
    order by case when c.views between 0 and ${Number.MAX_SAFE_INTEGER} then c.views end desc nulls last`;

  const posts: OwnPostRow[] = rows.map((r) => {
    const views = readSourceCount(r.views);
    const followerCount = readSourceCount(r.author_follower_count);
    const first = readSourceCount(r.first_views);
    const latest = readSourceCount(r.latest_views);
    return {
      id: r.id,
      externalId: r.external_id,
      caption: r.caption,
      url: r.url,
      thumbUrl: r.thumb_url,
      views,
      likes: readSourceCount(r.likes),
      comments: readSourceCount(r.comments),
      shares: readSourceCount(r.shares),
      saves: readSourceCount(r.saves),
      followerCount,
      reachMultiple: reachMultiple(views, followerCount),
      postedAt: readSourceTimestamp(r.posted_at),
      viewsGained: first != null && latest != null ? latest - first : null,
      draftId: r.draft_id,
      draftHook: r.draft_hook,
      qualityScore: r.quality_score,
    };
  });

  return {
    handle: account.handle,
    platform: account.platform,
    followerCount: tracking.followerCount,
    followerDelta: tracking.followerDelta,
    followerSeries: tracking.followerSeries,
    posts,
    trackingHandle: account.handle,
  };
}
