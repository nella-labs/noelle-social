-- infra/cloudsql/schema/0027_last_goal_started_at.sql
-- "Last batch" support for the approvals inbox.
--  - goal_started_at is CLEARED when a goal-run completes (auto-pause) or is
--    stopped, so it can't anchor "show me the batch I just generated" after the
--    fact. last_goal_started_at is a sticky copy: stamped to now() every time a
--    goal-run starts and NEVER cleared, so the inbox can always filter to "the
--    most recent goal-run's output" (approvals created at/after this timestamp).
--  - Null until the first goal-run is started for the instance.

alter table noelle.agent_instances
  add column if not exists last_goal_started_at timestamptz;
