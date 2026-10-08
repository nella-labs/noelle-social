-- infra/cloudsql/schema/0081_reply_send_enabled.sql
-- Master "reply sending" switch per intern instance (Vega / Lyra). OFF by
-- default: replies are still drafted and queued for approval, but NOTHING posts
-- until the operator flips this on from the agent page in the dashboard.
--
-- It gates BOTH send paths:
--   - X (Vega): the send worker's onTick returns early when it is not true
--     (apps/x-intern/src/workers/send.ts), so neither the retry queue nor
--     auto-send claims fire.
--   - LinkedIn (Lyra): GET /api/actionable-linkedin returns an empty queue when
--     it is not true (apps/api-vm/src/routes/actuator.ts), so the browser
--     actuator has nothing to post.
--
-- Deliberately a NEW column, not a reuse: send_enabled defaults true and doubles
-- as the lock circuit-breaker, and auto_send_enabled only controls drafter
-- scheduling. `not null default false` backfills every EXISTING instance to OFF
-- at migration time and defaults new instances OFF, so no separate UPDATE is
-- needed and sending is fail-closed.

alter table noelle.agent_instances
  add column if not exists reply_send_enabled boolean not null default false;
