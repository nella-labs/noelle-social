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
