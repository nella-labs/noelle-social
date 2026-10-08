"use server";

import { revalidatePath } from "next/cache";
import { OrgMembershipError, generateImageGemini } from "@noelle/runtime";
import { ManualVideoIdeaInSchema, VideoIdeationRequestSchema } from "@noelle/contracts";
import { sql } from "@/lib/db";
import { getCurrentUser, getOrgBySlug } from "@/lib/queries";

// The video studio renders inside the Content workspace (?platform=video), so
// mutations revalidate the content route.
const STUDIO_ROUTE = "/app/[orgSlug]/content";

/** Membership-gated resolve of the org's Nova (video_intern) instance. */
async function authorizeNova(orgSlug: string) {
  const user = await getCurrentUser();
  if (!user) return { kind: "unauthenticated" as const };
  try {
    const org = await getOrgBySlug(orgSlug);
    if (!org) return { kind: "not_found" as const };
    const rows = await sql<{ id: string }[]>`
      select id from noelle.agent_instances
      where org_id = ${org.id} and role = 'video_intern' limit 1`;
    const instanceId = rows[0]?.id;
    if (!instanceId) return { kind: "not_found" as const };
    return { kind: "ok" as const, orgId: org.id, instanceId };
  } catch (err) {
    if (err instanceof OrgMembershipError) return { kind: "forbidden" as const };
    throw err;
  }
}

function revalidate() {
  revalidatePath(STUDIO_ROUTE, "page");
}

function confirmUpdate(rows: { id: string }[]) {
  if (!rows.length) return { ok: false as const, error: "not_found" as const };
  revalidate();
  return { ok: true as const };
}

/** Flip the ideation request flag → the ideator worker generates idea cards. */
export async function generateVideoIdeas(input: {
  orgSlug: string;
  mode: "single" | "batch";
  count?: number;
  weekStart?: string;
}) {
  const auth = await authorizeNova(input.orgSlug);
  if (auth.kind !== "ok") return { ok: false as const, error: auth.kind };
  const req = VideoIdeationRequestSchema.parse({
    mode: input.mode,
    count: input.count ?? 5,
    ...(input.weekStart ? { weekStart: input.weekStart } : {}),
    requestedAt: new Date().toISOString(),
  });
  const rows = await sql<{ id: string }[]>`
    update noelle.agent_instances
    set video_ideation_request = ${sql.json(req as never)}, updated_at = now()
    where id = ${auth.instanceId} and org_id = ${auth.orgId} and role = 'video_intern' returning id`;
  return confirmUpdate(rows);
}

/**
 * Poll target for the Ideas UI: is an ideation run still pending, and how many
 * proposed ideas exist right now. The panel calls this after Generate to clear
 * its "Generating…" banner the moment the worker finishes (flag cleared) and to
 * detect whether new ideas landed — instead of stranding a static banner that
 * only a manual refresh resolved.
 */
export async function getIdeationStatus(input: { orgSlug: string }) {
  const auth = await authorizeNova(input.orgSlug);
  if (auth.kind !== "ok") return { ok: false as const, error: auth.kind };
  const rows = await sql<{ pending: boolean; proposed: string }[]>`
    select
      (ai.video_ideation_request is not null) as pending,
      (select count(*) from noelle.video_ideas vi
        where vi.agent_instance_id = ai.id and vi.org_id = ai.org_id
          and vi.status = 'proposed') as proposed
    from noelle.agent_instances ai
    where ai.id = ${auth.instanceId} and ai.org_id = ${auth.orgId} and ai.role = 'video_intern'
    limit 1`;
  const row = rows[0];
  return {
    ok: true as const,
    pending: row?.pending ?? false,
    proposed: Number(row?.proposed ?? 0),
  };
}

/** Approve a proposed idea → the scripter claims it and writes a draft. */
export async function approveVideoIdea(input: { orgSlug: string; ideaId: string }) {
  const auth = await authorizeNova(input.orgSlug);
  if (auth.kind !== "ok") return { ok: false as const, error: auth.kind };
  const rows = await sql<{ id: string }[]>`
    update noelle.video_ideas set status = 'approved', updated_at = now()
    where id = ${input.ideaId} and agent_instance_id = ${auth.instanceId}
      and org_id = ${auth.orgId} and status in ('proposed', 'approved') returning id`;
  return confirmUpdate(rows);
}

