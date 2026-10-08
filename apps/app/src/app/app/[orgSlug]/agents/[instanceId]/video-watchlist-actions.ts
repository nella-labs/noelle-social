"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { OrgMembershipError } from "@noelle/runtime";
import {
  VideoWatchlistSourceSchema,
  VideoWatchlistNicheSchema,
  VideoFeederConfigSchema,
} from "@noelle/contracts";
import { sql } from "@/lib/db";
import { maintenanceNote } from "@/lib/agent-ui-config";
import { getAgentInstance, getCurrentUser, getOrgBySlug } from "@/lib/queries";
import { getVideoClipDetail, type VideoClipDetail } from "@/lib/video-queries";
import { planNicheLanes } from "@/lib/nova/plan-lanes";
import { suggestObjectiveFromAccount } from "@/lib/nova/suggest-objective";

const AGENT_PAGE_ROUTE = "/app/[orgSlug]/agents/[instanceId]";
const WATCHLIST_PAGE_ROUTE = "/app/[orgSlug]/agents/[instanceId]/watchlist";

/**
 * Authorize a write against a specific video-intern (Nova) instance. Membership +
 * the instance-belongs-to-org IDOR guard (getAgentInstance runs assertOrgMember)
 * + the role check (these tables are Nova's).
 */
async function authorizeVideoInstance(orgSlug: string, instanceId: string) {
  const user = await getCurrentUser();
  if (!user) return { kind: "unauthenticated" as const };
  try {
    const org = await getOrgBySlug(orgSlug);
    if (!org) return { kind: "not_found" as const };
    const instance = await getAgentInstance(instanceId);
    if (!instance || instance.org_id !== org.id) return { kind: "not_found" as const };
    if (instance.role !== "video_intern") return { kind: "not_found" as const };
    return { kind: "ok" as const, org };
  } catch (err) {
    if (err instanceof OrgMembershipError) return { kind: "forbidden" as const };
    throw err;
  }
}

function revalidate() {
  revalidatePath(AGENT_PAGE_ROUTE, "page");
  revalidatePath(WATCHLIST_PAGE_ROUTE, "page");
}

const PlatformInput = z.enum(["instagram", "tiktok"]).default("instagram");
const AddSourceInput = z.object({
  orgSlug: z.string().min(1),
  instanceId: z.string().uuid(),
  handle: z.string().min(1).max(200),
  platform: PlatformInput,
  note: z.string().trim().max(240).optional(),
});
const AddNicheInput = z.object({
  orgSlug: z.string().min(1),
  instanceId: z.string().uuid(),
  query: z.string().min(1).max(200),
  platform: PlatformInput,
  note: z.string().trim().max(240).optional(),
});
const RowInput = z.object({
  orgSlug: z.string().min(1),
  instanceId: z.string().uuid(),
  rowId: z.string().uuid(),
});
const ToggleInput = RowInput.extend({ enabled: z.boolean() });
const RunInput = z.object({ orgSlug: z.string().min(1), instanceId: z.string().uuid() });

export async function addVideoSource(input: z.infer<typeof AddSourceInput>) {
  const parsed = AddSourceInput.parse(input);
  const auth = await authorizeVideoInstance(parsed.orgSlug, parsed.instanceId);
  if (auth.kind !== "ok") return { ok: false as const, error: auth.kind };
  // Normalise via the contract (trims + lowercases the handle for a stable key).
  const v = VideoWatchlistSourceSchema.safeParse({
    handle: parsed.handle,
    platform: parsed.platform,
    ...(parsed.note ? { note: parsed.note } : {}),
  });
  if (!v.success) return { ok: false as const, error: "invalid" as const };
  const { handle, platform, note } = v.data;
  await sql`
    insert into noelle.video_watchlist_sources
      (org_id, agent_instance_id, platform, handle, note, enabled)
    values (${auth.org.id}, ${parsed.instanceId}, ${platform}, ${handle}, ${note ?? null}, true)
    on conflict (agent_instance_id, platform, handle)
      do update set note = excluded.note, enabled = true
  `;
  revalidate();
  return { ok: true as const };
}

