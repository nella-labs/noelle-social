-- infra/cloudsql/schema/0032_discovery_config.sql
-- Tailored discovery: per-instance knobs that shape WHICH posts discovery pulls
-- (time window, posts-per-source, min-engagement, post-type filters).
--
--  - discovery_config: the saved DEFAULT, edited on the Configure-agent page.
--    Applies to every discovery tick unless a run override is in effect.
--  - run_config: the ACTIVE per-run override, stamped by "Start all" (Tailor
--    this run). Merged over discovery_config field-by-field for the duration of
--    the run; cleared on Stop all and on goal auto-pause so the next manual run
--    starts from the default again.
--
-- Shape (all keys optional; absence = no filter / worker default), validated
-- against DiscoveryConfigSchema in packages/contracts:
--   { "timeWindowHours": 24, "postsPerSource": 20,
--     "minFaves": null, "minReplies": null,
--     "excludeRetweets": false, "excludeReplies": false, "lang": null }
--
-- Engagement (minFaves/minReplies) and post-type filters apply to KEYWORD
-- discovery only — they ride X's native search operators. Time window +
-- posts-per-source apply to handle polling too. See discovery-tick.ts.

alter table noelle.agent_instances
  add column if not exists discovery_config jsonb not null default '{}'::jsonb,
  add column if not exists run_config       jsonb;
