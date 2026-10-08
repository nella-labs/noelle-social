import { readSql as sql } from "@/lib/db";
import { getOrgBySlug, getAgentInstance } from "@/lib/queries";
import { reachMultiple } from "@/lib/video-metrics";
import { readSourceCount, readSourceTimestamp } from "@noelle/runtime/source-values";

// Read models for Nova's studio (W4 ideas + drafts). Tenancy: resolveNovaInstance
// goes through getOrgBySlug (asserts membership); every read fetches the instance
// via getAgentInstance (IDOR guard) then scopes by org_id.

export interface NovaInstanceRef {
  orgId: string;
  instanceId: string;
  /** Operator objective (null when unset → manifest default applies). */
  objective: string | null;
  /** Operator-set display name (null → fixture default). */
  displayName: string | null;
}

/** Resolve the org's Nova (video_intern) instance from the slug, membership-gated. */
export async function resolveNovaInstance(orgSlug: string): Promise<NovaInstanceRef | null> {
  const org = await getOrgBySlug(orgSlug);
  if (!org) return null;
  const rows = await sql<{ id: string; objective: string | null; display_name: string | null }[]>`
    select id, objective, display_name from noelle.agent_instances
    where org_id = ${org.id} and role = 'video_intern'
    limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  return { orgId: org.id, instanceId: row.id, objective: row.objective, displayName: row.display_name };
}

/**
 * A harvested clip that inspired an idea/draft, resolved from
 * video_ideas.inspiration_clip_ids. Carries the performance Nova reached for it
 * with — views, the creator's follower count, and the derived reach_multiple
 * (views ÷ followers; null when the follower count is unknown).
 */
export interface InspirationClip {
  id: string;
  platform: string;
  external_id: string;
  author_handle: string;
  caption: string;
  url: string;
  thumb_url: string | null;
  source_kind: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  author_follower_count: number | null;
  reach_multiple: number | null;
  deep_tier: boolean;
  posted_at: string | null;
}

type StoredInspirationClip = Omit<InspirationClip, "views" | "likes" | "comments" | "author_follower_count" | "reach_multiple"> & {
  views: string | null;
  likes: string | null;
  comments: string | null;
  author_follower_count: string | null;
};

function normalizeInspirationClip(row: StoredInspirationClip): InspirationClip {
  const views = readSourceCount(row.views);
  const followers = readSourceCount(row.author_follower_count);
  return { ...row, views, likes: readSourceCount(row.likes), comments: readSourceCount(row.comments),
    author_follower_count: followers, reach_multiple: reachMultiple(views, followers),
    posted_at: readSourceTimestamp(row.posted_at) };
}

export interface VideoIdeaRow {
  id: string;
  hook: string;
  concept: string | null;
  angle: string | null;
  pillar: string | null;
  status: string;
  suggested_day: string | null;
  batch_id: string | null;
  inspiration_clip_ids: string[];
  /** Resolved inspiration clips (populated by getStudioBoard), ordered + filtered to ones still on file. */
  inspiration: InspirationClip[];
  /** True when `inspiration` is the top-clips fallback (no own resolvable refs), so the UI can say so. */
  inspirationIsFallback: boolean;
  created_at: string;
}

export async function listVideoIdeas(instanceId: string): Promise<VideoIdeaRow[]> {
  const inst = await getAgentInstance(instanceId);
  if (!inst) return [];
  const rows = await sql<Omit<VideoIdeaRow, "inspiration" | "inspirationIsFallback">[]>`
    select id, hook, concept, angle, pillar, status,
           suggested_day::text as suggested_day, batch_id,
           inspiration_clip_ids, created_at::text as created_at
    from noelle.video_ideas
    where agent_instance_id = ${inst.id} and org_id = ${inst.org_id}
      and status <> 'dismissed'
    order by created_at desc
  `;
  return rows.map((r) => ({ ...r, inspiration: [], inspirationIsFallback: false }));
}

export interface VideoDraftRow {
  id: string;
  idea_id: string;
  idea_hook: string;
  structure: unknown;
  script: string;
  final_script: string | null;
  transitions: unknown;
  sounds: unknown;
  graph_specs: unknown;
  status: string;
  quality_passed: boolean | null;
  verifier_meta: unknown;
  inspiration_clip_ids: string[];
  /** Resolved inspiration clips (populated by getStudioBoard) — the reels this script was built from. */
  inspiration: InspirationClip[];
  /** True when `inspiration` is the top-clips fallback (no own resolvable refs), so the UI can say so. */
  inspirationIsFallback: boolean;
  created_at: string;
}

export async function listVideoDrafts(instanceId: string): Promise<VideoDraftRow[]> {
  const inst = await getAgentInstance(instanceId);
  if (!inst) return [];
  const rows = await sql<Omit<VideoDraftRow, "inspiration" | "inspirationIsFallback">[]>`
    select d.id, d.idea_id, i.hook as idea_hook, d.structure, d.script, d.final_script,
           d.transitions, d.sounds, d.graph_specs, d.status, d.quality_passed,
           d.verifier_meta, i.inspiration_clip_ids, d.created_at::text as created_at
    from noelle.video_drafts d
    join noelle.video_ideas i on i.id = d.idea_id
      and i.org_id = d.org_id and i.agent_instance_id = d.agent_instance_id
    where d.agent_instance_id = ${inst.id} and d.org_id = ${inst.org_id}
      and d.status <> 'dismissed'
    order by d.created_at desc
  `;
  return rows.map((r) => ({ ...r, inspiration: [], inspirationIsFallback: false }));
}

/**
 * Resolve a set of clip ids to InspirationClip rows, org-scoped (IDOR guard via
 * getAgentInstance). Returns a Map id→clip so callers can preserve the original
 * inspiration_clip_ids ordering. bigint columns come back as strings.
 */
export async function getInspirationClips(
  instanceId: string,
  clipIds: string[],
): Promise<Map<string, InspirationClip>> {
  const map = new Map<string, InspirationClip>();
  const ids = [...new Set(clipIds)].filter(Boolean);
  if (ids.length === 0) return map;
  const inst = await getAgentInstance(instanceId);
  if (!inst) return map;
  const rows = await sql<StoredInspirationClip[]>`
    select id, platform, external_id, author_handle, caption, url, thumb_url, source_kind,
           views::text as views, likes::text as likes, comments::text as comments,
           author_follower_count::text as author_follower_count,
           deep_tier, posted_at::text as posted_at
    from noelle.video_clips
    where agent_instance_id = ${inst.id} and org_id = ${inst.org_id}
      and id::text = any(${ids})
  `;
  for (const row of rows) map.set(row.id, normalizeInspirationClip(row));
  return map;
}

/**
 * Top harvested clips for the instance (by views), as InspirationClip[] — the
 * fallback shown when an idea/draft has no resolvable inspiration of its own
 * (e.g. older/seed-generated ones), so the reels + reach metrics — the whole
 * point — are always visible. Mirrors the scripter's loadTopClips fallback.
 */
export async function listTopInspirationClips(instanceId: string, limit = 4): Promise<InspirationClip[]> {
  const inst = await getAgentInstance(instanceId);
  if (!inst) return [];
  const rows = await sql<StoredInspirationClip[]>`
    select id, platform, external_id, author_handle, caption, url, thumb_url, source_kind,
           views::text as views, likes::text as likes, comments::text as comments,
           author_follower_count::text as author_follower_count,
           deep_tier, posted_at::text as posted_at
    from noelle.video_clips
    where agent_instance_id = ${inst.id} and org_id = ${inst.org_id}
    order by case when video_clips.views between 0 and ${Number.MAX_SAFE_INTEGER} then video_clips.views end desc nulls last
    limit ${limit}
  `;
  return rows.map(normalizeInspirationClip);
}

export interface StudioBoard {
  ideas: VideoIdeaRow[];
  drafts: VideoDraftRow[];
}

export async function getStudioBoard(instanceId: string): Promise<StudioBoard> {
  const [ideas, drafts] = await Promise.all([listVideoIdeas(instanceId), listVideoDrafts(instanceId)]);

  // One round trip resolves every inspiration clip referenced across the board;
  // we then hydrate each idea/draft, preserving inspiration_clip_ids ordering.
