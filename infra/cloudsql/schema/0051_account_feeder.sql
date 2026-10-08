-- 0051_account_feeder.sql
-- Account Feeder: source list + style corpus + ultra profiles (Lyra-first, platform-generic).
-- Design: docs/superpowers/specs/2026-06-19-account-feeder-design.md

-- A) curated source accounts to learn style from
create table if not exists noelle.account_feeder_sources (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references noelle.organizations(id) on delete cascade,
  agent_instance_id uuid not null references noelle.agent_instances(id) on delete cascade,
  platform text not null default 'linkedin',
  handle text not null,
  display_name text,
  note text,
  enabled boolean not null default true,
  last_pulled_at timestamptz,
  created_at timestamptz not null default now(),
  unique (agent_instance_id, platform, handle)
);
create index if not exists account_feeder_sources_instance_idx
  on noelle.account_feeder_sources (agent_instance_id, enabled);
grant select, insert, update, delete on noelle.account_feeder_sources to noelle_app;

-- B) the style corpus (posts + comments); performance promoted to columns for SQL-side ranking
create table if not exists noelle.account_style_posts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references noelle.organizations(id) on delete cascade,
  agent_instance_id uuid not null references noelle.agent_instances(id) on delete cascade,
  platform text not null default 'linkedin',
  account_handle text not null,
  external_id text not null,
  kind text not null default 'post' check (kind in ('post','comment')),
  body text not null,
  like_count integer not null default 0,
  comment_count integer not null default 0,
  repost_count integer,
  raw jsonb not null default '{}'::jsonb,
  posted_at timestamptz,
  pulled_at timestamptz not null default now(),
  unique (agent_instance_id, platform, external_id)
);
create index if not exists account_style_posts_account_idx
  on noelle.account_style_posts (agent_instance_id, account_handle, kind, posted_at desc);
create index if not exists account_style_posts_perf_idx
  on noelle.account_style_posts (agent_instance_id, kind, like_count desc);
grant select, insert, update, delete on noelle.account_style_posts to noelle_app;

-- C) the ultra profile (extracted voice/tone/structure + performance rollup)
create table if not exists noelle.account_ultra_profiles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references noelle.organizations(id) on delete cascade,
  agent_instance_id uuid not null references noelle.agent_instances(id) on delete cascade,
  platform text not null default 'linkedin',
  account_handle text not null,
  voice_summary text,
  tone text,
  structure_notes text,
  hook_patterns jsonb not null default '[]'::jsonb,
  signature_phrases jsonb not null default '[]'::jsonb,
  top_topics jsonb not null default '[]'::jsonb,
  avg_like_count numeric,
  avg_comment_count numeric,
  posts_analyzed integer not null default 0,
  sample_post_ids text[],
  model text,
  generated_at timestamptz,
  refreshed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agent_instance_id, platform, account_handle)
);
create index if not exists account_ultra_profiles_refresh_idx
  on noelle.account_ultra_profiles (agent_instance_id, refreshed_at);
grant select, insert, update, delete on noelle.account_ultra_profiles to noelle_app;

drop trigger if exists account_ultra_profiles_set_updated_at on noelle.account_ultra_profiles;
create trigger account_ultra_profiles_set_updated_at
  before update on noelle.account_ultra_profiles
  for each row execute function noelle.tg_set_updated_at();

-- D) feeder config + run tracking on the instance (NULL config = feeder OFF)
alter table noelle.agent_instances
  add column if not exists account_feeder_config jsonb,
  add column if not exists account_feeder_run_requested_at timestamptz,
  add column if not exists account_feeder_last_run_at timestamptz;
