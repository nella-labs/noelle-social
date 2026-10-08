-- Persistent dedup-by-thread for the Reddit Actuator: never reply twice in the
-- same thread. The Reddit sibling of 0084_linkedin_reply_dedup.sql. The
-- extension's per-thread guard (RunState.actionedKeys) is in-memory and dies
-- with the browser session -- it does not survive a browser restart, a failed
-- markSent, or a second lead resolving to the same thread, so the same thread
-- could still get a second comment (a classic subreddit-ban trigger).
--
-- The queue (/api/actionable-reddit) now excludes any thread already replied
-- to, keyed on the bare t3 post id (= leads.external_id, t3_ stripped; a
-- comment-target reply keys on its PARENT post's id, so the grain is the
-- thread), built two ways and unioned in the handler:
--   Source B (authoritative, covers ALL history with no backfill): every reply
--     approval already marked 'sent' -> its thread's id via the lead's
--     external_id.
--   Source A (safety net): reply rows the extension stamps with post_id at post
--     time -- written independently of markSent, so a thread that was replied
--     to but whose markSent never confirmed (approval still 'pending') is
--     blocked.
--
-- This migration only adds the lookup index Source A needs. No backfill:
-- Source B derives every historically replied-to thread from existing 'sent'
-- approvals. (Reply rows logged before the extension stamped post_id have
-- post_id = null and are exactly why the dedup does NOT depend on them for
-- history.)

-- Lookup index for Source A: org + post id, restricted to the exact rows the
-- query reads (reply rows carrying a post id). Partial => small + selective.
create index if not exists reddit_activity_org_reply_post
  on noelle.reddit_activity (organization_id, post_id)
  where type = 'reply' and post_id is not null;
