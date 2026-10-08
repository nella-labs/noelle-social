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
 * Full-automatic, 'stopped' ends any live run and gates autonomy off.
 *
 * IMPORTANT: 'running' means "hands ALLOWED to run", NOT send-consent. On X,
 * replies still only post when reply_send_enabled is on (that separate kill
 * switch stays authoritative) — so starting the actuator here never silently
 * begins posting. Org-scoped, same guard as setReplySendEnabled.
 */
export async function setActuatorDesiredState(
  input: z.infer<typeof ActuatorStateInput>,
): Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }> {
  const parsed = ActuatorStateInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { code: "bad_input", message: parsed.error.message } };
  }
  const { orgSlug, instanceId, desired } = parsed.data;

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
    set actuator_desired_state = ${desired}, actuator_command_at = now(), updated_at = now()
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

const LaneInput = z.object({
  orgSlug: z.string().min(1),
  instanceId: z.string().uuid(),
  lane: z.enum(["replies", "dms", "posts"]),
  enabled: z.boolean(),
  // Only meaningful for the dms lane (proactive intro DMs).
  introDmsEnabled: z.boolean().optional(),
});

const RelationshipDmsInput = z.object({
  orgSlug: z.string().min(1),
  instanceId: z.string().uuid(),
  enabled: z.boolean(),
});

const RELATIONSHIP_DM_ROLES = ["linkedin_intern", "x_intern"] as const;

/**
 * Toggle a whole LANE on/off for the multi-lane agent. Each lane maps to the
 * real gate the workers already honor, so there's ONE source of truth:
 *   - replies → drafter_enabled (the reply drafter; DMs ride it)
 *   - dms     → dm_autodraft_enabled (+ linkedin_intro_dm_enabled for intro DMs)
 *   - posts   → lane_config.posts.enabled (the only lane without a column; the
 *               ideation + post-drafter workers gate on it, 0049)
 * Org-scoped UPDATE; the org_id match is the IDOR guard.
 */
export async function setLaneEnabled(
  input: z.infer<typeof LaneInput>,
): Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }> {
  const parsed = LaneInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { code: "bad_input", message: parsed.error.message } };
  }
  const { orgSlug, instanceId, lane, enabled, introDmsEnabled } = parsed.data;

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

  let rows: { id: string }[];
  if (lane === "replies") {
    rows = await sql<{ id: string }[]>`
      update noelle.agent_instances set drafter_enabled = ${enabled}, updated_at = now()
      where id = ${instanceId} and org_id = ${org.id} and role in ${sql(INTERN_ROLES)}
      returning id
    `;
  } else if (lane === "dms") {
    if (introDmsEnabled == null) {
      rows = await sql<{ id: string }[]>`
        update noelle.agent_instances
        set dm_autodraft_enabled = ${enabled}, updated_at = now()
        where id = ${instanceId} and org_id = ${org.id} and role in ${sql(INTERN_ROLES)}
        returning id
      `;
    } else {
      rows = await sql<{ id: string }[]>`
        update noelle.agent_instances
        set dm_autodraft_enabled = ${enabled},
            linkedin_intro_dm_enabled = ${introDmsEnabled},
            updated_at = now()
        where id = ${instanceId} and org_id = ${org.id} and role in ${sql(INTERN_ROLES)}
        returning id
      `;
    }
  } else {
    // posts → read-modify-write lane_config so the other lanes' state is kept.
    const current = await sql<{ lane_config: unknown }[]>`
      select lane_config from noelle.agent_instances
      where id = ${instanceId} and org_id = ${org.id} and role in ${sql(INTERN_ROLES)}
      limit 1
    `;
    if (current.length === 0) {
      return { ok: false, error: { code: "not_found", message: "Agent instance not found." } };
    }
    const cfg = resolveLaneConfig(current[0]!.lane_config);
    cfg.posts = { enabled };
    rows = await sql<{ id: string }[]>`
      update noelle.agent_instances set lane_config = ${sql.json(cfg as never)}, updated_at = now()
      where id = ${instanceId} and org_id = ${org.id} and role in ${sql(INTERN_ROLES)}
      returning id
    `;
  }

  if (rows.length === 0) {
    return { ok: false, error: { code: "not_found", message: "Agent instance not found." } };
  }
  revalidatePath(AGENT_PAGE_ROUTE, "page");
  return { ok: true };
}

/**
 * Toggle the stored-context relationship-DM lane. It is intentionally separate
 * from reply companion DMs and Lyra intro DMs: workers should only gate this
 * lane on lane_config.dms.relationship_dms_enabled and an active-or-paused instance.
 */
