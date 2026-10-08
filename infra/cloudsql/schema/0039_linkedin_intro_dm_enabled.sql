-- infra/cloudsql/schema/0039_linkedin_intro_dm_enabled.sql
-- Per-instance flag for the LinkedIn intro-DM lane (Lyra).
--
-- Lyra can draft ONE warm, one-time relationship-building DM per watched
-- connection (no pitch), queued for approval (see docs/linkedin-intern.md →
-- "Intro DM lane"). It used to be gated only by the process-wide env var
-- LINKEDIN_INTRO_DM_ENABLED, which the operator couldn't see or change from the
-- dashboard. This moves the switch onto the instance so it's a normal toggle on
-- the agent's Config page (next to "Auto-draft DMs", 0036), per-agent.
--
-- Default FALSE — intro DMs are the deliberate exception (replies are the unit),
-- matching the operator's intent after a goal-run got buried by intro DMs. The
-- drafter reads it in onTick via inst.linkedin_intro_dm_enabled and STILL never
-- runs the lane during a goal-run (reply-only objective). The env var remains a
-- legacy fallback when the column is absent (pre-migration worker).
alter table noelle.agent_instances
  add column if not exists linkedin_intro_dm_enabled boolean not null default false;
