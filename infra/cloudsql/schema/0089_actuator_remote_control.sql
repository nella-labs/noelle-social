-- infra/cloudsql/schema/0089_actuator_remote_control.sql
-- Remote start/stop of the browser actuators (the "hands"): Vega/X, Lyra/LinkedIn,
-- Orion/Reddit. Today the actuator run lifecycle (Run / STOP / Full-automatic)
-- lives only in chrome.storage and is driven by the in-page panel, so it can only
-- be controlled from a browser at the machine. This makes the "should the hands be
-- running?" decision a durable, org-scoped SERVER value the phone (dashboard),
-- the MCP, and the local panel all write, and that each extension reconciles to
-- in near-real-time over a long-poll (GET /api/actuator/intent).
--
--   actuator_desired_state — the operator's intent for the hands:
--     NULL      = no remote override; the extension's LOCAL autonomy governs
--                 exactly as before this migration (backward-compatible default).
--     'running' = run persistently (Full-automatic). NOTE this is "hands allowed
--                 to run", NOT send-consent: on X, replies still only post when
--                 reply_send_enabled/auto_send_enabled is on (0081/0015). The
--                 existing kill switches stay authoritative.
--     'stopped' = fully paused: the extension ends any live run AND gates every
--                 autonomy path off until this flips back.
--   actuator_command_at — bumped to now() on every desired-state change. The
--     long-poll's change signal (return immediately when it advances past the
--     value the extension last saw) and the "stopped 2m ago" display source.
--   actuator_last_state — the extension's own report of its ACTUAL run state
--     ('running' | 'idle'), so the dashboard shows reality, not just intent.
--   actuator_seen_at — when the extension last acked; liveness ("did my tap
--     reach the hands?" / offline detection).
--
-- All nullable with no backfill: every existing instance starts with
-- desired_state NULL = today's behavior, so deploying this changes nothing until
-- the operator first uses the switch. One actuator per intern instance (1:1), so
-- these columns live on agent_instances alongside status/reply_send_enabled.

alter table noelle.agent_instances
  add column if not exists actuator_desired_state text,
  add column if not exists actuator_command_at timestamptz,
  add column if not exists actuator_last_state text,
  add column if not exists actuator_seen_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'agent_instances_actuator_desired_state_check'
  ) then
    alter table noelle.agent_instances
      add constraint agent_instances_actuator_desired_state_check
      check (actuator_desired_state is null or actuator_desired_state in ('running', 'stopped'));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'agent_instances_actuator_last_state_check'
  ) then
    alter table noelle.agent_instances
      add constraint agent_instances_actuator_last_state_check
      check (actuator_last_state is null or actuator_last_state in ('running', 'idle'));
  end if;
end $$;
