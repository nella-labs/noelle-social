-- 0069_video_studio.sql
-- Nova studio (W4 generation) triggers on agent_instances. The studio's
-- "Generate ideas" / "weekly batch" action sets video_ideation_request (jsonb:
-- {mode:'single'|'batch', count, weekStart, requestedAt}); the ideator worker
-- reads it, generates video_ideas, then stamps video_ideation_last_run_at — the
-- same flag-flip pattern as the account feeder / harvester. Idea→draft uses the
-- existing video_ideas.status flow (approved → scripter claims), so no extra
-- queue is needed.

alter table noelle.agent_instances
  add column if not exists video_ideation_request jsonb,
  add column if not exists video_ideation_last_run_at timestamptz;
