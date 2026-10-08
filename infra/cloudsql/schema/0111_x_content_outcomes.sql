-- Nullable counts preserve the difference between unavailable and measured zero.
alter table noelle.own_post_metrics
  add column if not exists quotes bigint check (quotes >= 0),
  add column if not exists bookmarks bigint check (bookmarks >= 0);

create index if not exists own_post_metrics_instance_tweet_capture_idx
  on noelle.own_post_metrics (agent_instance_id, external_id, captured_at desc);
