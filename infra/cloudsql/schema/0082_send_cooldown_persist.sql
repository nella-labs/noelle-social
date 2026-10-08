-- 0082_send_cooldown_persist.sql
-- Persist the X send worker's 429 backoff so a pm2 deploy-restart cannot resume
-- posting into an actively rate-limited account (docs/x-account-safety.md §1/#4).
-- Both columns are consumed ONLY by apps/x-intern/src/workers/send.ts and ONLY
-- when env X_PERSIST_SEND_COOLDOWN is truthy; with the flag off they are inert.
-- send_cooldown_until: absolute UTC instant the 429 cooldown expires (NULL = none).
-- rate_limit_streak:   escalating-ladder counter (0 = no active streak).
-- Nullable / default 0 backfills every EXISTING instance to "no cooldown", so the
-- migration alone changes no behavior and is fail-safe.
alter table noelle.agent_instances
  add column if not exists send_cooldown_until timestamptz,
  add column if not exists rate_limit_streak   integer not null default 0;
