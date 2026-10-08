-- infra/cloudsql/schema/0019_worker_enabled.sql
-- Per-worker enable flags for the X intern pipeline. The dashboard Start/Pause
-- still flips agent_instances.status (the master switch — paused stops the
-- whole instance). Within an *active* instance, these four booleans let the
-- operator run discovery / classifier / drafter / send independently.
--
-- Default true so existing active instances keep running all four workers
-- exactly as before. Each worker reads its own flag in onTick (via
-- isWorkerEnabled in apps/x-intern/src/lib/activation.ts) and no-ops when off.

alter table noelle.agent_instances
  add column if not exists discovery_enabled  boolean not null default true,
  add column if not exists classifier_enabled boolean not null default true,
  add column if not exists drafter_enabled    boolean not null default true,
  add column if not exists send_enabled        boolean not null default true;
