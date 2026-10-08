import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import {
  IdeationTriggerInSchema,
  ManualIdeaInSchema,
  PostDismissInSchema,
  PostGenerateInSchema,
  PostMarkReadyInSchema,
  PostMarkPostedInSchema,
  PostPatchInSchema,
  PostScheduleInSchema,
  PostChatInSchema,
  PostPinNoteInSchema,
  type IdeationTriggerIn,
  type ManualIdeaIn,
  type PostPlatform,
  type PostDismissIn,
  type PostGenerateIn,
  type PostMarkReadyIn,
  type PostMarkPostedIn,
  type PostPatchIn,
  type PostScheduleIn,
  type PostChatIn,
  type PostPinNoteIn,
} from "@noelle/contracts";
import { AmbiguousOutboundOwnerError, isOrgMember, resolveActiveInstanceForPlatform } from "../lib/auth.js";
import { extractStyleDirective, resolveStyleSourceHandle, ContentPostMutationError,
  markContentPostReady, markContentPostPosted, patchContentPostDraft, dismissContentPost,
  scheduleContentPostIdea, requestContentPostGeneration, requestContentPostPolish, replaceContentPostIdea } from "@noelle/runtime";
import { noelleDb } from "../lib/db.js";
import { recordContentEdit } from "../lib/content-edits.js";
import type { AuthContext } from "../middleware/jwt.js";

// User-facing (JWT) Posts-lane routes. Tenancy is enforced by hand — Cloud SQL
// has no RLS — so every handler resolves the owning org and checks membership
// before touching noelle.*.
const posts = new Hono<{ Variables: { auth: AuthContext } }>();
posts.onError((error, c) => {
  if (error instanceof AmbiguousOutboundOwnerError) return c.json({ error: "ambiguous_owner" }, 409);
  if (error instanceof ContentPostMutationError)
    return c.json({ error: error.category }, error.category === "platform_not_polishable" ? 422 : 409);
  console.error("[posts] request failed", error.name);
  return c.json({ error: "post_mutation_failed" }, 500);
});

