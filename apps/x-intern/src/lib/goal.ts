import type { Sql } from "postgres";
import type { ActiveInstance } from "./activation.js";

/** The active goal target, or null when no goal-run is in progress. */
export function goalTarget(inst: ActiveInstance): number | null {
  if (inst.goal_target == null || inst.goal_started_at == null) return null;
  return inst.goal_target;
}

/**
 * The drafter's EFFECTIVE pending-drafts cap. During a goal-run the cap is
 * raised to at least the target so backpressure doesn't stall the run before it
 * produces N ready approvals. Outside a goal-run, the configured cap applies
 * unchanged. A null cap means "no cap" and stays null.
 */
export function effectiveDraftsCap(inst: ActiveInstance): number | null | undefined {
  const target = goalTarget(inst);
  if (target == null) return inst.pending_drafts_cap;
  if (inst.pending_drafts_cap == null) return inst.pending_drafts_cap; // already unbounded
  return Math.max(inst.pending_drafts_cap, target);
}

/** How long a goal-run may make zero progress before it's auto-paused as stalled. */
export const DEFAULT_GOAL_STALL_MS = 2 * 60 * 60_000; // 2h

export interface GoalEnforcement {
  paused: boolean;
  produced: number;
  target: number;
  /** True when the pause was a STALL (no new leads for stallMs), not target reached. */
  stalled: boolean;
}

export interface EnforceGoalOpts {
  /** Auto-pause once a goal-run has made no progress for this long. Default 2h. */
  stallMs?: number;
  /** Injectable clock + queries for tests. */
  now?: Date;
  countApprovalsSince?: (sql: Sql, instanceId: string, since: string) => Promise<number>;
  lastApprovalAtSince?: (sql: Sql, instanceId: string, since: string) => Promise<string | null>;
}

/**
 * Goal auto-stop. When a goal-run is active and the pipeline has produced at
 * least `goal_target` approvals since `goal_started_at`, pause the instance and
 * clear the goal — pausing stops every worker via the status gate. Returns the
 * enforcement result, or null when no goal is active. `countApprovalsSince` is
 * injectable for tests.
 */
export async function enforceGoal(
  sql: Sql,
  inst: ActiveInstance,
  opts: EnforceGoalOpts = {},
): Promise<GoalEnforcement | null> {
  const target = goalTarget(inst);
  if (target == null || inst.goal_started_at == null) return null;

  const countApprovalsSince = opts.countApprovalsSince ?? defaultCountApprovalsSince;
  const lastApprovalAtSince = opts.lastApprovalAtSince ?? defaultLastApprovalAtSince;
  const stallMs = opts.stallMs ?? DEFAULT_GOAL_STALL_MS;
  const now = opts.now ?? new Date();

  const produced = await countApprovalsSince(sql, inst.id, inst.goal_started_at);
  const reached = produced >= target;

  // STALL GUARD (ported from Lyra #134). Without it Vega's enforceGoal had ONE
  // exit — target reached — so a goal the watchlist can never satisfy (target
  // larger than the accounts can ever produce) polls Apify forever. Each tick is
  // bounded, so the burn is slow rather than unbounded, but it never stops on
  // its own and the operator has to notice.
  let stalled = false;
  if (!reached) {
    // Time since the last REPLY landed (or since the goal started, if none).
    const lastAt =
      (await lastApprovalAtSince(sql, inst.id, inst.goal_started_at)) ?? inst.goal_started_at;
    stalled = now.getTime() - new Date(lastAt).getTime() >= stallMs;
    if (!stalled) return { paused: false, produced, target, stalled: false };
  }

  await sql`
    update noelle.agent_instances
    set status = 'paused', goal_target = null, goal_started_at = null,
        run_config = null, updated_at = now()
    where id = ${inst.id} and goal_target is not null
  `;
  return { paused: true, produced, target, stalled };
}

async function defaultLastApprovalAtSince(
  sql: Sql,
  instanceId: string,
  since: string,
): Promise<string | null> {
  // Time since the last REPLY lead landed. A goal-run is "N replies ready", so a
  // DM (kind='dm', a separate post-less lead) trickling in must NOT count as
  // progress, or it would mask a genuine reply stall and keep the run alive.
  const rows = await sql<{ last_at: string | null }[]>`
    select max(a.created_at)::text as last_at
    from noelle.approvals a
    join noelle.drafts d on d.id = a.draft_id
    where a.agent_instance_id = ${instanceId}
      and a.created_at >= ${since}
      and coalesce(d.payload->>'kind', 'reply') = 'reply'
  `;
  return rows[0]?.last_at ?? null;
}

async function defaultCountApprovalsSince(
  sql: Sql,
  instanceId: string,
  since: string,
): Promise<number> {
  // Count distinct LEADS delivered with a REPLY (each lead fans out to ~3 reply
  // angles + 1 DM). The goal is "N leads ready" and the whole UX is per-reply-lead,
  // so count reply-leads, not rows and not DM-only leads.
  const rows = await sql<{ n: number }[]>`
    select count(distinct a.lead_id)::int as n
    from noelle.approvals a
    left join noelle.drafts d on d.id = a.draft_id
    where a.agent_instance_id = ${instanceId} and a.created_at >= ${since}
      and coalesce(d.payload->>'kind', 'reply') <> 'dm'
  `;
  return rows[0]?.n ?? 0;
}
