"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { OrgMembershipError, computeNextRunAt } from "@noelle/runtime";
import { DiscoveryConfigSchema, RunScheduleSchema, resolveLaneConfig } from "@noelle/contracts";
import { sql } from "@/lib/db";
import { getCurrentUser, getOrgBySlug } from "@/lib/queries";

// The pipeline controls drive both intern roles: Vega (x_intern) and Lyra
// (linkedin_intern). Both share the same agent_instances columns (status,
// *_enabled, goal_target/goal_started_at, pipeline_started_at), so every action
// below operates on either role. The role filter (alongside the org_id match,
// which is the IDOR guard) keeps the writes scoped to a real intern instance —
// it never touches a coordinator (CEO/CMO) row.
const INTERN_ROLES = ["x_intern", "linkedin_intern", "reddit_intern", "video_intern"] as const;

// The agent detail page is reachable by BOTH the agent slug (/agents/vega) and
// the UUID; Next caches those as separate router entries. Revalidating a
// concrete /agents/<uuid> path leaves the slug page the user is actually
// viewing stale — the write lands in the DB but the UI only catches up on a
// hard reload (the "buttons do nothing / must reload" report). Revalidate the
// route PATTERN with type "page" so every cached variant (slug + UUID), the
// active page included, refreshes.
const AGENT_PAGE_ROUTE = "/app/[orgSlug]/agents/[instanceId]";

const Input = z.object({
  orgSlug: z.string().min(1),
  instanceId: z.string().uuid(),
  nextStatus: z.enum(["active", "paused"]),
});

export async function toggleAgentStatus(
  input: z.infer<typeof Input>,
): Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }> {
  const parsed = Input.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { code: "bad_input", message: parsed.error.message } };
  }
  const { orgSlug, instanceId, nextStatus } = parsed.data;

  const user = await getCurrentUser();
  if (!user) return { ok: false, error: { code: "unauthenticated", message: "Sign in first." } };

  let org;
  try {
    org = await getOrgBySlug(orgSlug);
  } catch (err) {
    if (err instanceof OrgMembershipError)
      return { ok: false, error: { code: "forbidden", message: "Not a member of this org." } };
    throw err;
  }
  if (!org) return { ok: false, error: { code: "not_found", message: "Org not found." } };

  const rows = await sql<{ id: string }[]>`
    update noelle.agent_instances
    set status = ${nextStatus}, updated_at = now()
    where id = ${instanceId}
      and org_id = ${org.id}
      and role in ${sql(INTERN_ROLES)}
      and status in ('active', 'paused')
    returning id
  `;
  if (rows.length === 0) {
    return { ok: false, error: { code: "not_found", message: "Agent instance not found." } };
  }

  revalidatePath(AGENT_PAGE_ROUTE, "page");
  revalidatePath(`/app/${orgSlug}/org-chart`);
  return { ok: true };
}

const WorkerInput = z.object({
  orgSlug: z.string().min(1),
  instanceId: z.string().uuid(),
  worker: z.enum(["discovery", "classifier", "drafter", "send", "profiler", "watchlist", "dm_autodraft"]),
  enabled: z.boolean(),
});

// enum → column name. Keyed by the validated worker so the identifier passed to
// sql() is never user-controlled. `dm_autodraft` is not a pipeline worker — it's
// the drafter's auto-DM sub-behavior (0036) — but it rides the same toggle path.
const WORKER_COLUMN = {
  discovery: "discovery_enabled",
  classifier: "classifier_enabled",
  drafter: "drafter_enabled",
  send: "send_enabled",
  profiler: "profiler_enabled",
  watchlist: "watchlist_enabled",
  dm_autodraft: "dm_autodraft_enabled",
} as const;

/**
 * Toggle a single X-intern worker on/off for an instance (0019/0024). The four
 * pipeline workers are independent of the master Start/Pause (`status`): a
 * paused instance runs none of them; an active instance runs each per its flag.
 * The profiler (0024) is decoupled from pause entirely — it runs for active and
 * paused instances and obeys only profiler_enabled. Org-scoped, same as
 * toggleAgentStatus.
 */
export async function setWorkerEnabled(
  input: z.infer<typeof WorkerInput>,
): Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }> {
  const parsed = WorkerInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { code: "bad_input", message: parsed.error.message } };
  }
  const { orgSlug, instanceId, worker, enabled } = parsed.data;

  const user = await getCurrentUser();
  if (!user) return { ok: false, error: { code: "unauthenticated", message: "Sign in first." } };

  let org;
  try {
    org = await getOrgBySlug(orgSlug);
  } catch (err) {
    if (err instanceof OrgMembershipError)
      return { ok: false, error: { code: "forbidden", message: "Not a member of this org." } };
    throw err;
  }
  if (!org) return { ok: false, error: { code: "not_found", message: "Org not found." } };

  const column = WORKER_COLUMN[worker];
  const rows = await sql<{ id: string }[]>`
    update noelle.agent_instances
    set ${sql(column)} = ${enabled}, updated_at = now()
    where id = ${instanceId}
      and org_id = ${org.id}
      and role in ${sql(INTERN_ROLES)}
    returning id
  `;
  if (rows.length === 0) {
    return { ok: false, error: { code: "not_found", message: "Agent instance not found." } };
  }

  revalidatePath(AGENT_PAGE_ROUTE, "page");
  return { ok: true };
}

const ReplySendInput = z.object({
  orgSlug: z.string().min(1),
  instanceId: z.string().uuid(),
  enabled: z.boolean(),
});

/**
 * Toggle the master "reply sending" switch (0081) for an intern instance. OFF by
 * default: replies are drafted + queued but nothing posts until this is on. Gates
 * BOTH send paths (the X send worker and the LinkedIn actuator queue), so off is a
 * real kill switch. Org-scoped, same guard as setWorkerEnabled.
 */
export async function setReplySendEnabled(
  input: z.infer<typeof ReplySendInput>,
): Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }> {
  const parsed = ReplySendInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { code: "bad_input", message: parsed.error.message } };
  }
  const { orgSlug, instanceId, enabled } = parsed.data;

  const user = await getCurrentUser();
  if (!user) return { ok: false, error: { code: "unauthenticated", message: "Sign in first." } };

  let org;
  try {
    org = await getOrgBySlug(orgSlug);
  } catch (err) {
    if (err instanceof OrgMembershipError)
      return { ok: false, error: { code: "forbidden", message: "Not a member of this org." } };
    throw err;
  }
  if (!org) return { ok: false, error: { code: "not_found", message: "Org not found." } };

  const rows = await sql<{ id: string }[]>`
    update noelle.agent_instances
    set reply_send_enabled = ${enabled}, updated_at = now()
    where id = ${instanceId}
      and org_id = ${org.id}
      and role in ${sql(INTERN_ROLES)}
    returning id
  `;
  if (rows.length === 0) {
    return { ok: false, error: { code: "not_found", message: "Agent instance not found." } };
  }

  revalidatePath(AGENT_PAGE_ROUTE, "page");
  return { ok: true };
}

const ActuatorStateInput = z.object({
  orgSlug: z.string().min(1),
  instanceId: z.string().uuid(),
  desired: z.enum(["running", "stopped"]),
});

/**
 * Remote start/stop of the browser actuator (the "hands") for an intern instance
 * — the phone-facing half of the feature. Writes agent_instances.actuator_desired_state
 * (0089) and bumps actuator_command_at, which the extension long-polls
 * (GET /api/actuator/intent) and reconciles to within ~1s: 'running' resumes
