-- 0076_x_api_config.sql
--
-- The org's X API subscription tier + flat MONTHLY cost, surfaced on the Spends
-- page. The X API bills a fixed monthly tier (not per call), so it is recorded
-- as a subscription line — separate from the per-call LLM / Apify metering, and
-- (like Apify) it never counts toward the LLM budget cap. Hand-applied; grants
-- inherited from 0001.
create table if not exists noelle.x_api_config (
  org_id              uuid primary key references noelle.organizations(id) on delete cascade,
  tier                text not null default 'basic',
  monthly_cost_cents  bigint not null default 0,
  write_cap_monthly   integer,
  read_cap_monthly    integer,
  updated_at          timestamptz not null default now()
);

drop trigger if exists x_api_config_set_updated_at on noelle.x_api_config;
create trigger x_api_config_set_updated_at
  before update on noelle.x_api_config
  for each row execute function noelle.tg_set_updated_at();
