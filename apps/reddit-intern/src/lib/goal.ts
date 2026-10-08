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
 * produces N ready approvals. Outside a goal-run the configured cap applies.
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
  /** True when the pause was a stall (no new leads for stallMs), not target reached. */
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
 * Goal auto-stop. Pauses the instance + clears the goal (which stops every worker
 * via the status gate) when EITHER:
 *   - the pipeline has produced >= goal_target leads since goal_started_at, OR
 *   - it has produced nothing new for `stallMs` (the watchlist is exhausted).
 *
 * The stall guard is what stops an unreachable goal (target > what the watchlist
 * can ever produce) from polling Apify forever and burning money.
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

  let stalled = false;
  if (!reached) {
    // Time since the last lead delivered (or since the goal started, if none).
    const lastAt = (await lastApprovalAtSince(sql, inst.id, inst.goal_started_at)) ?? inst.goal_started_at;
    stalled = now.getTime() - new Date(lastAt).getTime() >= stallMs;
    if (!stalled) return { paused: false, produced, target, stalled: false };
  }

  await sql`
    update noelle.agent_instances
    set status = 'paused', goal_target = null, goal_started_at = null, updated_at = now()
    where id = ${inst.id} and goal_target is not null
  `;
  return { paused: true, produced, target, stalled };
}

async function defaultLastApprovalAtSince(
  sql: Sql,
  instanceId: string,
  since: string,
): Promise<string | null> {
  // Time since the last REPLY lead landed — a goal-run is "N replies ready", so
  // an intro-DM (kind='dm', a separate post-less lead) trickling in must NOT count
  // as progress, or it would mask a genuine reply stall and keep the run alive.
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
  // Count distinct REPLY LEADS delivered. The goal is "N replies ready", so DMs
  // (auto-DM siblings AND post-less intro DMs) must NOT count — otherwise a
  // reply-goal of 30 "reaches" its target on intro DMs and auto-pauses while only
  // ~10 real replies exist (the bug). A reply lead with an attached DM still
  // counts ONCE (distinct lead). Matches the dashboard's leads_ready (queries.ts).
  const rows = await sql<{ n: number }[]>`
    select count(distinct a.lead_id)::int as n
    from noelle.approvals a
    join noelle.drafts d on d.id = a.draft_id
    where a.agent_instance_id = ${instanceId}
      and a.created_at >= ${since}
      and coalesce(d.payload->>'kind', 'reply') = 'reply'
  `;
  return rows[0]?.n ?? 0;
}
