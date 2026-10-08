-- 0075_x_api_write.sql
--
-- Official X API v2 write path for Vega (x_intern). Adds OAuth token storage, an
-- atomic per-day COMBINED (posts + replies) budget counter, and the per-agent
-- enable flag + daily cap. The cookie path (@steipete/bird) stays available as a
-- reply fallback; bird cannot post top-level tweets, so original posts always go
-- through the official API. Hand-applied; grants inherited from 0001.

-- One connected X account per agent instance. Server-rotating OAuth2 tokens.
create table if not exists noelle.x_api_tokens (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null references noelle.organizations(id) on delete cascade,
  agent_instance_id        uuid not null references noelle.agent_instances(id) on delete cascade,
  access_token             text not null,
  access_token_expires_at  timestamptz,
  refresh_token            text,
  scope                    text,
  x_user_id                text,
  x_handle                 text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (agent_instance_id)
);

drop trigger if exists x_api_tokens_set_updated_at on noelle.x_api_tokens;
create trigger x_api_tokens_set_updated_at
  before update on noelle.x_api_tokens
  for each row execute function noelle.tg_set_updated_at();

-- The ONE atomic combined posts+replies daily counter. The send + publish
-- workers both reserve from this same row via a conditional UPSERT
-- (used < cap), so concurrency can never exceed the cap.
create table if not exists noelle.x_api_write_budget (
  agent_instance_id  uuid not null references noelle.agent_instances(id) on delete cascade,
  org_id             uuid not null references noelle.organizations(id) on delete cascade,
  day                date not null,
  used               integer not null default 0,
  primary key (agent_instance_id, day)
);

-- Per-agent X API write enablement + the daily combined cap (30 by default).
-- Distinct from send_enabled (master worker gate, 0019) and auto_send_enabled
-- (auto-queue toggle, 0015): a writable X-API client requires role=x_intern AND
-- send_enabled AND x_api_write_enabled.
alter table noelle.agent_instances
  add column if not exists x_api_write_enabled   boolean not null default false,
  add column if not exists x_api_daily_write_cap integer not null default 30;
