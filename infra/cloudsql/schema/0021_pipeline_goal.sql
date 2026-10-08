-- infra/cloudsql/schema/0021_pipeline_goal.sql
-- Goal-run + pipeline-session state for the unified Pipeline panel.
--  - pipeline_started_at: when "Start all" was last hit; anchors the "since you
--    turned it on" per-worker counts.
--  - goal_target / goal_started_at: an active goal-run ("get me N leads ready").
--    While set, the drafter's effective pending-drafts cap is raised to >= target
--    and a worker-side check auto-pauses the instance once N approvals have been
--    produced since goal_started_at. Both null = no active goal.
-- See docs/superpowers/specs/2026-05-30-pipeline-panel-design.md.

alter table noelle.agent_instances
  add column if not exists pipeline_started_at timestamptz,
  add column if not exists goal_target          integer,
  add column if not exists goal_started_at       timestamptz;
