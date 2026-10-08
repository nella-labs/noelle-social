import type { Sql } from "postgres";

// DB layer for the post-drafter worker: claim approved ideas, fetch the text of
// the posts an idea was inspired by (for grounding), and read the operator's
// standing drafter rules. Mirrors the leads-db claim pattern.

export interface ApprovedIdea {
  id: string;
  orgId: string;
  agentInstanceId: string;
  platform: string;
  /** The platforms this idea fans out into (one draft per entry). */
  targetPlatforms: string[];
  /** When non-null, the subset to (re)draft this tick (a per-platform regen). */
  pendingPlatforms: string[] | null;
  generationRequestId: string | null;
  generationReviewRequired: boolean;
  hook: string;
  thesis: string | null;
  angle: string | null;
  pillar: string | null;
  inspirationRefs: {
    kind: string;
    leadId?: string;
    url?: string;
    author?: string;
    note?: string;
  }[];
}

/**
 * Atomically claim the oldest N status='approved' ideas, flipping them to
 * 'drafting' (FOR UPDATE SKIP LOCKED). Returns the claimed ideas so the worker
 * can draft each.
 */
export async function claimApprovedIdeas(
  sql: Sql,
  args: { agentInstanceId: string; batch: number; requestOnly?: boolean },
): Promise<ApprovedIdea[]> {
  const rows = await sql<
    {
      id: string;
      org_id: string;
      agent_instance_id: string;
      platform: string;
      target_platforms: string[] | null;
      pending_platforms: string[] | null;
      generation_request_id: string | null;
      generation_review_required: boolean | null;
      hook: string;
      thesis: string | null;
      angle: string | null;
      pillar: string | null;
      inspiration_refs: unknown;
    }[]
  >`
    update noelle.post_ideas
    set status = 'drafting', updated_at = now()
    where id in (
      select pi.id from noelle.post_ideas pi
      where pi.agent_instance_id = ${args.agentInstanceId}
        and pi.status = 'approved'
        and (
          ${args.requestOnly === true} = false
          or exists (
            select 1
            from noelle.post_generation_requests r
            where r.id = pi.generation_request_id
              and r.org_id = pi.org_id
              and r.agent_instance_id = pi.agent_instance_id
              and r.idea_id = pi.id
              and r.status in ('queued', 'drafting', 'review_pending')
          )
        )
      order by pi.created_at asc
      for update skip locked
      limit ${args.batch}
    )
    returning id, org_id, agent_instance_id, platform, target_platforms,
              pending_platforms, generation_request_id, generation_review_required,
              hook, thesis, angle, pillar, inspiration_refs
  `;
  const requestIds = rows
    .map((r) => r.generation_request_id)
    .filter((id): id is string => Boolean(id));
  if (requestIds.length > 0) {
    await sql`
      update noelle.post_generation_requests
      set status = 'drafting', updated_at = now()
      where id in ${sql(requestIds)} and status = 'queued'
    `;
  }
  return rows.map((r) => ({
    id: r.id,
    orgId: r.org_id,
    agentInstanceId: r.agent_instance_id,
    platform: r.platform,
    // Defend against a legacy row with a null/empty set: fall back to its home
    // platform so it still drafts exactly one post.
    targetPlatforms:
      Array.isArray(r.target_platforms) && r.target_platforms.length > 0
        ? r.target_platforms
        : [r.platform],
    pendingPlatforms:
      Array.isArray(r.pending_platforms) && r.pending_platforms.length > 0
        ? r.pending_platforms
        : null,
    generationRequestId: r.generation_request_id ?? null,
    generationReviewRequired: r.generation_review_required === true,
    hook: r.hook,
    thesis: r.thesis,
    angle: r.angle,
    pillar: r.pillar,
    inspirationRefs: Array.isArray(r.inspiration_refs)
      ? (r.inspiration_refs as ApprovedIdea["inspirationRefs"])
      : [],
  }));
}

/**
 * Clear an idea's pending_platforms once it's been (re)drafted, so a future tick
 * doesn't redraft the same subset. Idempotent; safe to call after each idea.
 */
export async function clearPendingPlatforms(sql: Sql, ideaId: string): Promise<void> {
  await sql`
    update noelle.post_ideas
    set pending_platforms = null
    where id = ${ideaId}
  `;
}

/** If a claimed idea errors mid-draft, return it to 'approved' for a retry. */
export async function releaseIdeaToApproved(sql: Sql, ideaId: string): Promise<void> {
  await sql`
    update noelle.post_ideas
    set status = 'approved', updated_at = now()
    where id = ${ideaId}
      and (status = 'drafting' or (status = 'drafted' and generation_request_id is not null))
  `;
}

/**
 * Resolve cited saved posts by legacy external ID or the lead UUID used by
 * replied-post sources. Include the operator's sent reply for UUID references,
 * keeping it separate from the original author's text for drafting and review.
 * Legacy external IDs stay agent-scoped because different instances can save
 * their own copies. Explicit UUID citations intentionally allow the operator's
 * same-org history across instances, matching getRepliedPostSources.
 */
export async function getInspirationPostTexts(
  sql: Sql,
  args: { agentInstanceId: string; externalIds: string[] },
): Promise<string[]> {
  if (args.externalIds.length === 0) return [];
  const rows = await sql<{ text: string | null; reply: string | null }[]>`
    select l.payload->>'text' as text,
      case when l.id::text = any(${args.externalIds}::text[]) then (
        select coalesce(nullif(d.payload->>'edited_body', ''), d.payload->>'body')
        from noelle.approvals a join noelle.drafts d on d.id = a.draft_id
        where a.lead_id = l.id and a.org_id = l.org_id and d.org_id = l.org_id
          and a.status = 'sent' and coalesce(d.payload->>'kind', 'reply') = 'reply'
        order by a.decided_at desc nulls last, a.created_at desc limit 1
      ) end as reply
    from noelle.leads l
    where l.org_id = (select org_id from noelle.agent_instances where id = ${args.agentInstanceId})
      and ((l.agent_instance_id = ${args.agentInstanceId}
            and l.external_id = any(${args.externalIds}::text[]))
        or l.id::text = any(${args.externalIds}::text[]))
  `;
  return rows.flatMap((r) => r.text
    ? [r.reply ? `Original source post:\n${r.text}\n\nOperator's sent reply:\n${r.reply}` : r.text]
    : []);
}

/**
 * The operator's pinned standing rules for a lane (drafter_notes scope='standing',
 * pinned=true), newest first. Injected into every post-draft gather so guidance
 * the operator pinned once keeps applying.
 */
export async function getStandingRules(
  sql: Sql,
  args: { agentInstanceId: string; lane: string },
): Promise<string[]> {
  const rows = await sql<{ body: string }[]>`
    select body from noelle.drafter_notes
    where agent_instance_id = ${args.agentInstanceId}
      and lane = ${args.lane}
      and scope = 'standing'
      and pinned = true
    order by created_at desc
    limit 20
  `;
  return rows.map((r) => r.body);
}

/**
 * The operator's chat guidance attached to ONE idea (drafter_notes scope='post',
 * role='operator'), oldest first — the framing/anecdote/avoid notes for this post.
 */
export async function getIdeaChatGuidance(sql: Sql, ideaId: string): Promise<string[]> {
  const rows = await sql<{ body: string }[]>`
    select body from noelle.drafter_notes
    where idea_id = ${ideaId} and scope = 'post' and role = 'operator'
    order by created_at asc
    limit 30
  `;
  return rows.map((r) => r.body);
}
