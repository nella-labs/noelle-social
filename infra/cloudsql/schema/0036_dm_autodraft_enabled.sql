-- infra/cloudsql/schema/0036_dm_autodraft_enabled.sql
-- Per-instance flag for AUTO-drafting a DM alongside each reply.
--
-- Both drafters (Vega: apps/x-intern, Lyra: apps/linkedin-intern) historically
-- emitted a cold-outreach DM draft for every qualifying post, which buried the
-- reply queue ("a DM per reply"). DMs are now OPT-IN: when false (the default),
-- the drafters generate replies only. The operator flips this on per-instance
-- from the dashboard when they want auto-DMs again, or generates a DM on demand
-- for a specific person they've replied to.
--
-- Default FALSE — auto-DM is the deliberate exception now, not the norm. So on
-- deploy every existing instance switches to replies-only (the operator's
-- stated intent), with no data backfill needed. The drafters read it in onTick
-- via inst.dm_autodraft_enabled (see drafter-tick.ts in both apps).
alter table noelle.agent_instances
  add column if not exists dm_autodraft_enabled boolean not null default false;
