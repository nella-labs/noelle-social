-- 0065_video_intern_watchlist.sql
-- Nova (video_intern) watchlist: the creators + niche lanes the harvester pulls
-- from, plus the feeder config/run flags on the instance.
--
-- Like the Reddit watchlist (and UNLIKE the X/LinkedIn people-watchlists), a
-- watchlisted creator/niche is a discovery SOURCE, not a priority bypass — every
-- harvested clip is filtered (top-by-views, outperformers, niche-trending) and
-- analysed; nothing is auto-drafted. Nova is DRAFT-ONLY (never posts to IG/TikTok).
--
-- Tenancy: every row carries (org_id, agent_instance_id); workers scope reads by
-- agent_instance_id and app code calls assertOrgMember before touching these.

-- A) curated creators to learn from
create table if not exists noelle.video_watchlist_sources (
  id                uuid        primary key default gen_random_uuid(),
  org_id            uuid        not null references noelle.organizations(id) on delete cascade,
  agent_instance_id uuid        not null references noelle.agent_instances(id) on delete cascade,
  platform          text        not null default 'instagram',   -- 'instagram' | 'tiktok'
  handle            text        not null,                        -- creator handle, lowercased, no leading @
  display_name      text,
  note              text,                                        -- "why we watch this creator"
  enabled           boolean     not null default true,
  follower_count    bigint,                                      -- snapshot at last pull (bigint -> string in postgres.js; coerce Number())
  last_pulled_at    timestamptz,
  created_at        timestamptz not null default now(),
  unique (agent_instance_id, platform, handle)
);
create index if not exists video_watchlist_sources_instance_idx
  on noelle.video_watchlist_sources (agent_instance_id, enabled);
grant select, insert, update, delete on noelle.video_watchlist_sources to noelle_app;

-- B) niche lanes ("newest videos that perform best in a niche")
create table if not exists noelle.video_watchlist_niches (
  id                uuid        primary key default gen_random_uuid(),
  org_id            uuid        not null references noelle.organizations(id) on delete cascade,
  agent_instance_id uuid        not null references noelle.agent_instances(id) on delete cascade,
  platform          text        not null default 'instagram',
  query             text        not null,                        -- keyword or hashtag, WITHOUT the leading #
  note              text,
  enabled           boolean     not null default true,
  last_pulled_at    timestamptz,
  created_at        timestamptz not null default now(),
  unique (agent_instance_id, platform, query)
);
create index if not exists video_watchlist_niches_instance_idx
  on noelle.video_watchlist_niches (agent_instance_id, enabled);
grant select, insert, update, delete on noelle.video_watchlist_niches to noelle_app;

-- C) feeder config + run tracking on the instance (NULL config = Nova feeder OFF).
-- Shape validated by VideoFeederConfigSchema in @noelle/contracts. The manual
-- "harvest now" is a flag flip on video_feeder_run_requested_at (like the
-- account feeder), so v1 needs no JWT api-vm route.
alter table noelle.agent_instances
  add column if not exists video_feeder_config jsonb,
  add column if not exists video_feeder_run_requested_at timestamptz,
  add column if not exists video_feeder_last_run_at timestamptz;
