import { Hono } from "hono";
import { PostIdeasCreateSchema, type PostIdeasCreate } from "@noelle/contracts";
import { resolveActiveInstanceForPlatform } from "../lib/auth.js";
import { noelleDb } from "../lib/db.js";
import { loadEnv } from "../env.js";
import { resolveAutoCurateConfig } from "../lib/content-autocurate.js";
import { sanitizeForJsonb } from "./outbound.js";

// POST /api/post-ideas — HMAC-signed. The ideation worker pushes a batch of
// idea cards; we resolve the owning linkedin_intern instance (single per role
// in 0.0.1) and INSERT noelle.post_ideas. Idempotent on the drafter-supplied id
// (ON CONFLICT (id) DO NOTHING), exactly like /api/outbound's drafts insert.

type IdeationRequestOwner = {
  org_id: string;
  agent_instance_id: string;
  role: string;
  batch_id: string | null;
  require_review: boolean;
};

const PLATFORM_OWNER_ROLE: Record<PostIdeasCreate["platform"], string> = {
  linkedin: "linkedin_intern",
  x: "x_intern",
  reddit: "reddit_intern",
};

const postIdeas = new Hono();

postIdeas.post("/api/post-ideas", async (c) => {
  let payload: PostIdeasCreate;
  try {
    payload = sanitizeForJsonb(PostIdeasCreateSchema.parse(await c.req.json()));
  } catch (err) {
    return c.json(
      { error: "invalid_body", detail: err instanceof Error ? err.message : String(err) },
      400,
    );
  }

  const sql = noelleDb();

  let owner: { org_id: string; agent_instance_id: string; role?: string };
  let requireReview = false;

  if (payload.ideationRequestId) {
    const requests = await sql<IdeationRequestOwner[]>`
      select
        ir.org_id,
        ir.agent_instance_id,
        ai.role,
        ir.batch_id::text as batch_id,
        coalesce(ir.require_review, false) as require_review
      from noelle.ideation_requests ir
      join noelle.agent_instances ai
        on ai.id = ir.agent_instance_id
       and ai.org_id = ir.org_id
      where ir.id = ${payload.ideationRequestId}
      limit 1
    `;
    const requestOwner = requests[0];
    if (!requestOwner) {
      return c.json(
        { error: "ideation_request_not_found", detail: payload.ideationRequestId },
        404,
      );
    }

    const expectedRole = PLATFORM_OWNER_ROLE[payload.platform];
    if (requestOwner.role !== expectedRole) {
      return c.json(
        {
          error: "ideation_request_platform_mismatch",
          detail: `request role=${requestOwner.role} cannot own platform=${payload.platform}`,
        },
        400,
      );
    }

    if (
      requestOwner.batch_id &&
      payload.ideas.some((idea) => idea.batchId !== requestOwner.batch_id)
    ) {
      return c.json(
        {
          error: "ideation_request_batch_mismatch",
          detail: `request batch_id=${requestOwner.batch_id} does not match every idea batchId`,
        },
        400,
      );
    }

    owner = {
      org_id: requestOwner.org_id,
      agent_instance_id: requestOwner.agent_instance_id,
      role: requestOwner.role,
    };
    requireReview = requestOwner.require_review;
  } else {
    // Resolve the owning intern instance by platform (linkedin→Lyra, x→Vega,
    // reddit→Orion); single active instance per role in 0.0.1.
    const resolvedOwner = await resolveActiveInstanceForPlatform(payload.platform);
    if (!resolvedOwner) {
      return c.json(
        { error: "no_active_instance", detail: `no instance for platform=${payload.platform}` },
        500,
      );
    }
    owner = resolvedOwner;
  }

  // Vega auto-curate: when the master switch is ON, ordinary X (Vega) ideas skip
  // the manual idea-review step and land `approved`. Explicit MCP/operator
  // ideation requests with require_review=true keep landing `proposed` so they
  // remain in the creation hold even while recurring Vega auto-schedule is on.
  const autoCurate = resolveAutoCurateConfig(loadEnv());
  const initialStatus = requireReview
    ? "proposed"
    : autoCurate.enabled && payload.platform === "x"
      ? "approved"
      : "proposed";
  const rows = payload.ideas.map((idea) => ({
    id: idea.id,
    org_id: owner.org_id,
    agent_instance_id: owner.agent_instance_id,
    platform: idea.platform,
    // The cross-platform fan-out set. Absent ⇒ the idea's own home platform
    // (legacy single-platform behavior).
    target_platforms: idea.targetPlatforms ?? [idea.platform],
    hook: idea.hook,
    thesis: idea.thesis ?? null,
    angle: idea.angle ?? null,
    pillar: idea.pillar ?? null,
    inspiration_refs: sql.json(idea.inspirationRefs ?? []),
    suggested_day: idea.suggestedDay ?? null,
    batch_id: idea.batchId ?? null,
    status: initialStatus,
    source_engine: idea.sourceEngine ?? null,
    model: idea.model ?? null,
  }));

  try {
    await sql`
      insert into noelle.post_ideas ${sql(
        rows,
        "id",
        "org_id",
        "agent_instance_id",
        "platform",
        "target_platforms",
        "hook",
        "thesis",
        "angle",
        "pillar",
        "inspiration_refs",
        "suggested_day",
        "batch_id",
        "status",
        "source_engine",
        "model",
      )}
      on conflict (id) do nothing
    `;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[post-ideas] insert failed", msg);
    return c.json({ error: "post_ideas_insert_failed", detail: msg }, 500);
  }

  return c.json({ idea_ids: payload.ideas.map((i) => i.id) }, 200);
});

export { postIdeas };
