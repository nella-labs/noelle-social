import { Hono } from "hono";
import { PostDraftCreateSchema, type PostDraftCreate } from "@noelle/contracts";
import { noelleDb } from "../lib/db.js";
import { loadEnv } from "../env.js";
import { resolveAutoCurateConfig } from "../lib/content-autocurate.js";
import { admitGeneratedPostDraft } from "../lib/post-draft-admission-db.js";
import { sanitizeForJsonb } from "./outbound.js";

// POST /api/post-drafts — HMAC-signed. The post-drafter worker pushes one
// generated post for an approved idea (one push per target platform — an idea
// fans out into an X variant + a LinkedIn variant). We INSERT noelle.post_drafts
// and advance the owning idea to 'drafted'.
//
// The draft is attributed to the IDEA's owner (org + instance), NOT resolved
// from the platform — so an X variant doesn't require a live X instance, and
// every variant of a cross-platform idea shares the idea's owner.
//
// We do NOT supersede prior drafts: regenerating an idea (or "+ Version") leaves
// the earlier drafts in place as versions. The Drafts board shows the latest per
// (idea, platform); the detail view cycles all versions.

const postDrafts = new Hono();

postDrafts.post("/api/post-drafts", async (c) => {
  let payload: PostDraftCreate;
  try {
    payload = sanitizeForJsonb(PostDraftCreateSchema.parse(await c.req.json()));
  } catch (err) {
    return c.json(
      { error: "invalid_body", detail: err instanceof Error ? err.message : String(err) },
      400,
    );
  }

  const sql = noelleDb();
  try {
    // The owning instance's role rides along (join) — auto-curate is Vega-only,
    // so the gate below needs to know whether this idea belongs to an x_intern.
    const idea = (
      await sql<Array<{ org_id: string; agent_instance_id: string; role: string }>>`
        select pi.org_id, pi.agent_instance_id, ai.role
        from noelle.post_ideas pi
        join noelle.agent_instances ai on ai.id = pi.agent_instance_id and ai.org_id = pi.org_id
        where pi.id = ${payload.ideaId} limit 1
      `
    )[0];
    if (!idea) {
      return c.json({ error: "idea_not_found", detail: `no idea ${payload.ideaId}` }, 404);
    }
    if (payload.generationRequestId) {
      const [request] = await sql<Array<{ id: string }>>`
        select id
        from noelle.post_generation_requests
        where id = ${payload.generationRequestId}
          and org_id = ${idea.org_id}
          and agent_instance_id = ${idea.agent_instance_id}
          and idea_id = ${payload.ideaId}
        limit 1
      `;
      if (!request) {
        return c.json(
          {
            error: "generation_request_not_found",
            detail: `no matching post generation request ${payload.generationRequestId}`,
          },
          400,
        );
      }
    }

    const rows = await sql<Array<{ id: string }>>`
      -- Carry forward the operator's mark. Regenerating (chat-refine / "+ Version")
      -- INSERTs a NEW version rather than superseding, and the board shows the
      -- latest version per (idea, platform). If the operator had marked the prior
      -- version ready/posted, a fresh 'draft' version would SHADOW that mark and the
      -- post would silently drop back to Draft. So the new version inherits the prior
      -- latest version's status+stage. MCP requests always start as drafts for review.
      with prev as (
        select status, stage from noelle.post_drafts
        where idea_id = ${payload.ideaId} and platform = ${payload.platform}
          and ${payload.generationRequestId ?? null}::uuid is null
        order by created_at desc
        limit 1
      ),
      ins as (
        insert into noelle.post_drafts
          (org_id, agent_instance_id, idea_id, platform, body, hook, char_count,
           source_engine, model, quality_score, quality_passed, verifier_meta, generation_request_id, status, stage)
        select
          ${idea.org_id}, ${idea.agent_instance_id}, ${payload.ideaId}, ${payload.platform},
          ${payload.body}, ${payload.hook ?? null}, ${payload.charCount}, ${payload.sourceEngine ?? null},
          ${payload.model ?? null}, ${payload.qualityScore ?? null}, ${payload.qualityPassed ?? null},
          ${payload.verifierMeta ? sql.json(payload.verifierMeta) : null}, ${payload.generationRequestId ?? null},
          coalesce((select status from prev), 'draft'),
          coalesce((select stage from prev), 'draft')
        returning id
      ),
      upd as (
        update noelle.post_ideas
        set status = 'drafted', updated_at = now()
        where id = ${payload.ideaId} and status not in ('published', 'dismissed')
      )
      select id from ins
    `;
    const draftId = rows[0]?.id;
    if (!draftId) return c.json({ error: "post_draft_insert_failed", detail: "no row" }, 500);

    if (payload.generationRequestId) {
      await updateGenerationRequestStatus(sql, payload.generationRequestId, payload.generationComplete === true);
    }

    // Explicit creation requests always stop at review, including revisions of
    // previously ready posts. Only ordinary lane drafts may enter a schedule.
    if (!payload.generationRequestId) {
      await admitGeneratedPostDraft(sql, {
        payload, owner: idea, draftId, config: resolveAutoCurateConfig(loadEnv()),
      }).catch((err) => {
        console.error("[post-drafts] admission failed (non-fatal)", err instanceof Error ? err.message : String(err));
      });
    }

    return c.json({ draft_id: draftId, idea_id: payload.ideaId }, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[post-drafts] insert failed", msg);
    return c.json({ error: "post_draft_insert_failed", detail: msg }, 500);
  }
});

async function updateGenerationRequestStatus(
  sql: ReturnType<typeof noelleDb>,
  requestId: string,
  generationComplete: boolean,
): Promise<void> {
  const rows = await sql<
    Array<{
      platforms: string[];
      review_required: boolean;
      missing: string[];
      failed: boolean;
      unreviewed: boolean;
      generation_complete: boolean;
    }>
  >`
    with req as (
      select id, platforms, review_required, ${generationComplete}::boolean as generation_complete
      from noelle.post_generation_requests where id = ${requestId} limit 1
    ), drafts as (
      select platform, quality_passed, verifier_meta
      from noelle.post_drafts
      where generation_request_id = ${requestId}
    )
    select
      req.platforms,
      req.review_required,
      req.generation_complete,
      array(
        select p from unnest(req.platforms) p
        where not exists (select 1 from drafts d where d.platform = p)
      )::text[] as missing,
      exists (select 1 from drafts where quality_passed = false) as failed,
      exists (select 1 from drafts where quality_passed is null or verifier_meta is null) as unreviewed
    from req
  `;
  const row = rows[0];
  if (!row) return;
  const complete = row.generation_complete && row.missing.length === 0;
  const status = !complete
    ? "drafting"
    : row.failed
      ? "needs_review"
      : row.review_required && row.unreviewed
        ? "review_pending"
        : "drafted";
  await sql`
    update noelle.post_generation_requests
    set status = ${status},
        completed_at = case when ${complete} then coalesce(completed_at, now()) else null end,
        updated_at = now()
    where id = ${requestId}
  `;
  if (complete && status !== "review_pending") {
    await sql`
      update noelle.post_ideas
      set generation_review_required = false,
          generation_request_id = null,
          updated_at = now()
      where generation_request_id = ${requestId}
    `;
  }
}

export { postDrafts };
