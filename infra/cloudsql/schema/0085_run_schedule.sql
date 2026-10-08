-- infra/cloudsql/schema/0085_run_schedule.sql
-- Recurring scheduled run per intern instance (Vega / Lyra / Orion / Nova).
--
-- A "scheduled run" is a standing order that auto-fires the existing Start-all
-- goal-run on a timer, so the pipeline runs on a cadence without the operator
-- clicking the button. A firing is nothing more than "press Start all with
-- goal = N" — it stamps the same goal-run columns (0021_pipeline_goal.sql) and
-- the worker auto-pause (enforceGoal) still stops the run at the target.
--
-- Two columns, mirroring how run_config / discovery_config (0032) are stored:
--   run_schedule          — the saved schedule config (shape = RunScheduleSchema
--                           in @noelle/contracts): { enabled, mode:'interval'|
--                           'daily', intervalHours?, dailyTime?, timezone, goal }.
--                           NULL = no schedule.
--   run_schedule_next_at  — the next computed fire time. The api-vm scheduler
--                           (apps/api-vm/src/lib/scheduler.ts) polls for rows
--                           whose next_at is due, fires them, and recomputes it.
--                           NULL = nothing scheduled / disabled.
--
-- Both nullable with no default, so every existing instance backfills to "no
-- schedule" (the button-only behaviour) — nothing fires until an operator arms a
-- schedule from the agent page. Draft-only safety is unchanged: reply_send_enabled
-- (0081, default OFF) still gates all posting, so a scheduled run only drafts into
-- the approval queue.

alter table noelle.agent_instances
  add column if not exists run_schedule jsonb,
  add column if not exists run_schedule_next_at timestamptz;

-- Partial index: the scheduler's hot query is "which armed schedules are due?"
-- (where run_schedule_next_at <= now()). Indexing only the armed rows keeps it
-- tiny — the vast majority of instances have no schedule.
create index if not exists agent_instances_run_schedule_next_at_idx
  on noelle.agent_instances (run_schedule_next_at)
  where run_schedule_next_at is not null;