export async function removeVideoSource(input: z.infer<typeof RowInput>) {
  const parsed = RowInput.parse(input);
  const auth = await authorizeVideoInstance(parsed.orgSlug, parsed.instanceId);
  if (auth.kind !== "ok") return { ok: false as const, error: auth.kind };
  await sql`
    delete from noelle.video_watchlist_sources
    where id = ${parsed.rowId} and org_id = ${auth.org.id} and agent_instance_id = ${parsed.instanceId}
  `;
  revalidate();
  return { ok: true as const };
}

export async function toggleVideoSource(input: z.infer<typeof ToggleInput>) {
  const parsed = ToggleInput.parse(input);
  const auth = await authorizeVideoInstance(parsed.orgSlug, parsed.instanceId);
  if (auth.kind !== "ok") return { ok: false as const, error: auth.kind };
  await sql`
    update noelle.video_watchlist_sources set enabled = ${parsed.enabled}
    where id = ${parsed.rowId} and org_id = ${auth.org.id} and agent_instance_id = ${parsed.instanceId}
  `;
  revalidate();
  return { ok: true as const };
}

export async function addVideoNiche(input: z.infer<typeof AddNicheInput>) {
  const parsed = AddNicheInput.parse(input);
  const auth = await authorizeVideoInstance(parsed.orgSlug, parsed.instanceId);
  if (auth.kind !== "ok") return { ok: false as const, error: auth.kind };
  const v = VideoWatchlistNicheSchema.safeParse({
    query: parsed.query,
    platform: parsed.platform,
    ...(parsed.note ? { note: parsed.note } : {}),
  });
  if (!v.success) return { ok: false as const, error: "invalid" as const };
  const { query, platform, note } = v.data;
  await sql`
    insert into noelle.video_watchlist_niches
      (org_id, agent_instance_id, platform, query, note, enabled)
    values (${auth.org.id}, ${parsed.instanceId}, ${platform}, ${query}, ${note ?? null}, true)
    on conflict (agent_instance_id, platform, query)
      do update set note = excluded.note, enabled = true
  `;
  revalidate();
  return { ok: true as const };
}

export async function removeVideoNiche(input: z.infer<typeof RowInput>) {
  const parsed = RowInput.parse(input);
  const auth = await authorizeVideoInstance(parsed.orgSlug, parsed.instanceId);
  if (auth.kind !== "ok") return { ok: false as const, error: auth.kind };
  await sql`
    delete from noelle.video_watchlist_niches
    where id = ${parsed.rowId} and org_id = ${auth.org.id} and agent_instance_id = ${parsed.instanceId}
  `;
  revalidate();
  return { ok: true as const };
}

const PlanLanesInput = z.object({
  orgSlug: z.string().min(1),
  instanceId: z.string().uuid(),
  platform: PlatformInput,
});

/**
 * Objective → niche lanes (the Lyra/Vega move). Reads Nova's objective, asks the
 * planner to expand it into hashtag/keyword discovery lanes that don't duplicate
 * the operator's existing ones, and inserts them (SUPPLEMENTS manual lanes, never
 * replaces). Returns the lanes added so the UI can confirm. Surfaces a typed
 * error when the objective is empty or the planner came back dry.
 */
