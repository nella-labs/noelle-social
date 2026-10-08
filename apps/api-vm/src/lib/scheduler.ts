import type { Sql } from "postgres";
import { parseRunSchedule } from "@noelle/contracts";
import { planScheduledRun } from "@noelle/runtime";
import { noelleDb } from "./db.js";
import { loadEnv } from "../env.js";

// api-vm owns recurring runs for every intern role (0085_run_schedule.sql).
// Firing enables the pipeline and stamps a goal run; enforceGoal stops it at
// the goal. Existing send settings and queue review still govern publication.

const INTERN_ROLES = ["x_intern", "linkedin_intern", "reddit_intern", "video_intern"] as const;

interface DueRow {
  id: string;
  run_schedule: unknown;
  goal_target: number | null;
}

export interface SchedulerTickResult {
  fired: number;
  skipped: number;
  cleared: number;
}

/**
 * One scheduler pass: find every armed schedule whose next_at is due and act on
 * it. Pure decision-making lives in planScheduledRun (@noelle/runtime, unit
 * tested); this function is the thin DB wrapper that executes the plan.
 *
 *   - fire  → open a goal-run (the Start-all writes) with the schedule's goal.
 *   - skip  → a run is already active; never stomp it, just roll next_at forward.
 *   - clear → the schedule is disabled/invalid; null next_at so it stops.
 */
export async function runSchedulerTick(
  sql: Sql = noelleDb(),
  now: Date = new Date(),
): Promise<SchedulerTickResult> {
  const due = await sql<{ id: string }[]>`
    select id
    from noelle.agent_instances
    where run_schedule_next_at is not null
      and run_schedule_next_at <= ${now}
      and role in ${sql(INTERN_ROLES)}
      and status in ('active', 'paused')
    order by run_schedule_next_at, id
    limit 200
  `;

  const result: SchedulerTickResult = { fired: 0, skipped: 0, cleared: 0 };

  for (const candidate of due) {
    const action = await sql.begin(async tx => {
      await tx`set local lock_timeout='5s'`;
      await tx`set local statement_timeout='10s'`;
      const [row] = await tx<DueRow[]>`
        select id, run_schedule, goal_target from noelle.agent_instances
        where id=${candidate.id} and run_schedule_next_at<=${now}
          and role in ${tx(INTERN_ROLES)} and status in ('active','paused')
        for update skip locked
      `;
      if (!row) return null;
      const plan = planScheduledRun({
        runSchedule: parseRunSchedule(row.run_schedule), goalActive: row.goal_target != null,
      }, now);
      if (plan.action === "clear") {
        await tx`update noelle.agent_instances set run_schedule_next_at=null,updated_at=now() where id=${row.id}`;
      } else if (plan.action === "skip") {
        await tx`update noelle.agent_instances set run_schedule_next_at=${plan.nextAt},updated_at=now() where id=${row.id}`;
      } else {
        await tx`
          update noelle.agent_instances
          set status='active', discovery_enabled=true, classifier_enabled=true, drafter_enabled=true,
              pipeline_started_at=now(), goal_target=${plan.goal}, goal_started_at=now(),
              last_goal_started_at=now(), run_config=null, run_schedule_next_at=${plan.nextAt},updated_at=now()
          where id=${row.id}
        `;
      }
      return plan.action;
    });
    if (action === "fire") result.fired++;
    else if (action === "skip") result.skipped++;
    else if (action === "clear") result.cleared++;
  }

  return result;
}

let timer: ReturnType<typeof setInterval> | undefined;
let initialTimer: ReturnType<typeof setTimeout> | undefined;
let tickRunning = false;

/**
 * Start the scheduler poll loop on the api-vm process. No-op when
 * NOELLE_RUN_SCHEDULER is off, or if already started. Idempotent.
 */
export function startSchedulerLoop(): void {
  const env = loadEnv();
  if (!env.NOELLE_RUN_SCHEDULER) {
    console.log("[scheduler] disabled (NOELLE_RUN_SCHEDULER=0)");
    return;
  }
  if (timer) return;

  const pollMs = env.NOELLE_RUN_SCHEDULER_POLL_MS;
  console.log(`[scheduler] on — polling every ${pollMs}ms`);

  const tick = async () => {
    if (!timer || tickRunning) return;
    tickRunning = true;
    try {
      const res = await runSchedulerTick();
      if (res.fired || res.skipped || res.cleared) {
        console.log(
          `[scheduler] tick fired=${res.fired} skipped=${res.skipped} cleared=${res.cleared}`,
        );
      }
    } catch (err) {
      // Never let a bad tick kill the loop — log and try again next interval.
      console.error("[scheduler] tick failed:", err);
    } finally {
      tickRunning = false;
    }
  };

  timer = setInterval(tick, pollMs);
  // Don't hold the process open for the scheduler alone; the HTTP server keeps
  // the event loop alive.
  timer.unref?.();
  // A short initial tick so a due schedule fires soon after boot (not blocking).
  initialTimer = setTimeout(tick, 2_000);
  initialTimer.unref?.();
}

/** Stop the loop (tests / graceful shutdown). */
export function stopSchedulerLoop(): void {
  if (initialTimer) { clearTimeout(initialTimer); initialTimer = undefined; }
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}
