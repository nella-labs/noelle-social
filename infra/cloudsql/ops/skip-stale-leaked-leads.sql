-- One-off maintenance: re-skip leads that leaked past the 15-day recency cutoff.
--
-- Before the x-client date-recovery fix, a tweet Bird returned with no typed
-- `createdAt` was stamped `posted_at = now()` (fabricated). That fabricated
-- freshness let months-old tweets slip past BOTH discovery's `since` window and
-- the classifier's 15-day cutoff, so they reached the inbox / got drafted (e.g.
-- a 2026-02-24 tweet surfacing in June). The code fix stops NEW leaks; this
-- cleans the ones already in flight.
--
-- Strategy: an X tweet's real creation time is recoverable from its snowflake
-- id (`external_id`), independent of the corrupted `posted_at`. Find leads whose
-- real tweet time is > 15 days old yet still live in the pipeline, skip their
-- pending approvals, and flip the lead to `skipped` so the drafter won't
-- re-claim it. Idempotent and reversible (POST /api/drafts/:id/unskip).
--
-- X-only (numeric snowflake ids). Run inside the noelle DB:
--   nerdctl exec -i noelle-pg psql "$NOELLE_DATABASE_URL" -f skip-stale-leaked-leads.sql   (self-host)
--   cloud-sql-proxy … && psql … -f skip-stale-leaked-leads.sql                              (prod)

begin;

-- Snowflake epoch for X (Twitter): 2010-11-04 01:42:54.657 UTC = 1288834974657 ms.
create temporary table _stale_leaked on commit drop as
  select id
  from noelle.leads
  where external_id ~ '^[0-9]+$'
    and status in ('classified', 'drafting', 'drafted')
    and now() - to_timestamp(((external_id::bigint >> 22) + 1288834974657) / 1000.0)
        > interval '15 days';

\echo 'stale leaked leads to be re-skipped:'
select count(*) as stale_leaked_leads from _stale_leaked;

-- Skip every still-pending approval on those leads (reply angles AND the DM —
-- the whole lead is too old to action).
update noelle.approvals a
   set status      = 'skipped',
       decided_at  = now(),
       decided_by  = 'stale-recency-backfill',
       skip_reason = 'stale-recency-backfill'
 where a.lead_id in (select id from _stale_leaked)
   and a.status = 'pending';

-- Flip the leads themselves so the drafter (claims status='classified') and the
-- classifier never re-pick them.
update noelle.leads
   set status = 'skipped', updated_at = now()
 where id in (select id from _stale_leaked)
   and status <> 'skipped';

commit;
