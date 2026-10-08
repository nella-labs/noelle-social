-- A persistent operator override for the browser actor's daily reply limit.
-- NULL keeps the platform's existing environment default. This setting is
-- separate from the X official-API write budget and LinkedIn DM approvals.
alter table noelle.agent_instances
  add column if not exists actuator_daily_reply_cap integer
    check (actuator_daily_reply_cap between 0 and 500);