export async function planVideoNicheLanes(input: z.infer<typeof PlanLanesInput>) {
  const parsed = PlanLanesInput.parse(input);
  const auth = await authorizeVideoInstance(parsed.orgSlug, parsed.instanceId);
  if (auth.kind !== "ok") return { ok: false as const, error: auth.kind };

  const [inst] = await sql<{ objective: string | null }[]>`
    select objective from noelle.agent_instances
    where id = ${parsed.instanceId} and org_id = ${auth.org.id} and role = 'video_intern'
    limit 1
  `;
  const objective = inst?.objective?.trim() ?? "";
  if (!objective) return { ok: false as const, error: "no_objective" as const };

  const existingRows = await sql<{ query: string }[]>`
    select query from noelle.video_watchlist_niches
    where agent_instance_id = ${parsed.instanceId} and org_id = ${auth.org.id} and platform = ${parsed.platform}
  `;
  const existing = existingRows.map((r) => r.query);

  const planned = await planNicheLanes(objective, parsed.platform, existing);
  if (planned.length === 0) return { ok: false as const, error: "empty" as const };

  const added: string[] = [];
  for (const query of planned) {
    const v = VideoWatchlistNicheSchema.safeParse({ query, platform: parsed.platform });
    if (!v.success) continue;
    await sql`
      insert into noelle.video_watchlist_niches
        (org_id, agent_instance_id, platform, query, enabled)
      values (${auth.org.id}, ${parsed.instanceId}, ${v.data.platform}, ${v.data.query}, true)
      on conflict (agent_instance_id, platform, query) do nothing
    `;
    added.push(v.data.query);
  }
  revalidate();
  return { ok: true as const, added };
}

/**
 * Propose an objective for Nova from the operator's OWN account — their
 * distilled account Brand Guide + recent post captions. Read-only: returns the
 * suggested text for the operator to review/edit/save (does NOT persist). Used by
 * the "Suggest from my account" affordance next to the objective editor.
 */
export async function suggestVideoObjective(input: { orgSlug: string; instanceId: string }) {
  const auth = await authorizeVideoInstance(input.orgSlug, input.instanceId);
  if (auth.kind !== "ok") return { ok: false as const, error: auth.kind };

  const [profileRow] = await sql<{ profile: unknown }[]>`
    select profile from noelle.video_ultra_profiles
    where agent_instance_id = ${input.instanceId} and org_id = ${auth.org.id} and scope = 'account'
    order by refreshed_at desc nulls last limit 1`;
  const captionRows = await sql<{ caption: string }[]>`
    select caption from noelle.video_clips
    where agent_instance_id = ${input.instanceId} and org_id = ${auth.org.id} and source_kind = 'account'
      and caption <> ''
    order by views desc limit 12`;

  const accountProfile = profileRow?.profile ? JSON.stringify(profileRow.profile).slice(0, 1500) : null;
  const captions = captionRows.map((r) => r.caption);
  if (!accountProfile && captions.length === 0) {
    return { ok: false as const, error: "no_account_data" as const };
  }

  const objective = await suggestObjectiveFromAccount({ accountProfile, captions });
  if (!objective) return { ok: false as const, error: "empty" as const };
  return { ok: true as const, objective };
}

/**
 * Attribute a published own-account post (clip) to the Nova draft it came from
 * (or clear it). One post ↔ one draft: linking moves the pointer off any other
 * draft that claimed this clip. Powers the analytics page's "which drafts I used".
 */
export async function linkVideoDraftToClip(input: {
  orgSlug: string;
  instanceId: string;
  clipId: string;
  draftId: string | null;
}) {
  const auth = await authorizeVideoInstance(input.orgSlug, input.instanceId);
  if (auth.kind !== "ok") return { ok: false as const, error: auth.kind };

  // Clear any existing draft → this clip link first (keeps it 1:1).
  await sql`
    update noelle.video_drafts set published_clip_id = null, updated_at = now()
    where agent_instance_id = ${input.instanceId} and org_id = ${auth.org.id}
      and published_clip_id = ${input.clipId}`;

  if (input.draftId) {
    await sql`
      update noelle.video_drafts set published_clip_id = ${input.clipId}, updated_at = now()
      where id = ${input.draftId} and agent_instance_id = ${input.instanceId} and org_id = ${auth.org.id}`;
  }
  revalidatePath("/app/[orgSlug]/agents/[instanceId]/analytics", "page");
  return { ok: true as const };
}

