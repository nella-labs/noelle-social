-- Per-instance soft pause: when the count of pending approvals for an
-- agent instance reaches this value, the drafter and discovery workers
-- skip their tick instead of generating more work. The user clears the
-- backlog (sends/skips drafts) and the workers automatically resume on
-- the next tick.
--
-- Motivation: at the demo cadence Vega can fill the approval inbox with
-- 100+ drafts in a few hours. Once the queue is that deep the founder
-- starts ignoring it; the right answer is to stop drafting until they've
-- caught up, not to pile on more.
--
-- See:
--   apps/x-intern/src/workers/drafter.ts        (gate at claim time)
--   apps/x-intern/src/workers/discovery.ts      (gate at sweep time)
--   apps/app/src/app/app/[orgSlug]/agents/[instanceId]/config/page.tsx
--
-- NULL = no cap (current behaviour, default).

alter table noelle.agent_instances
  add column if not exists pending_drafts_cap integer
    check (pending_drafts_cap is null or pending_drafts_cap > 0);

comment on column noelle.agent_instances.pending_drafts_cap is
  'Soft pause threshold: when pending approvals for this instance reach this value, drafter+discovery skip their tick. NULL disables the cap.';
