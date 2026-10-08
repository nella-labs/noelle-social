-- 0078_worker_run_summary.sql
--
-- Make a worker run inspectable + controllable (Nova harvest console). Today a
-- run is one worker_runs row, finalized only at the end, with no per-lane detail
-- and no way to attribute it to an instance or stop it mid-flight.
--
--   instance_id      -- which agent_instance this run belongs to (was worker-only)
--   summary          -- per-lane outcome, written incrementally as the tick runs
--                       (powers live progress + drop-reason visibility)
--   cancel_requested -- Stop signal the worker polls between pulls to bail cleanly
--
-- Hand-applied; grants inherited from 0001.
alter table noelle.worker_runs
  add column if not exists instance_id      uuid references noelle.agent_instances(id) on delete cascade,
  add column if not exists summary          jsonb not null default '{}'::jsonb,
  add column if not exists cancel_requested boolean not null default false;

-- The console queries "latest harvester run for this instance"; index it.
create index if not exists worker_runs_instance_worker_started_idx
  on noelle.worker_runs (instance_id, worker, started_at desc);
