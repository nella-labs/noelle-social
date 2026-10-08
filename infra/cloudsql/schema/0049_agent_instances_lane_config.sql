-- infra/cloudsql/schema/0049_agent_instances_lane_config.sql
-- Per-lane enable/trigger state for the multi-lane agent.
--
-- Lyra splits into three independently triggerable lanes — Replies, DMs, Posts.
-- lane_config is the lane-level source of truth for on/off (the existing
-- per-worker *_enabled flags stay for fine-grained control and map under their
-- lane). Empty object = legacy behaviour: Replies on, DMs companion-only, Posts
-- off — so existing instances are unchanged until the operator opts in.
--
-- shape (validated by packages/contracts LaneConfigSchema):
--   {
--     "replies": { "enabled": true },
--     "dms":     { "enabled": false, "intro_dms_enabled": false },
--     "posts":   { "enabled": false }
--   }
alter table noelle.agent_instances
  add column if not exists lane_config jsonb not null default '{}'::jsonb;
