import { cache } from "react";
import { assertOrgMember } from "@noelle/runtime";
import type { InspirationRef, PostIdeaStatus, PostDraftStatus } from "@noelle/contracts";
import { pgOrgMembersClient, readSql as sql } from "@/lib/db";
import { currentMediaLinks } from "@/lib/current-media-links";

// Read helpers for the Posts lane (noelle.post_ideas / noelle.post_drafts).
// Tenancy: Cloud SQL has no RLS, so every helper asserts org membership before
// returning rows (same contract as queries.ts).

async function assertMember(orgId: string, userId: string): Promise<void> {
  await assertOrgMember(pgOrgMembersClient(), userId, orgId);
}

export interface PostIdeaRow {
  id: string;
  platform: string;
  /** The platforms this idea fans out into (e.g. ["linkedin","x"]). */
  target_platforms: string[];
  /** The subset currently (re)generating (a per-platform "+ Version"/Refine);
   *  null = a full generate of every target platform. Cleared once drafted. */
  pending_platforms: string[] | null;
  hook: string;
  thesis: string | null;
  angle: string | null;
  pillar: string | null;
  inspiration_refs: InspirationRef[];
  suggested_day: string | null;
  batch_id: string | null;
  status: PostIdeaStatus;
  created_at: string;
}

/**
 * Idea cards for the org's Posts lane. `statuses` filters the lifecycle bucket
 * (default: the active board — everything except dismissed/published).
 * `platform` (linkedin|x|reddit) scopes the Content workspace to a single
 * platform; pass null/undefined for the cross-platform "All" view. Newest
 * first, with batch ideas grouped by suggested_day for the calendar.
 *
 * The platform predicate uses one bound-value OR across both the filtered and
 * cross-platform views.
 */
export const listPostIdeasForOrg = cache(async (
  orgId: string,
  statuses: readonly PostIdeaStatus[] = ["proposed", "approved", "drafting", "drafted", "ready"],
  platform: string | null = null,
): Promise<PostIdeaRow[]> => {
  const userId = await requiredUserId();
  await assertMember(orgId, userId);
  const rows = await sql<PostIdeaRow[]>`
    select
      id, platform,
      coalesce(target_platforms, array[platform]) as target_platforms,
      pending_platforms,
      hook, thesis, angle, pillar,
      coalesce(inspiration_refs, '[]'::jsonb) as inspiration_refs,
      suggested_day::text as suggested_day,
      batch_id,
      status,
      created_at::text as created_at
    from noelle.post_ideas
    where org_id = ${orgId}
      and status = any(${statuses as unknown as string[]})
      -- A cross-platform idea shows under EACH platform it targets (not just its
      -- home platform), so the X filter surfaces ideas that fan out to X.
      and (${platform}::text is null or ${platform} = any(coalesce(target_platforms, array[platform])))
    order by
      (suggested_day is null) asc,  -- batch (dated) ideas first, grouped by day
      suggested_day asc,
      created_at desc
  `;
  return rows.map((r) => ({
    ...r,
    inspiration_refs: Array.isArray(r.inspiration_refs) ? r.inspiration_refs : [],
  }));
});

export interface VerifierTrace {
  pass: boolean;
  scores: { voice: number; grounding: number; relevance: number; format: number };
  reasons: string[];
  attempts: number;
}

export interface PostDraftRow {
  id: string;
  idea_id: string;
  platform: string;
  body: string;
  final_body: string | null;
  char_count: number | null;
  posted_url: string | null;
  // Rich per-column fields (0060). draft_hook is the column's own HOOK line.
  draft_hook: string | null;
  cta: string | null;
  notes: string | null;
  category: string | null;
  stage: string;
  quality_score: number | null;
  quality_passed: boolean | null;
  verifier_meta: VerifierTrace | null;
  status: PostDraftStatus;
  created_at: string;
  // Joined from the idea for the Drafts board (the idea's hook = the set title).
  hook: string;
  suggested_day: string | null;
  // Inspiration refs carried over from the originating idea so the operator can
  // see who/what a draft drew from and avoid copy-pasting them.
  inspiration_refs: InspirationRef[];
}

/**
 * Generated post drafts for the org, newest first. Joined to the idea so the
 * Drafts board can show the originating hook + scheduled day.
 */
