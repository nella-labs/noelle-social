-- Persistent dedup-by-link for the LinkedIn Actuator: never comment twice on the
-- same post. The extension's per-post guard (RunState.actionedUrls) is in-memory
-- and dies with the browser session, and the after-markSent sibling-skip only
-- fires once a send is confirmed and only within one lead. Neither survives a
-- browser restart, a failed markSent, or a second lead resolving to the same
-- post -- so the same post could still get a second comment.
--
-- The queue (/api/actionable-linkedin) now excludes any post already replied to,
-- keyed on the activity URN (urn:li:activity:<id>, where <id> = leads.external_id),
-- built two ways and unioned in the handler:
--   Source B (authoritative, covers ALL history with no backfill): every reply
--     approval already marked 'sent' -> its post's URN via the lead's external_id.
--   Source A (safety net): comment rows the extension stamps with activity_urn at
--     post time -- written independently of markSent, so a post that was commented
--     on but whose markSent never confirmed (approval still 'pending') is blocked.
--
-- This migration only adds the lookup index Source A needs. No backfill: Source B
-- derives every historically replied-to post from existing 'sent' approvals, so
-- the ~800+ posts already replied to are blocked the moment this ships. (Note the
-- historical linkedin_activity 'comment' rows have approval_id = null and no URN,
-- which is exactly why the dedup does NOT depend on them for history.)

-- Lookup index for Source A: org + urn, restricted to the exact rows the query
-- reads (comment rows carrying a URN). Partial => small + selective.
create index if not exists linkedin_activity_org_comment_urn
  on noelle.linkedin_activity (org_id, activity_urn)
  where type = 'comment' and activity_urn is not null;
