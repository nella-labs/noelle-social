-- Retire pending replies that were drafted BEFORE a drafting fix shipped, so
-- the fixed drafter rewrites them.
--
-- Parameterised, because it has now been needed twice and a second near-copy of
-- this file is how the two drift apart:
--
--   psql "$NOELLE_DATABASE_URL" \
--     -v platform=linkedin -v cutoff="2026-08-24 18:17:39+00" \
--     -f scripts/redraft-stale-queue.sql
--
--   psql "$NOELLE_DATABASE_URL" \
--     -v platform=x -v cutoff="2026-08-24 19:36:35+00" \
--     -f scripts/redraft-stale-queue.sql
--
-- `cutoff` is the deploy timestamp of the fix in question (`noelle deploy
-- status` prints it). Anything drafted at or before it was written under the old
-- rules; anything after already has them and is left alone.
--
-- Scope guards, in order of how much they matter:
--   - PENDING approvals only. A sent reply cannot be edited, a skipped one is
--     not going out.
--   - kind='reply' only. DMs are a different surface and were never in scope.
--   - NEVER a lead with an operator-edited draft. Their words win.
--
-- Mechanism: skip the stale approvals FIRST, then put the lead back to
-- 'classified'. Skipping first is what stops the redraft from landing a second
-- pending approval next to the old one, because drafts insert with a fresh uuid
-- and nothing dedupes them. Reversible: the skipped rows keep their skip_reason,
-- so `update noelle.approvals set status='pending' where skip_reason like
-- 'redraft:%'` puts them back.

\set ON_ERROR_STOP on

BEGIN;

-- Capture the exact old replies; companion DMs and newer replies stay intact.
CREATE TEMP TABLE affected_approvals ON COMMIT DROP AS
WITH edited AS (
  SELECT DISTINCT d.lead_id
  FROM noelle.approvals a JOIN noelle.drafts d ON d.id = a.draft_id
  WHERE a.status = 'pending' AND coalesce((d.payload->>'edited')::boolean, false)
)
SELECT a.id AS approval_id, d.id AS draft_id, l.id AS lead_id, l.platform
FROM noelle.approvals a
JOIN noelle.drafts d ON d.id = a.draft_id
JOIN noelle.leads  l ON l.id = d.lead_id
WHERE a.status = 'pending'
  AND d.payload->>'kind' = 'reply'
  AND l.platform = :'platform'
  AND d.synced_at <= :'cutoff'::timestamptz
  AND l.id NOT IN (SELECT lead_id FROM edited);

\echo '-- leads to redraft'
SELECT platform, count(DISTINCT lead_id) AS leads FROM affected_approvals GROUP BY 1 ORDER BY 1;

UPDATE noelle.approvals a
SET status      = 'skipped',
    skip_reason = 'redraft: written by the pre-fix drafter',
    decided_by  = 'backfill',
    decided_at  = now(),
    updated_at  = now()
FROM affected_approvals targets
WHERE a.id = targets.approval_id
  AND a.draft_id = targets.draft_id
  AND a.status = 'pending';

\echo '-- approvals retired (above)'

UPDATE noelle.leads
SET status = 'classified', updated_at = now()
WHERE id IN (SELECT lead_id FROM affected_approvals);

\echo '-- leads requeued (above)'

COMMIT;

\echo '-- pending replies left on this platform:'
SELECT count(*) AS still_pending
FROM noelle.approvals a JOIN noelle.drafts d ON d.id=a.draft_id JOIN noelle.leads l ON l.id=d.lead_id
WHERE a.status='pending' AND d.payload->>'kind'='reply' AND l.platform = :'platform';