export const listPostDraftsForOrg = cache(async (
  orgId: string,
  statuses: readonly PostDraftStatus[] = ["draft", "ready"],
  platform: string | null = null,
): Promise<PostDraftRow[]> => {
  const userId = await requiredUserId();
  await assertMember(orgId, userId);
  // Versions accumulate (the drafter no longer supersedes prior drafts), so the
  // board shows only the LATEST draft per (idea, platform) — distinct on, then
  // re-sorted for display. The detail/refine view cycles all versions.
  const rows = await sql<PostDraftRow[]>`
    with latest as (
      select distinct on (d.idea_id, d.platform)
        d.id, d.idea_id, d.platform, d.body, d.final_body, d.char_count, d.posted_url,
        d.hook as draft_hook, d.cta, d.notes, d.category, d.stage,
        d.quality_score, d.quality_passed, d.verifier_meta, d.status, d.created_at,
        i.hook as hook, i.suggested_day as suggested_day,
        coalesce(i.inspiration_refs, '[]'::jsonb) as inspiration_refs
      from noelle.post_drafts d
      join noelle.post_ideas i on i.id = d.idea_id
        and i.org_id = d.org_id and i.agent_instance_id = d.agent_instance_id
      join noelle.agent_instances ai on ai.id = d.agent_instance_id and ai.org_id = d.org_id
      where d.org_id = ${orgId}
        and d.status = any(${statuses as unknown as string[]})
        and (${platform}::text is null or d.platform = ${platform})
      order by d.idea_id, d.platform, d.created_at desc
    )
    select
      id, idea_id, platform, body, final_body, char_count, posted_url,
      draft_hook, cta, notes, category, stage,
      quality_score, quality_passed, verifier_meta, status,
      created_at::text as created_at, hook,
      suggested_day::text as suggested_day, inspiration_refs
    from latest
    order by (suggested_day is null) asc, suggested_day asc, created_at desc
  `;
  return rows.map((r) => ({
    ...r,
    inspiration_refs: Array.isArray(r.inspiration_refs) ? r.inspiration_refs : [],
  }));
});

export interface DrafterNoteRow {
  id: string;
  role: string;
  body: string;
  pinned: boolean;
  created_at: string;
}

export interface PostThread {
  idea: PostIdeaRow;
  /** ALL live drafts for the idea (every version, every platform), newest per
   * platform first. The detail view groups them by platform into side-by-side
   * columns and cycles versions within each. */
  drafts: PostDraftRow[];
  /** Media attached to this idea (the Short-video column + image attachments). */
  media: ContentMediaRow[];
  notes: DrafterNoteRow[];
}

/**
 * One idea's full review thread: the cross-platform idea, every live draft
 * (all versions across all platforms), and the drafter-chat turns attached to
 * it. Powers the side-by-side post detail / refine page. Returns null if the
 * idea doesn't exist (or isn't in this org).
 */
