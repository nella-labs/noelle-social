-- Optional daily variation beneath the X browser actor's configured ceiling.
-- The sampled value and database day survive requests, restarts and reloads.
alter table noelle.agent_instances
  add column if not exists actuator_daily_reply_cap_min integer
    check (actuator_daily_reply_cap_min is null or
      (role = 'x_intern' and actuator_daily_reply_cap is not null
       and actuator_daily_reply_cap_min between 0 and actuator_daily_reply_cap)),
  add column if not exists actuator_daily_reply_cap_day date,
  add column if not exists actuator_daily_reply_cap_effective integer
    check (actuator_daily_reply_cap_effective is null or
      (actuator_daily_reply_cap_min is not null
       and actuator_daily_reply_cap_day is not null
       and actuator_daily_reply_cap_effective between
         actuator_daily_reply_cap_min and actuator_daily_reply_cap));
