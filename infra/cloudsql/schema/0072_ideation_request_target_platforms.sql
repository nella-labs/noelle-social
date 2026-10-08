-- infra/cloudsql/schema/0072_ideation_request_target_platforms.sql
-- Per-request fan-out scope for an ideation run.
--
-- Each Content lane now owns its own ideation engine: the X lane routes to Vega
-- (x_intern), the LinkedIn lane to Lyra (linkedin_intern), and the cross-platform
-- "All" lane to Lyra with a linkedin+x fan-out. The owning intern is resolved from
-- the request's agent_instance_id, but the worker also needs to know which
-- platforms the produced ideas should TARGET (so a lane-scoped run makes
-- single-platform ideas instead of always fanning out to both).
--
-- target_platforms carries that scope, set by /api/posts/ideate from the lane:
--   X lane        -> {x}
--   LinkedIn lane -> {linkedin}
--   All           -> {linkedin, x}
--
-- Additive + nullable: a NULL value means "the worker's default" — each intern's
-- ideation worker falls back to [its own platform], so pre-existing pending rows
-- and the existing claim/finish loop are unaffected.
alter table noelle.ideation_requests
  add column if not exists target_platforms text[];

comment on column noelle.ideation_requests.target_platforms is
  'Platforms the produced ideas fan out into (e.g. {x} or {linkedin,x}). Set by /api/posts/ideate from the triggering lane. NULL = the worker default ([own platform]).';
