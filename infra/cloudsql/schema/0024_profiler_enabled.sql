-- infra/cloudsql/schema/0024_profiler_enabled.sql
-- Per-instance enable flag for the watchlist profiler worker.
--
-- Unlike the four pipeline flags from 0019 (which gate workers *within* an
-- active instance), the profiler is decoupled from the master Start/Pause:
-- profiling watchlist people is passive background enrichment, useful even
-- while the reply pipeline is paused. The profiler worker selects instances
-- with status in ('active','paused') (see listProfilerXInternInstances in
-- apps/x-intern/src/lib/activation.ts) and gates only on this flag, so the
-- operator can run profiling alone while everything else stays paused.
--
-- Default true so existing instances keep profiling exactly as before. The
-- worker reads it in onTick via isWorkerEnabled(inst, "profiler") and no-ops
-- when off.

alter table noelle.agent_instances
  add column if not exists profiler_enabled boolean not null default true;
