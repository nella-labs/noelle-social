-- 0066_video_intern_corpus.sql
-- Nova's harvested corpus + the structured intelligence distilled from it:
--   video_clips         — one row per pulled reel (metrics + media pointers)
--   video_teardowns     — the per-clip structured teardown (hook/beats/transitions/…)
--   video_ultra_profiles — the distilled "Video Brand Guide" (per creator/niche/account)
--
-- This is the Account Feeder pattern upgraded for video (cf. 0051): the corpus is
-- video_clips (= account_style_posts), the ultra profile is the brand guide
-- (= account_ultra_profiles). pgvector embeddings are added in a later migration
-- (Phase 2), mirroring how account_style_posts got its embedding in 0052.
--
-- NOTE: count columns are bigint (a viral TikTok can exceed int range). bigint
-- comes back as a STRING in postgres.js — coerce Number() before arithmetic.

-- A) the harvested corpus
create table if not exists noelle.video_clips (
  id                    uuid        primary key default gen_random_uuid(),
  org_id                uuid        not null references noelle.organizations(id) on delete cascade,
  agent_instance_id     uuid        not null references noelle.agent_instances(id) on delete cascade,
  platform              text        not null default 'instagram',
  external_id           text        not null,                    -- platform video id / shortcode
  source_kind           text        not null default 'creator'   -- which lane pulled it
                                     check (source_kind in ('creator','niche','account')),
  author_handle         text        not null,                    -- lowercased, no @
  caption               text        not null default '',
  url                   text        not null default '',         -- canonical post URL
  video_url             text,                                    -- direct media URL (may expire) for the extractor
  thumb_url             text,
  views                 bigint      not null default 0,
  likes                 bigint      not null default 0,
  comments              bigint      not null default 0,
  shares                bigint      not null default 0,
  saves                 bigint      not null default 0,
  duration_s            numeric,
  music_id              text,
  music_name            text,
  author_follower_count bigint,                                  -- AT PULL TIME — denominator for the outperformer ratio
  deep_tier             boolean     not null default false,      -- flagged for the expensive cloud teardown pass
  raw                   jsonb       not null default '{}'::jsonb,
  posted_at             timestamptz,
  pulled_at             timestamptz not null default now(),
  unique (agent_instance_id, platform, external_id)
);
create index if not exists video_clips_author_idx
  on noelle.video_clips (agent_instance_id, author_handle, posted_at desc);
-- top-by-views ranking (the harvest filters + the Discover "most performing" view)
create index if not exists video_clips_views_idx
  on noelle.video_clips (agent_instance_id, views desc);
grant select, insert, update, delete on noelle.video_clips to noelle_app;

-- B) the per-clip structured teardown (Synthesist output, Auditor-verified)
create table if not exists noelle.video_teardowns (
  id                uuid        primary key default gen_random_uuid(),
  org_id            uuid        not null references noelle.organizations(id) on delete cascade,
  agent_instance_id uuid        not null references noelle.agent_instances(id) on delete cascade,
  clip_id           uuid        not null references noelle.video_clips(id) on delete cascade,
  platform          text        not null default 'instagram',
  teardown          jsonb       not null default '{}'::jsonb,    -- the VideoTeardown shape (hook/beats/transitions/onscreen/pacing/cta/sound/whyItWorked)
  transcript        text,                                        -- full timestamped transcript (faster-whisper)
  tier              text        not null default 'bulk'          -- which analysis tier produced it
                                check (tier in ('bulk','deep')),
  model             text,
  generated_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (clip_id)
);
create index if not exists video_teardowns_instance_idx
  on noelle.video_teardowns (agent_instance_id, created_at desc);
grant select, insert, update, delete on noelle.video_teardowns to noelle_app;

drop trigger if exists video_teardowns_set_updated_at on noelle.video_teardowns;
create trigger video_teardowns_set_updated_at
  before update on noelle.video_teardowns
  for each row execute function noelle.tg_set_updated_at();

-- C) the distilled Video Brand Guide (per creator / niche / "my account")
create table if not exists noelle.video_ultra_profiles (
  id                uuid        primary key default gen_random_uuid(),
  org_id            uuid        not null references noelle.organizations(id) on delete cascade,
  agent_instance_id uuid        not null references noelle.agent_instances(id) on delete cascade,
  platform          text        not null default 'instagram',
  scope             text        not null                         -- what this profile aggregates
                                check (scope in ('creator','niche','account')),
  subject           text        not null,                        -- creator handle, niche query, or 'me' for the operator's account
  profile           jsonb       not null default '{}'::jsonb,    -- the VideoUltraProfile distillation (hook library/transition vocab/pacing/templates/sound)
  avg_views         numeric,
  avg_likes         numeric,
  avg_comments      numeric,
  clips_analyzed    integer     not null default 0,
  sample_clip_ids   text[],
  model             text,
  generated_at      timestamptz,
  refreshed_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (agent_instance_id, platform, scope, subject)
);
create index if not exists video_ultra_profiles_refresh_idx
  on noelle.video_ultra_profiles (agent_instance_id, refreshed_at);
grant select, insert, update, delete on noelle.video_ultra_profiles to noelle_app;

drop trigger if exists video_ultra_profiles_set_updated_at on noelle.video_ultra_profiles;
create trigger video_ultra_profiles_set_updated_at
  before update on noelle.video_ultra_profiles
  for each row execute function noelle.tg_set_updated_at();