// The tailored-harvest knobs the operator sets: how many videos per creator and
// which ones (top-N by views/engagement, audience-relative outperformers, niche
// recency), plus the analysis/grounding tiers. Raw object re-validated by the
// canonical VideoFeederConfigSchema (.strict) — the exact shape Scout parses out
// of agent_instances.video_feeder_config.
const SaveFeederConfigInput = z.object({
  orgSlug: z.string().min(1),
  instanceId: z.string().uuid(),
  config: z.record(z.string(), z.unknown()),
});

export async function saveVideoFeederConfig(input: z.infer<typeof SaveFeederConfigInput>) {
  const parsed = SaveFeederConfigInput.parse(input);
  const auth = await authorizeVideoInstance(parsed.orgSlug, parsed.instanceId);
  if (auth.kind !== "ok") return { ok: false as const, error: auth.kind };
  const cfg = VideoFeederConfigSchema.safeParse(parsed.config);
  if (!cfg.success) return { ok: false as const, error: "invalid" as const };
  await sql`
    update noelle.agent_instances
    set video_feeder_config = ${sql.json(cfg.data as never)}, updated_at = now()
    where id = ${parsed.instanceId} and org_id = ${auth.org.id} and role = 'video_intern'
  `;
  revalidate();
  return { ok: true as const };
}

const ClipDetailInput = z.object({
  orgSlug: z.string().min(1),
  instanceId: z.string().uuid(),
  clipId: z.string().uuid(),
});

/**
 * Read one clip + its teardown for the Discover detail popup. Lazy-loaded on
 * modal open so the grid payload stays light. Read-only; authorized like every
 * Nova path (membership + IDOR + role).
 */
export async function loadVideoClipDetail(
  input: z.infer<typeof ClipDetailInput>,
): Promise<{ ok: true; clip: VideoClipDetail } | { ok: false; error: string }> {
  const parsed = ClipDetailInput.parse(input);
  const auth = await authorizeVideoInstance(parsed.orgSlug, parsed.instanceId);
  if (auth.kind !== "ok") return { ok: false as const, error: auth.kind };
  const clip = await getVideoClipDetail(parsed.instanceId, parsed.clipId);
  if (!clip) return { ok: false as const, error: "not_found" };
  return { ok: true as const, clip };
}

/** Flip the harvest run flag — the Scout worker picks it up + clears it. */
export async function requestVideoHarvest(input: z.infer<typeof RunInput>) {
  const parsed = RunInput.parse(input);
  const auth = await authorizeVideoInstance(parsed.orgSlug, parsed.instanceId);
  if (auth.kind !== "ok") return { ok: false as const, error: { code: auth.kind, message: auth.kind } };
  // Nova is parked (maintenance mode) — refuse to queue a harvest even if a
  // stale client submits the form. See MAINTENANCE_NOTE_BY_ROLE.
  const parked = maintenanceNote("video_intern");
  if (parked) return { ok: false as const, error: { code: "maintenance", message: parked } };
  const rows = await sql<{ id: string }[]>`
    update noelle.agent_instances
    set video_feeder_run_requested_at = now(), updated_at = now()
    where id = ${parsed.instanceId} and org_id = ${auth.org.id} and role = 'video_intern'
    returning id
  `;
  if (rows.length === 0) return { ok: false as const, error: { code: "not_found", message: "Agent instance not found." } };
  revalidate();
  return { ok: true as const };
}

/**
 * Stop the in-flight harvest. Flags cancel_requested on this instance's latest
 * unfinished harvester run; the worker polls it between pulls and bails cleanly.
 * No-op (still ok) if nothing is running.
 */
export async function cancelVideoHarvest(input: z.infer<typeof RunInput>) {
  const parsed = RunInput.parse(input);
  const auth = await authorizeVideoInstance(parsed.orgSlug, parsed.instanceId);
  if (auth.kind !== "ok") return { ok: false as const, error: { code: auth.kind, message: auth.kind } };
  await sql`
    update noelle.worker_runs
    set cancel_requested = true
    where worker = 'harvester' and instance_id = ${parsed.instanceId} and finished_at is null
  `;
  revalidate();
  return { ok: true as const };
}
