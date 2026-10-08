-- Second backpressure knob, complementing 0012_pending_drafts_cap.sql.
--
-- The drafts-cap stops the workers when the *approval queue* is full.
-- But discovery can also fill the lead pipeline faster than classifier
-- and drafter drain it, even when approvals haven't piled up yet (e.g.
-- the founder is reviewing fast but classifier is throttled). This
-- second cap puts a ceiling on the lead backlog itself:
--
--   count(leads where status in ('new','classifying','classified','drafting'))
--     >= lead_backlog_cap   ⇒  discovery skips its tick
--
-- Only discovery consults this cap. Classifier and drafter keep draining
-- the existing backlog — that's the whole point of capping discovery.
--
-- NULL = no cap (current behaviour, default).

alter table noelle.agent_instances
  add column if not exists lead_backlog_cap integer
    check (lead_backlog_cap is null or lead_backlog_cap > 0);

comment on column noelle.agent_instances.lead_backlog_cap is
  'Soft pause threshold for discovery: when undrafted leads for this instance reach this value, discovery skips its tick. NULL disables the cap.';