export const getPostThread = cache(async (ideaId: string): Promise<PostThread | null> => {
  const userId = await requiredUserId();
  const ideaRows = await sql<(PostIdeaRow & { org_id: string; agent_instance_id: string })[]>`
    select
      id, org_id, agent_instance_id, platform,
      coalesce(target_platforms, array[platform]) as target_platforms,
      pending_platforms,
      hook, thesis, angle, pillar,
      coalesce(inspiration_refs, '[]'::jsonb) as inspiration_refs,
      suggested_day::text as suggested_day, batch_id, status,
      created_at::text as created_at
    from noelle.post_ideas where id = ${ideaId}
      and exists (select 1 from noelle.agent_instances ai
        where ai.id = post_ideas.agent_instance_id and ai.org_id = post_ideas.org_id)
    limit 1
  `;
  const ideaRow = ideaRows[0];
  if (!ideaRow) return null;
  await assertMember(ideaRow.org_id, userId);

  const draftRows = await sql<PostDraftRow[]>`
    select
      d.id, d.idea_id, d.platform, d.body, d.final_body, d.char_count, d.posted_url,
      d.hook as draft_hook, d.cta, d.notes, d.category, d.stage,
      d.quality_score, d.quality_passed, d.verifier_meta, d.status,
      d.created_at::text as created_at,
      i.hook as hook, i.suggested_day::text as suggested_day,
      coalesce(i.inspiration_refs, '[]'::jsonb) as inspiration_refs
    from noelle.post_drafts d
    join noelle.post_ideas i on i.id = d.idea_id
      and i.org_id = d.org_id and i.agent_instance_id = d.agent_instance_id
    -- include 'published' so a Posted column stays visible (with "Unpost"); the
    -- board (listPostDraftsForOrg) still archives published off the active list.
    where d.idea_id = ${ideaId} and d.status in ('draft', 'ready', 'published')
      and d.org_id = ${ideaRow.org_id} and d.agent_instance_id = ${ideaRow.agent_instance_id}
    order by d.platform asc, d.created_at desc
  `;

  const notes = await sql<DrafterNoteRow[]>`
    select id, role, body, pinned, created_at::text as created_at
    from noelle.drafter_notes
    where idea_id = ${ideaId} and scope = 'post'
      and org_id = ${ideaRow.org_id} and agent_instance_id = ${ideaRow.agent_instance_id}
    order by created_at asc
  `;

  const media = await sql<ContentMediaRow[]>`
    select
      id, platform, kind, mime_type, url, width, height,
      duration_ms, bytes::int as bytes, idea_id, draft_id, caption, status,
      created_at::text as created_at
    from noelle.content_media
    where idea_id = ${ideaId} and status <> 'failed'
      and org_id = ${ideaRow.org_id}
      and (agent_instance_id is null or agent_instance_id = ${ideaRow.agent_instance_id})
    order by created_at desc
  `;

  const { org_id: _org, agent_instance_id: _instance, ...idea } = ideaRow;
  return {
    idea: { ...idea, inspiration_refs: Array.isArray(idea.inspiration_refs) ? idea.inspiration_refs : [] },
    drafts: draftRows.map((d) => ({
      ...d,
      inspiration_refs: Array.isArray(d.inspiration_refs) ? d.inspiration_refs : [],
    })),
    media: await currentMediaLinks(ideaRow.org_id, media),
    notes: [...notes],
  };
});

export interface IntelligenceStatus {
  playbookCount: number;
  lastAnalyzedAt: string | null;
}

/**
 * Engagement Analyst status for the Intelligence box: how many top-performer
 * playbooks the instance has, and when the newest was distilled.
 */
export const getIntelligenceStatus = cache(async (
  orgId: string,
  instanceId: string,
): Promise<IntelligenceStatus> => {
  const userId = await requiredUserId();
  await assertMember(orgId, userId);
  const rows = await sql<{ count: string; latest: string | null }[]>`
    select count(*)::text as count, max(p.generated_at)::text as latest
    from noelle.watchlist_playbooks p
    join noelle.agent_instances ai on ai.id = p.agent_instance_id and ai.org_id = p.org_id
    where p.org_id = ${orgId} and p.agent_instance_id = ${instanceId}
  `;
  return {
    playbookCount: Number(rows[0]?.count ?? 0),
    lastAnalyzedAt: rows[0]?.latest ?? null,
  };
});

export interface ContentMediaRow {
  id: string;
  platform: string | null;
  kind: string;
  mime_type: string | null;
  url: string | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  bytes: number | null;
  idea_id: string | null;
  draft_id: string | null;
  caption: string | null;
  status: string;
  created_at: string;
}

/**
 * Media assets for the org's Content workspace, newest first. `platform` scopes
 * to one platform (null = the cross-platform "All" view). Same bound-value OR
 * predicate as the post lists — never a conditional sql fragment.
 */
export const listContentMediaForOrg = cache(async (
  orgId: string,
  platform: string | null = null,
): Promise<ContentMediaRow[]> => {
  const userId = await requiredUserId();
  await assertMember(orgId, userId);
  const rows = await sql<ContentMediaRow[]>`
    select
      id, platform, kind, mime_type, url, width, height,
      duration_ms, bytes::int as bytes, idea_id, draft_id, caption, status,
      created_at::text as created_at
    from noelle.content_media
    where org_id = ${orgId}
      and status <> 'failed'
      and (${platform}::text is null or platform = ${platform})
    order by created_at desc
  `;
  return currentMediaLinks(orgId, rows);
});

// Share the verified identity owner used by queries.ts.
import { getUserFromCookies } from "@/lib/auth-cookie";
const requiredUserId = cache(async (): Promise<string> => {
  const user = await getUserFromCookies();
  if (!user) throw new Error("not signed in");
  return user.id;
});