/** The Monday on/after a given date, as YYYY-MM-DD (UTC). */
function nextMonday(from: Date): string {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const dow = d.getUTCDay(); // 0 Sun .. 6 Sat
  const delta = dow === 1 ? 0 : (8 - dow) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// Resolve the Content lane the operator triggered from into (a) the HOME platform
// that owns the idea + resolves the intern instance, and (b) the platforms the
// produced ideas fan out into.
//   X lane        -> home 'x',        targets ['x']            (Vega ideates)
//   LinkedIn lane -> home 'linkedin', targets ['linkedin']     (Lyra ideates)
//   All (absent)  -> home 'linkedin', targets ['linkedin','x'] (Lyra, fan-out)
// reddit is rejected by the caller (Orion drafts replies, not original posts).
// An explicit targetPlatforms from the body overrides the lane default.
function resolveLaneScope(
  platform: PostPlatform | undefined,
  explicitTargets: PostPlatform[] | undefined,
): { home: PostPlatform; targets: PostPlatform[] } {
  const home: PostPlatform = platform ?? "linkedin";
  const targets =
    explicitTargets && explicitTargets.length > 0
      ? explicitTargets
      : platform
        ? [platform]
        : (["linkedin", "x"] as PostPlatform[]);
  return { home, targets };
}

// POST /api/posts/ideate — operator triggers an ideation run. We enqueue a
// noelle.ideation_requests row; the Lima ideation worker drains it.
posts.post("/api/posts/ideate", async (c) => {
  const auth = c.get("auth");
  let body: IdeationTriggerIn;
  try {
    body = IdeationTriggerInSchema.parse(await c.req.json().catch(() => ({})));
  } catch (err) {
    return c.json({ error: "invalid_body", detail: err instanceof Error ? err.message : String(err) }, 400);
  }

  // Reddit posts are view-only (Orion drafts replies, not original posts), so an
  // ideation run can never target it. Reject loudly rather than enqueue a row no
  // worker will ever drain.
  if (body.platform === "reddit") {
    return c.json({ error: "platform_not_ideatable", detail: "reddit" }, 422);
  }

  // The lane the operator triggered from picks the owning intern (x → Vega,
  // linkedin/All → Lyra) and the fan-out scope. Resolve the instance for the
  // HOME platform; the worker on that intern drains this request.
  const { home, targets } = resolveLaneScope(body.platform, body.targetPlatforms);
  const owner = await resolveActiveInstanceForPlatform(
    home,
    body.orgId && body.agentInstanceId ? { orgId: body.orgId, agentInstanceId: body.agentInstanceId } : undefined,
    { sql: noelleDb() },
  );
  if (!owner) return c.json({ error: "no_active_instance" }, 404);
  if (!(await isOrgMember(auth.userId, owner.org_id))) {
    return c.json({ error: "not_org_member" }, 403);
  }

  const batchId = body.mode === "batch" ? randomUUID() : null;
  const weekStart =
    body.mode === "batch" ? body.weekStart ?? nextMonday(new Date()) : null;

  const sql = noelleDb();
  try {
    await sql`
      insert into noelle.ideation_requests
        (org_id, agent_instance_id, mode, count, topics, week_start, batch_id, target_platforms, status)
      values
        (${owner.org_id}, ${owner.agent_instance_id}, ${body.mode}, ${body.count ?? null},
         ${sql.json(body.topics ?? [])}, ${weekStart}, ${batchId}, ${targets}::text[], 'pending')
    `;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[posts] ideate enqueue failed", msg);
    return c.json({ error: "ideate_enqueue_failed", detail: msg }, 500);
  }

  return c.json({ enqueued: true, mode: body.mode, batch_id: batchId }, 200);
});

// POST /api/posts/manual — operator authors their own idea. Lands as a
// `proposed` LinkedIn idea (no inspiration refs) they can then Generate.
posts.post("/api/posts/manual", async (c) => {
  const auth = c.get("auth");
  let body: ManualIdeaIn;
  try {
    body = ManualIdeaInSchema.parse(await c.req.json().catch(() => ({})));
  } catch (err) {
    return c.json({ error: "invalid_body", detail: err instanceof Error ? err.message : String(err) }, 400);
  }

  if (body.platform === "reddit") {
    return c.json({ error: "platform_not_ideatable", detail: "reddit" }, 422);
  }

  // The lane the operator authored from sets the idea's HOME platform (which
  // intern owns + drafts it) and the fan-out scope. Same mapping as /ideate.
  const { home, targets } = resolveLaneScope(body.platform, body.targetPlatforms);
  const owner = await resolveActiveInstanceForPlatform(
    home,
    body.orgId && body.agentInstanceId ? { orgId: body.orgId, agentInstanceId: body.agentInstanceId } : undefined,
    { sql: noelleDb() },
  );
  if (!owner) return c.json({ error: "no_active_instance" }, 404);
  if (!(await isOrgMember(auth.userId, owner.org_id))) {
    return c.json({ error: "not_org_member" }, 403);
  }

  const sql = noelleDb();
  try {
    const rows = await sql<Array<{ id: string }>>`
      insert into noelle.post_ideas
        (org_id, agent_instance_id, platform, target_platforms, hook, thesis, angle, pillar,
         suggested_day, inspiration_refs, status, source_engine, model)
      values
        (${owner.org_id}, ${owner.agent_instance_id}, ${home}, ${targets}::text[], ${body.hook},
         ${body.thesis ?? null}, ${body.angle ?? null}, ${body.pillar ?? null},
         ${body.suggestedDay ?? null}, '[]'::jsonb, 'proposed', 'manual', 'operator')
      returning id
    `;
    return c.json({ idea_id: rows[0]!.id }, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[posts] manual idea insert failed", msg);
    return c.json({ error: "manual_idea_failed", detail: msg }, 500);
  }
});

// POST /api/posts/:ideaId/generate — flip an idea to approved so the post-drafter
// claims it and fans out to its target platforms. An optional `platforms` body
// scopes a regenerate to a subset (a per-platform "+ Version"); absent ⇒ (re)draft
// every target platform. Re-queues an already-drafted idea (for "+ Version").
posts.post("/api/posts/:ideaId/generate", async (c) => {
  const auth = c.get("auth");
  const ideaId = c.req.param("ideaId");
  let body: PostGenerateIn;
  try {
    body = PostGenerateInSchema.parse(await c.req.json().catch(() => ({})));
  } catch (err) {
    return c.json({ error: "invalid_body", detail: err instanceof Error ? err.message : String(err) }, 400);
  }
  const sql = noelleDb();

  const rows = await sql<Array<{ org_id: string }>>`
    select org_id from noelle.post_ideas where id = ${ideaId} limit 1
  `;
  const idea = rows[0];
  if (!idea) return c.json({ error: "not_found" }, 404);
  if (!(await isOrgMember(auth.userId, idea.org_id))) {
    return c.json({ error: "not_org_member" }, 403);
  }

  const admitted = await requestContentPostGeneration(sql, { orgId: idea.org_id, ideaId }, {
    platforms: body.platforms ?? null, guidance: body.guidance,
  });
  return c.json({ idea_id: ideaId, status: admitted.idea.status }, 200);
});

// POST /api/posts/:ideaId/polish — operator asks the agent to sharpen ONE idea's
// hook/thesis IN PLACE. Enqueue a mode='polish' ideation_requests row (resolving
// the owning instance from the idea); the Lima ideation worker refines it. Async,
// like /ideate + /generate — the response is just "queued".
posts.post("/api/posts/:ideaId/polish", async (c) => {
  const auth = c.get("auth");
  const ideaId = c.req.param("ideaId");
  const sql = noelleDb();
  const rows = await sql<Array<{ org_id: string }>>`
    select org_id from noelle.post_ideas where id = ${ideaId} limit 1
  `;
  const idea = rows[0];
  if (!idea) return c.json({ error: "not_found" }, 404);
  if (!(await isOrgMember(auth.userId, idea.org_id))) {
    return c.json({ error: "not_org_member" }, 403);
  }
  await requestContentPostPolish(sql, { orgId: idea.org_id, ideaId });
  return c.json({ idea_id: ideaId, queued: true }, 200);
});

// POST /api/posts/:id/mark-ready — operator approves a generated post draft.
// An edited body (operator's inline change) lands in final_body.
posts.post("/api/posts/:id/mark-ready", async (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");
  let body: PostMarkReadyIn;
  try {
    body = PostMarkReadyInSchema.parse(await c.req.json().catch(() => ({})));
  } catch (err) {
    return c.json({ error: "invalid_body", detail: err instanceof Error ? err.message : String(err) }, 400);
  }

  const sql = noelleDb();
  const rows = await sql<Array<{ org_id: string }>>`
    select org_id from noelle.post_drafts where id = ${id} limit 1
  `;
  const row = rows[0];
  if (!row) return c.json({ error: "not_found" }, 404);
  if (!(await isOrgMember(auth.userId, row.org_id))) {
    return c.json({ error: "not_org_member" }, 403);
  }

  const edit = await markContentPostReady(sql, { orgId: row.org_id, draftId: id }, body.editedBody);
  await recordContentEdit(sql, edit);
  return c.json({ id, status: "ready" }, 200);
});

// POST /api/posts/:id/mark-posted — explicitly acknowledge manual publication.
// Archives the draft (status='published') so it leaves the
// active board. An optional posted URL is stored. Idempotent.
posts.post("/api/posts/:id/mark-posted", async (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");
  let body: PostMarkPostedIn;
  try {
    body = PostMarkPostedInSchema.parse(await c.req.json().catch(() => ({})));
  } catch (err) {
    return c.json({ error: "invalid_body", detail: err instanceof Error ? err.message : String(err) }, 400);
  }

  const sql = noelleDb();
  const rows = await sql<Array<{ org_id: string }>>`
    select org_id from noelle.post_drafts where id = ${id} limit 1
  `;
  const row = rows[0];
  if (!row) return c.json({ error: "not_found" }, 404);
  if (!(await isOrgMember(auth.userId, row.org_id))) {
    return c.json({ error: "not_org_member" }, 403);
  }

  await markContentPostPosted(sql, { orgId: row.org_id, draftId: id }, body.postedUrl);
  return c.json({ id, status: "published" }, 200);
});

// POST /api/posts/:draftId/patch — operator edits one platform variant's rich
// column fields inline (hook / cta / notes / category / stage / body / postedUrl).
// Only provided fields are written under the shared publication locks.
posts.post("/api/posts/:draftId/patch", async (c) => {
  const auth = c.get("auth"), draftId = c.req.param("draftId");
  let patch: PostPatchIn;
  try { patch = PostPatchInSchema.parse(await c.req.json().catch(() => ({}))); }
  catch (err) { return c.json({ error: "invalid_body", detail: err instanceof Error ? err.message : String(err) }, 400); }
  const sql = noelleDb();
  const [row] = await sql<{ org_id: string }[]>`select org_id from noelle.post_drafts where id=${draftId} limit 1`;
  if (!row) return c.json({ error: "not_found" }, 404);
  if (!(await isOrgMember(auth.userId,row.org_id))) return c.json({ error: "not_org_member" }, 403);
  const result = await patchContentPostDraft(sql, { orgId: row.org_id, draftId }, patch);
  await recordContentEdit(sql, result.edit);
  return c.json({ id: draftId, status: result.status, stage: result.stage }, 200);
});

// POST /api/posts/:ideaId/schedule — set (or clear) the day an idea sits on in
// the weekly calendar. Powers drag-onto-a-day + the date picker in the Overview.
posts.post("/api/posts/:ideaId/schedule", async (c) => {
  const auth = c.get("auth");
  const ideaId = c.req.param("ideaId");
  let body: PostScheduleIn;
  try {
    body = PostScheduleInSchema.parse(await c.req.json().catch(() => ({})));
  } catch (err) {
    return c.json({ error: "invalid_body", detail: err instanceof Error ? err.message : String(err) }, 400);
  }

  const sql = noelleDb();
  const rows = await sql<Array<{ org_id: string }>>`
    select org_id from noelle.post_ideas where id = ${ideaId} limit 1
  `;
  const row = rows[0];
  if (!row) return c.json({ error: "not_found" }, 404);
  if (!(await isOrgMember(auth.userId, row.org_id))) {
    return c.json({ error: "not_org_member" }, 403);
  }

  await scheduleContentPostIdea(sql, { orgId: row.org_id, ideaId }, body.day);
  return c.json({ id: ideaId, suggested_day: body.day }, 200);
});

// POST /api/posts/:ideaId/chat — operator guidance for a post. We persist the
// turn (drafter_notes scope='post'), optionally pin it as a standing rule, and
// re-queue the idea so the post-drafter regenerates the post WITH the new
// guidance (it re-gathers chat + standing notes). The new draft supersedes the
// old one on the Drafts board. Async by design — the vault + models live on the
// worker box, not here.
posts.post("/api/posts/:ideaId/chat", async (c) => {
  const auth = c.get("auth");
  const ideaId = c.req.param("ideaId");
  let body: PostChatIn;
  try {
    body = PostChatInSchema.parse(await c.req.json().catch(() => ({})));
  } catch (err) {
    return c.json({ error: "invalid_body", detail: err instanceof Error ? err.message : String(err) }, 400);
  }

  const sql = noelleDb();
  const rows = await sql<Array<{ org_id: string }>>`
    select org_id from noelle.post_ideas where id = ${ideaId} limit 1
  `;
  const idea = rows[0];
  if (!idea) return c.json({ error: "not_found" }, 404);
  if (!(await isOrgMember(auth.userId, idea.org_id))) {
    return c.json({ error: "not_org_member" }, 403);
  }

  await requestContentPostGeneration(sql, { orgId: idea.org_id, ideaId }, {
    guidance: body.message, pin: body.pin,
    afterQueue: async (tx, current) => {
      const directiveName = extractStyleDirective(body.message);
      if (!directiveName) return;
      const sources = await tx<Array<{ handle: string; display_name: string | null }>>`
        select handle,display_name from noelle.account_feeder_sources
        where agent_instance_id=${current.agent_instance_id} and platform='linkedin'
      `;
      const handle = resolveStyleSourceHandle(directiveName,
        sources.map(source => ({ handle: source.handle, displayName: source.display_name })));
      if (!handle) return;
      await tx`update noelle.agent_instances set account_feeder_config=coalesce(account_feeder_config,'{}'::jsonb)
        || jsonb_build_object('pinnedStyleHandle',${handle}::text),updated_at=now()
        where id=${current.agent_instance_id} and org_id=${current.org_id}`;
      const label = sources.find(source => source.handle === handle)?.display_name || handle;
      await tx`insert into noelle.drafter_notes(org_id,agent_instance_id,scope,lane,idea_id,role,body,pinned)
        values (${current.org_id},${current.agent_instance_id},'post','posts',${current.id},'agent',
          ${`Styling with ${label}'s posts from now on — grounding drafts in their actual writing. Change or clear this with the Style picker.`},false)`;
    },
  });
  return c.json({ idea_id: ideaId, queued: true, pinned: body.pin }, 200);
});

// POST /api/posts/notes/:noteId/pin — pin (or unpin) an existing chat turn as a
// standing rule. Pinning copies it to a scope='standing' row.
posts.post("/api/posts/notes/:noteId/pin", async (c) => {
  const auth = c.get("auth");
  const noteId = c.req.param("noteId");
  let body: PostPinNoteIn;
  try {
    body = PostPinNoteInSchema.parse(await c.req.json().catch(() => ({})));
  } catch (err) {
    return c.json({ error: "invalid_body", detail: err instanceof Error ? err.message : String(err) }, 400);
  }

  const sql = noelleDb();
  const rows = await sql<
    Array<{ org_id: string; agent_instance_id: string; lane: string; body: string }>
  >`
    select org_id, agent_instance_id, lane, body from noelle.drafter_notes where id = ${noteId} limit 1
  `;
  const note = rows[0];
  if (!note) return c.json({ error: "not_found" }, 404);
  if (!(await isOrgMember(auth.userId, note.org_id))) {
    return c.json({ error: "not_org_member" }, 403);
  }

  if (body.pinned) {