export async function setRelationshipDmsEnabled(
  input: z.infer<typeof RelationshipDmsInput>,
): Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }> {
  const parsed = RelationshipDmsInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { code: "bad_input", message: parsed.error.message } };
  }
  const { orgSlug, instanceId, enabled } = parsed.data;
  const auth = await authorizeOrg(orgSlug);
  if (auth.kind !== "ok") return { ok: false, error: { code: auth.kind, message: auth.kind } };

  const current = await sql<{ lane_config: unknown }[]>`
    select lane_config from noelle.agent_instances
    where id = ${instanceId}
      and org_id = ${auth.org.id}
      and role in ${sql(RELATIONSHIP_DM_ROLES)}
    limit 1
  `;
  if (current.length === 0) {
    return { ok: false, error: { code: "not_found", message: "Agent instance not found." } };
  }

  const cfg = resolveLaneConfig(current[0]!.lane_config);
  cfg.dms = { ...cfg.dms, relationship_dms_enabled: enabled };
  const rows = await sql<{ id: string }[]>`
    update noelle.agent_instances
    set lane_config = ${sql.json(cfg as never)}, updated_at = now()
    where id = ${instanceId}
      and org_id = ${auth.org.id}
      and role in ${sql(RELATIONSHIP_DM_ROLES)}
    returning id
  `;
  if (rows.length === 0) {
    return { ok: false, error: { code: "not_found", message: "Agent instance not found." } };
  }

  revalidatePath(AGENT_PAGE_ROUTE, "page");
  return { ok: true };
}

const StartAllInput = z.object({
  orgSlug: z.string().min(1),
  instanceId: z.string().uuid(),
  // optional goal-run target ("get me N leads ready"). 1..500; absent = no goal.
  goalTarget: z.number().int().positive().max(500).optional(),
  // optional "Tailor this run" discovery override for THIS run only. Absent =
  // use the saved default (run_config is cleared so no stale override lingers).
  runConfig: DiscoveryConfigSchema.optional(),
});
const StopAllInput = z.object({
  orgSlug: z.string().min(1),
  instanceId: z.string().uuid(),
});

async function authorizeOrg(orgSlug: string) {
  const user = await getCurrentUser();
  if (!user) return { kind: "unauthenticated" as const };
  try {
    const org = await getOrgBySlug(orgSlug);
    if (!org) return { kind: "not_found" as const };
    return { kind: "ok" as const, org };
  } catch (err) {
    if (err instanceof OrgMembershipError) return { kind: "forbidden" as const };
    throw err;
  }
}

/**
 * Start the whole pipeline: activate the instance, turn every worker on, stamp
 * pipeline_started_at (anchors the "since you turned it on" counts), and — if a
 * goalTarget is given — open a goal-run (the drafter then raises its effective
 * cap to the target and the pipeline auto-pauses once N approvals are produced).
 * Org-scoped UPDATE (the org_id match is the IDOR guard).
 */
export async function startAll(
  input: z.infer<typeof StartAllInput>,
): Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }> {
  const parsed = StartAllInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: { code: "bad_input", message: parsed.error.message } };
  const { orgSlug, instanceId, goalTarget, runConfig } = parsed.data;
  const auth = await authorizeOrg(orgSlug);
  if (auth.kind !== "ok") return { ok: false, error: { code: auth.kind, message: auth.kind } };

  const goal = goalTarget ?? null;
  // Stamp the per-run override (or clear any stale one) so the discovery worker
  // reads run_config merged over the saved default for this run. Pass the object
  // through sql.json (NOT JSON.stringify) — postgres.js JSON-encodes a jsonb-bound
  // param itself, so a pre-stringified value would be double-encoded into a jsonb
  // *string* the reader can't parse. null → SQL NULL (clears the override).
  const runConfigParam = runConfig && Object.keys(runConfig).length > 0 ? sql.json(runConfig) : null;
  // Stamp last_goal_started_at on every goal-run START and never clear it, so the
  // inbox's "Last batch" filter can still find the run's output after the goal
  // auto-pauses (which nulls goal_started_at). coalesce keeps the prior value on a
  // no-goal start. See infra/cloudsql/schema/0027_last_goal_started_at.sql.
  const goalStartedAt = goal != null ? new Date() : null;
  const rows = await sql<{ id: string }[]>`
    update noelle.agent_instances
    set status = 'active',
        discovery_enabled = true, classifier_enabled = true,
        drafter_enabled = true,
        pipeline_started_at = now(),
        goal_target = ${goal},
        goal_started_at = ${goalStartedAt},
        last_goal_started_at = coalesce(${goalStartedAt}, last_goal_started_at),
        run_config = ${runConfigParam},
        updated_at = now()
    where id = ${instanceId} and org_id = ${auth.org.id} and role in ${sql(INTERN_ROLES)}
      and status in ('active', 'paused')
    returning id
  `;
  if (rows.length === 0) return { ok: false, error: { code: "not_found", message: "Agent instance not found." } };
  revalidatePath(AGENT_PAGE_ROUTE, "page");
  return { ok: true };
}

