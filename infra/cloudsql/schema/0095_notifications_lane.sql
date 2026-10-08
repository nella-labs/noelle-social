-- infra/cloudsql/schema/0095_notifications_lane.sql
-- Give replies-to-us their own lane.
--
-- The notifications actor files "somebody replied to us" as a lead and the
-- normal drafter picks it up. That conflated two different jobs. Answering
-- someone who replied to you is not the same activity as cold outbound, and the
-- operator could not run one without the other: the only switch was the
-- instance's status, so "answer my replies" also restarted discovery,
-- classification and cold drafting.
--
-- This adds `notifications_enabled`, following the `watchlist_enabled`
-- precedent from 0034: a lane that keeps working while the instance is PAUSED,
-- gated on its own flag. The operator can now pause the intern — killing cold
-- outbound entirely — and still have replies answered.
--
-- Default TRUE so existing installs behave as they do today: an ACTIVE instance
-- drafts notification leads exactly as before. The flag only becomes load-
-- bearing while paused.

alter table noelle.agent_instances
  add column if not exists notifications_enabled boolean not null default true;

comment on column noelle.agent_instances.notifications_enabled is
  'Answer people who replied to us. Runs while the instance is PAUSED (like watchlist_enabled), so cold outbound can be off while conversations continue.';

-- Claim notification leads ONLY.
--
-- The existing claims are lane-blind: claim_leads_for_drafting takes
-- priority=false rows and claim_watchlist_leads_for_drafting takes priority=true
-- rows, and a notification lead is priority=true — so a paused notifications-only
-- tick using the watchlist claim would also drag in every profile_search and
-- keyword lead. On LinkedIn essentially every lead is priority=true, so that is
-- the whole cold funnel. This claim keys on payload.source instead, which is the
-- only thing that actually identifies the lane.
--
-- Same freshness bound as the other notification paths (see
-- packages/runtime/src/notificationWindow.ts, NOTIFICATION_MAX_AGE_HOURS): a
-- reply we cannot answer promptly is not worth answering at all.

drop function if exists noelle.claim_notification_leads_for_drafting(uuid, integer);

create function noelle.claim_notification_leads_for_drafting(
  p_agent_instance_id uuid,
  p_cap               integer
)
returns table (
  id                uuid,
  external_id       text,
  payload           jsonb,
  author_handle     text,
  author_id         text,
  status            text,
  tier              text,
  classifier_label  text,
  classifier_score  numeric,
  priority          boolean
)
language plpgsql
as $$
begin
  return query
  with cand as (
    select l.id
      from noelle.leads l
     where l.agent_instance_id = p_agent_instance_id
       and l.status = 'classified'
       and coalesce(l.payload->>'source', '') = 'notification'
       -- Fail-open on an undateable stamp: the sweep only ever harvests recent
       -- cards, so a missing posted_at is a scraping gap, not an old reply.
       and (
         l.payload->>'posted_at' is null
         or l.payload->>'posted_at' !~ '^\d{4}-'
         or (l.payload->>'posted_at')::timestamptz >= now() - interval '9 hours'
       )
     order by l.created_at asc
     limit greatest(p_cap, 0)
     for update skip locked
  )
  update noelle.leads l
     set status = 'drafting',
         updated_at = now()
    from cand
   where l.id = cand.id
  returning
    l.id,
    l.external_id,
    l.payload,
    l.author_handle,
    l.author_id,
    l.status,
    l.tier,
    l.classifier_label,
    l.classifier_score,
    l.priority;
end;
$$;

grant execute on function noelle.claim_notification_leads_for_drafting(uuid, integer) to noelle_app;
