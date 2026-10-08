import type { Sql } from "postgres";
import { readSourceCount } from "@noelle/runtime/source-values";

// Grounding material for the studio generators: the distilled Video Brand Guide
// (video_ultra_profiles) + the top-performing clips (with their teardowns).

export interface UltraProfileRow {
  platform: string;
  scope: string;
  subject: string;
  profile: unknown;
  avg_views: string | null;
  clips_analyzed: number;
  /** timestamptz → Date (postgres default parser); when the guide was last rebuilt. */
  refreshed_at: Date | null;
}

export async function loadUltraProfiles(sql: Sql, instanceId: string, limit = 12): Promise<UltraProfileRow[]> {
  const rows = await sql<UltraProfileRow[]>`
    select platform, scope, subject, profile, avg_views, clips_analyzed, refreshed_at
    from noelle.video_ultra_profiles
    where agent_instance_id = ${instanceId}
    order by clips_analyzed desc nulls last
    limit ${limit}`;
  return [...rows];
}

export interface ClipBrief {
  id: string;
  author_handle: string;
  caption: string;
  views: number | null;
  likes: number | null;
  teardown: unknown | null;
}
type StoredClipBrief = Omit<ClipBrief, "views" | "likes"> & { views: string | null; likes: string | null };
function normalizeClip(row: StoredClipBrief): ClipBrief {
  return { ...row, views: readSourceCount(row.views), likes: readSourceCount(row.likes) };
}

/** Top-performing clips (with teardown when analysed) — the strongest exemplars. */
export async function loadTopClips(sql: Sql, instanceId: string, limit = 12): Promise<ClipBrief[]> {
  const rows = await sql<StoredClipBrief[]>`
    select c.id, c.author_handle, c.caption, c.views::text,c.likes::text,t.teardown
    from noelle.video_clips c
    left join noelle.video_teardowns t on t.clip_id = c.id
    where c.agent_instance_id = ${instanceId}
    order by case when c.views between 0 and ${Number.MAX_SAFE_INTEGER} then c.views end desc nulls last
    limit ${limit}`;
  return rows.map(normalizeClip);
}

/**
 * Semantic exemplar retrieval (Phase 3, the function 0068's comment promised).
 * Cosine-ranks the instance's embedded clips (video_clips.embedding, backfilled
 * by the distiller with Voyage voyage-3-large) against a query vector — the idea
 * hook+concept for the scripter, or the objective for the ideator — so each post
 * is built from the clips most RELEVANT to it, not just the most-viewed. Uses the
 * HNSW vector_cosine index. Returns [] when no clip is embedded yet, so callers
 * fall back to the views-ordered `loadTopClips`/`loadExemplarClips`.
 */
export async function selectVideoExemplars(
  sql: Sql,
  instanceId: string,
  queryVec: number[],
  limit = 6,
): Promise<ClipBrief[]> {
  if (queryVec.length === 0) return [];
  const vec = `[${queryVec.join(",")}]`;
  const rows = await sql<StoredClipBrief[]>`
    select c.id, c.author_handle, c.caption, c.views::text,c.likes::text,t.teardown
    from noelle.video_clips c
    left join noelle.video_teardowns t on t.clip_id = c.id
    where c.agent_instance_id = ${instanceId} and c.embedding is not null
    order by c.embedding <=> ${vec}::vector
    limit ${limit}`;
  return rows.map(normalizeClip);
}

/** Exemplars for an idea: the inspiration clips if set, else the top clips. */
export async function loadExemplarClips(
  sql: Sql,
  instanceId: string,
  clipIds: string[],
  limit = 6,
): Promise<ClipBrief[]> {
  if (clipIds.length > 0) {
    // Compare as text, NOT `c.id = any(${clipIds})` — postgres casts each array
    // element to uuid for that form and THROWS on a non-uuid id (e.g. a stale
    // seed ref or an LLM-hallucinated id), which would fail the whole scripter
    // run and produce no draft. `id::text` matches real ids and lets unknown
    // ids fall through to the top-clips fallback instead of crashing.
    const rows = await sql<StoredClipBrief[]>`
      select c.id, c.author_handle, c.caption, c.views::text,c.likes::text,t.teardown
      from noelle.video_clips c
      left join noelle.video_teardowns t on t.clip_id = c.id
      where c.agent_instance_id = ${instanceId} and c.id::text = any(${clipIds})
      limit ${limit}`;
    if (rows.length > 0) return rows.map(normalizeClip);
  }
  return loadTopClips(sql, instanceId, limit);
}
