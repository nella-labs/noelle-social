-- 0079_x_self_tracking.sql
--
-- The LEARN half of the content loop for Vega (X) — the one intern that
-- actually publishes (via the official X API, 0075-0077). Ideas → drafts →
-- publish already exist; this closes the loop by measuring the operator's OWN
-- published posts and feeding that performance back into ideation.
--
-- Two pieces:
--   1. content_schedule_slots.posted_tweet_id — the returned tweet id, so a
--      published post can be re-fetched for engagement. Today the publish tick
--      stores only posted_url (the id is parseable from it, but a real column is
--      cleaner and index-friendly). Draft-only agents (Lyra/Orion) never
--      publish, so they never populate it.
--   2. noelle.own_post_metrics — a time-series of engagement snapshots on the
--      operator's own posts, attributed back to the slot + idea that produced
--      them. One row per (tweet, capture). Mirrors video_clip_metrics (0073):
--      append-only, latest-per-tweet is `distinct on (external_id) order by
--      captured_at desc`. The x-self-track sweep writes it; the X ideation
--      worker reads a pillar/angle rollup to bias which new ideas get proposed.
--
-- Tenancy: app code enforces org membership (no RLS in Cloud SQL). Grants are
-- inherited from the schema-level ALTER DEFAULT PRIVILEGES in 0001. Hand-applied
-- migration, no ledger.

alter table noelle.content_schedule_slots
  add column if not exists posted_tweet_id text;

create table if not exists noelle.own_post_metrics (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references noelle.organizations(id) on delete cascade,
  agent_instance_id     uuid not null references noelle.agent_instances(id) on delete cascade,
  platform              text not null default 'x',
  -- The published post's native id (X tweet id). Not a FK — the post lives on X.
  external_id           text not null,
  -- Soft refs (no FK): metrics outlive slot/idea churn, and the attribution is a
  -- convenience for the rollup, never a hard dependency.
  slot_id               uuid,   -- noelle.content_schedule_slots(id)
  idea_id               uuid,   -- noelle.post_ideas(id) — carries pillar/angle
  captured_at           timestamptz not null default now(),
  -- Engagement counts. views/bookmarks are null on the Apify read path (only the
  -- official X API exposes impressions); null = unknown, never zero-by-default.
  likes                 bigint not null default 0,
  reposts               bigint not null default 0,
  replies               bigint not null default 0,
  views                 bigint,
  author_follower_count bigint
);

-- Latest snapshot per tweet (the rollup read), and per-instance recent scans.
create index if not exists own_post_metrics_external_idx
  on noelle.own_post_metrics (external_id, captured_at desc);
create index if not exists own_post_metrics_instance_idx
  on noelle.own_post_metrics (agent_instance_id, captured_at desc);
create index if not exists own_post_metrics_idea_idx
  on noelle.own_post_metrics (idea_id)
  where idea_id is not null;
