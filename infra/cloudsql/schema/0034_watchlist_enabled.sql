-- infra/cloudsql/schema/0034_watchlist_enabled.sql
-- Per-instance enable flag for the always-on Watchlist lane.
--
-- Like profiler_enabled (0024), this is decoupled from the master Start/Pause.
-- The watchlist lane — replies + DMs to the operator's watchlist people (the
-- always-reply accounts) — runs whether the instance is active or paused,
-- gated only on this flag. So the watched accounts keep getting drafts even
-- while the keyword pipeline is paused (the gap the operator hit: priority
-- leads piled up in 'new' because discovery/classify/draft skip paused
-- instances). The keyword lane (non-priority leads) stays gated on the master
-- Start/Pause as before.
--
-- Default true so every existing instance has the watchlist lane on. The
-- workers read it in onTick via isWorkerEnabled(inst, "watchlist") and the
-- discovery/classifier/drafter selectors widen to status in ('active','paused')
-- (see listWatchlistOrActiveXInternInstances in apps/x-intern/src/lib/activation.ts).

alter table noelle.agent_instances
  add column if not exists watchlist_enabled boolean not null default true;