export async function scheduleVideoIdea(input: { orgSlug: string; ideaId: string; day: string | null }) {
  const auth = await authorizeNova(input.orgSlug);
  if (auth.kind !== "ok") return { ok: false as const, error: auth.kind };
  const rows = await sql<{ id: string }[]>`
    update noelle.video_ideas set suggested_day = ${input.day}, updated_at = now()
    where id = ${input.ideaId} and agent_instance_id = ${auth.instanceId} and org_id = ${auth.orgId} returning id`;
  return confirmUpdate(rows);
}

export async function manualVideoIdea(input: {
  orgSlug: string;
  hook: string;
  concept?: string;
  suggestedDay?: string;
}) {
  const auth = await authorizeNova(input.orgSlug);
  if (auth.kind !== "ok") return { ok: false as const, error: auth.kind };
  const parsed = ManualVideoIdeaInSchema.parse({
    hook: input.hook,
    concept: input.concept ?? null,
    suggestedDay: input.suggestedDay ?? null,
  });
  await sql`
    insert into noelle.video_ideas
      (org_id, agent_instance_id, platform, hook, concept, suggested_day, status, source_engine)
    values (${auth.orgId}, ${auth.instanceId}, 'instagram', ${parsed.hook},
      ${parsed.concept ?? null}, ${parsed.suggestedDay ?? null}, 'proposed', 'manual')`;
  revalidate();
  return { ok: true as const };
}

export async function markVideoDraftReady(input: { orgSlug: string; draftId: string; editedScript?: string }) {
  const auth = await authorizeNova(input.orgSlug);
  if (auth.kind !== "ok") return { ok: false as const, error: auth.kind };
  const rows = await sql<{ id: string }[]>`
    update noelle.video_drafts
    set status = 'ready', final_script = coalesce(${input.editedScript ?? null}, final_script),
        marked_ready_at = now(), updated_at = now()
    where id = ${input.draftId} and agent_instance_id = ${auth.instanceId} and org_id = ${auth.orgId} returning id`;
  return confirmUpdate(rows);
}

/**
 * Generate ONE still / thumbnail / graphic background for a video via Imagen 4
 * (the API-key path that works on the Lima box — Vertex ADC dies there). Returns
 * the image inline as a data: URL; the operator saves it by hand and drops it
 * into their edit (assist-only, like the rest of Nova). Fail-open: returns an
 * error code the UI surfaces rather than throwing.
 */
export async function generateVideoStill(input: { orgSlug: string; prompt: string }) {
  const auth = await authorizeNova(input.orgSlug);
  if (auth.kind !== "ok") return { ok: false as const, error: auth.kind };
  const prompt = input.prompt.trim().slice(0, 1000);
  if (!prompt) return { ok: false as const, error: "empty" as const };
  const apiKey = process.env.NOELLE_GEMINI_API_KEY;
  if (!apiKey) return { ok: false as const, error: "no_key" as const };
  const dataUrl = await generateImageGemini({ apiKey, aspectRatio: "9:16" }, prompt);
  if (!dataUrl) return { ok: false as const, error: "generation_failed" as const };
  return { ok: true as const, dataUrl };
}

/** Persist an edited script (final_script) without changing the draft's status. */
export async function saveVideoDraftScript(input: { orgSlug: string; draftId: string; script: string }) {
  const auth = await authorizeNova(input.orgSlug);
  if (auth.kind !== "ok") return { ok: false as const, error: auth.kind };
  const rows = await sql<{ id: string }[]>`update noelle.video_drafts set final_script = ${input.script.slice(0, 20000)}, updated_at = now()
    where id = ${input.draftId} and agent_instance_id = ${auth.instanceId} and org_id = ${auth.orgId} returning id`;
  return confirmUpdate(rows);
}

