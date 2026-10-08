-- 0073_video_self_tracking.sql
-- Nova self-tracking: let Nova watch the OPERATOR'S OWN account (e.g. the IG
-- handle they post from) 24/7, record each post's performance over time, and
-- attribute published posts back to the Nova draft they came from. This powers
-- the analytics/admin page (what I posted, what worked, which drafts I used) and
-- feeds an 'account' ultra-profile so ideation learns from the operator's real
-- content, not just the creators they watch. Nova is still DRAFT-ONLY.
--
-- Tenancy: every row carries (org_id, agent_instance_id); workers scope by
-- agent_instance_id and app code calls assertOrgMember before touching these.

-- A) Mark a watchlist source as the operator's OWN account. The harvester pulls
-- these on a schedule (not just on the manual flag) and upserts their posts as
-- source_kind='account' clips. Default false → existing rows stay watched creators.
alter table noelle.video_watchlist_sources
  add column if not exists is_own boolean not null default false;
-- Fast "the own-account sources for this instance" lookup the tracker runs each tick.
create index if not exists video_watchlist_sources_own_idx
  on noelle.video_watchlist_sources (agent_instance_id, is_own) where is_own;

-- B) Time-series of a clip's performance. video_clips holds only the LATEST
-- metrics (upsert refreshes them); this appends a row per pull so the analytics
-- page can show trend (views/likes growth, follower trend) over time. Kept lean:
-- the engagement counters + the author follower count at capture time.
create table if not exists noelle.video_clip_metrics (
  id                    uuid        primary key default gen_random_uuid(),
  org_id                uuid        not null references noelle.organizations(id) on delete cascade,
  agent_instance_id     uuid        not null references noelle.agent_instances(id) on delete cascade,
  clip_id               uuid        not null references noelle.video_clips(id) on delete cascade,
  captured_at           timestamptz not null default now(),
  views                 bigint      not null default 0,
  likes                 bigint      not null default 0,
  comments              bigint      not null default 0,
  shares                bigint      not null default 0,
  saves                 bigint      not null default 0,
  author_follower_count bigint                                       -- account follower count at capture time (follower trend)
);
-- One snapshot per clip per pull; the tracker reads the latest per clip and the
-- series for charts.
create index if not exists video_clip_metrics_clip_idx
  on noelle.video_clip_metrics (clip_id, captured_at desc);
create index if not exists video_clip_metrics_instance_idx
  on noelle.video_clip_metrics (agent_instance_id, captured_at desc);
grant select, insert, update, delete on noelle.video_clip_metrics to noelle_app;

-- C) Attribute a published post back to the Nova draft it came from. Nova never
-- posts (the operator records + posts by hand), so this is a nullable link the
-- operator confirms (or an auto-suggested match accepts): the own-account clip a
-- draft became. Lets the analytics page show "this post came from draft X".
alter table noelle.video_drafts
  add column if not exists published_clip_id uuid references noelle.video_clips(id) on delete set null;
create index if not exists video_drafts_published_clip_idx
  on noelle.video_drafts (published_clip_id) where published_clip_id is not null;