/** Stop the whole pipeline: pause the instance and clear any goal-run. */
export async function stopAll(
  input: z.infer<typeof StopAllInput>,
): Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }> {
  const parsed = StopAllInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: { code: "bad_input", message: parsed.error.message } };
  const { orgSlug, instanceId } = parsed.data;
  const auth = await authorizeOrg(orgSlug);
  if (auth.kind !== "ok") return { ok: false, error: { code: auth.kind, message: auth.kind } };

  const rows = await sql<{ id: string }[]>`
    update noelle.agent_instances
    set status = 'paused', goal_target = null, goal_started_at = null,
        run_config = null, updated_at = now()
    where id = ${instanceId} and org_id = ${auth.org.id} and role in ${sql(INTERN_ROLES)}
      and status in ('active', 'paused')
    returning id
  `;
  if (rows.length === 0) return { ok: false, error: { code: "not_found", message: "Agent instance not found." } };
  revalidatePath(AGENT_PAGE_ROUTE, "page");
  return { ok: true };
}

const SetRunScheduleInput = z.object({
  orgSlug: z.string().min(1),
  instanceId: z.string().uuid(),
  schedule: RunScheduleSchema,
});

/**
 * Save (or update) the recurring scheduled run for an intern instance
 * (0085_run_schedule.sql). Stores the schedule config and stamps the next fire
 * time the api-vm scheduler triggers on. A disabled schedule is still stored (so
 * the form remembers the operator's mode/time) but its next_at is null, so
 * nothing fires. Org-scoped UPDATE; the org_id match is the IDOR guard.
 *
 * A firing does exactly what startAll does — this action never starts a run
 * itself, it only arms the timer that will.
 */
export async function setRunSchedule(
  input: z.infer<typeof SetRunScheduleInput>,
): Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }> {
  const parsed = SetRunScheduleInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: { code: "bad_input", message: parsed.error.message } };
  const { orgSlug, instanceId, schedule } = parsed.data;
  const auth = await authorizeOrg(orgSlug);
  if (auth.kind !== "ok") return { ok: false, error: { code: auth.kind, message: auth.kind } };

  // null next_at when disabled (computeNextRunAt returns null), so an off schedule
  // is inert; an on schedule gets its first fire time immediately so the panel can
  // show "Next run" without waiting for a scheduler tick.
  const nextAt = computeNextRunAt(schedule, new Date());
  const rows = await sql<{ id: string }[]>`
    update noelle.agent_instances
    set run_schedule = ${sql.json(schedule)},
        run_schedule_next_at = ${nextAt},
        updated_at = now()
    where id = ${instanceId} and org_id = ${auth.org.id} and role in ${sql(INTERN_ROLES)}
    returning id
  `;
  if (rows.length === 0) return { ok: false, error: { code: "not_found", message: "Agent instance not found." } };
  revalidatePath(AGENT_PAGE_ROUTE, "page");
  return { ok: true };
}

const PauseAllInput = z.object({ orgSlug: z.string().min(1) });

/**
 * Global pause: clear master sending, reply, autonomous and X API write
 * consent on every supported intern in this org, in one UPDATE.
 * Deliberately asymmetric: there is NO resumeAll — re-arming is per-intern so a pause
 * cannot be casually undone. Org-scoped; org_id match is the IDOR guard.
 * Only ever writes `false`, so it can never fail OPEN into more sending.
 *
 * No feature flag on purpose: the "flag-gate every change, default OFF" rule
 * targets paths that could INCREASE sending. This action can only decrease it,
 * so gating a panic valve off-by-default would hide it exactly when it's
 * needed. No try/catch swallow, either: a thrown SQL error must surface as
 * "we could not confirm sending was off" (operator retries), never a false
 * "paused" — the only fail direction is toward safety.
 */
export async function pauseAllSending(
  input: z.infer<typeof PauseAllInput>,
): Promise<{ ok: true; paused: number } | { ok: false; error: { code: string; message: string } }> {
  const parsed = PauseAllInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: { code: "bad_input", message: parsed.error.message } };
  const { orgSlug } = parsed.data;
  const auth = await authorizeOrg(orgSlug);
  if (auth.kind !== "ok") return { ok: false, error: { code: auth.kind, message: auth.kind } };

  // Include master-only and API-only rows: original posts use those switches
  // independently of reply consent. Repeated calls count only changed rows.
  const rows = await sql<{ id: string }[]>`
    update noelle.agent_instances
    set send_enabled = false, reply_send_enabled = false,
        auto_send_enabled = false, x_api_write_enabled = false, updated_at = now()
    where org_id = ${auth.org.id}
      and role in ${sql(INTERN_ROLES)}
      and (send_enabled = true or reply_send_enabled = true
        or auto_send_enabled = true or x_api_write_enabled = true)
    returning id
  `;
  // Revalidate every affected surface: the agent page route PATTERN (all
  // slug+uuid variants), the org chart, and the approvals page the button
  // lives on, so each reflects the new OFF state without a hard reload.
  revalidatePath(AGENT_PAGE_ROUTE, "page");
  revalidatePath(`/app/${orgSlug}/org-chart`);
  revalidatePath(`/app/${orgSlug}/approvals`);
  return { ok: true, paused: rows.length };
}