/** Persist edited storyboard beats (the per-beat script lines) for a draft. */
export async function saveVideoDraftStructure(input: {
  orgSlug: string;
  draftId: string;
  structure: Array<{ tStart: number; tEnd: number; purpose: string; line: string }>;
}) {
  const auth = await authorizeNova(input.orgSlug);
  if (auth.kind !== "ok") return { ok: false as const, error: auth.kind };
  const rows = await sql<{ id: string }[]>`update noelle.video_drafts set structure = ${sql.json(input.structure as never)}, updated_at = now()
    where id = ${input.draftId} and agent_instance_id = ${auth.instanceId} and org_id = ${auth.orgId} returning id`;
  return confirmUpdate(rows);
}

/** Read a draft's loose graph_specs array, org-scoped (shared by the visual actions). */
async function readDraftGraphSpecs(
  draftId: string,
  instanceId: string,
  orgId: string,
): Promise<Record<string, unknown>[]> {
  const rows = await sql<{ graph_specs: unknown }[]>`
    select graph_specs from noelle.video_drafts
    where id = ${draftId} and agent_instance_id = ${instanceId} and org_id = ${orgId} limit 1`;
  const raw = rows[0]?.graph_specs;
  return Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
}

/**
 * Drop one visual (graph_spec) from a draft by its index in the stored array.
 * Index is the ORIGINAL graph_specs position (the Build panel keys Remove on it),
 * so removable + non-renderable specs stay aligned.
 */
export async function removeDraftVisual(input: { orgSlug: string; draftId: string; index: number }) {
  const auth = await authorizeNova(input.orgSlug);
  if (auth.kind !== "ok") return { ok: false as const, error: auth.kind };
  const specs = await readDraftGraphSpecs(input.draftId, auth.instanceId, auth.orgId);
  if (input.index < 0 || input.index >= specs.length) return { ok: false as const, error: "out_of_range" as const };
  const next = specs.filter((_, i) => i !== input.index);
  const rows = await sql<{ id: string }[]>`update noelle.video_drafts set graph_specs = ${sql.json(next as never)}, updated_at = now()
    where id = ${input.draftId} and agent_instance_id = ${auth.instanceId} and org_id = ${auth.orgId} returning id`;
  return confirmUpdate(rows);
}

/**
 * Refine one visual in place — title + brand colour. Stored on the loose
 * graph_spec object (title overwrites; brandColor is an extra field the Build
 * panel reads after coercion), so no contract/migration change is needed.
 */
export async function updateDraftVisual(input: {
  orgSlug: string;
  draftId: string;
  index: number;
  title?: string;
  brandColor?: string;
}) {
  const auth = await authorizeNova(input.orgSlug);
  if (auth.kind !== "ok") return { ok: false as const, error: auth.kind };
  const specs = await readDraftGraphSpecs(input.draftId, auth.instanceId, auth.orgId);
  if (input.index < 0 || input.index >= specs.length) return { ok: false as const, error: "out_of_range" as const };
  const title = input.title?.trim().slice(0, 120);
  const brandColor = input.brandColor?.trim().slice(0, 32);
  specs[input.index] = {
    ...specs[input.index],
    ...(title !== undefined ? { title } : {}),
    ...(brandColor ? { brandColor } : {}),
  };
  const rows = await sql<{ id: string }[]>`update noelle.video_drafts set graph_specs = ${sql.json(specs as never)}, updated_at = now()
    where id = ${input.draftId} and agent_instance_id = ${auth.instanceId} and org_id = ${auth.orgId} returning id`;
  return confirmUpdate(rows);
}

export async function dismissStudioItem(input: { orgSlug: string; target: "idea" | "draft"; id: string }) {
  const auth = await authorizeNova(input.orgSlug);
  if (auth.kind !== "ok") return { ok: false as const, error: auth.kind };
  let rows: { id: string }[];
  if (input.target === "idea") {
    rows = await sql<{ id: string }[]>`update noelle.video_ideas set status = 'dismissed', updated_at = now()
      where id = ${input.id} and agent_instance_id = ${auth.instanceId} and org_id = ${auth.orgId} returning id`;
  } else {
    rows = await sql<{ id: string }[]>`update noelle.video_drafts set status = 'dismissed', updated_at = now()
      where id = ${input.id} and agent_instance_id = ${auth.instanceId} and org_id = ${auth.orgId} returning id`;
  }
  return confirmUpdate(rows);
}
