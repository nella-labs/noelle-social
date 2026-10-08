-- Persistent dedup-by-link for the X Actuator: never reply twice to the same
-- tweet (mirrors 0084_linkedin_reply_dedup.sql). The extension's per-tweet
-- guard (RunState.actionedUrls) is in-memory and dies with the browser session;
-- a failed markSent leaves the approval 'pending' and re-served; and a second
-- lead can resolve to the same tweet -- so the same tweet could still get a
-- second reply, a prime X spam signal (docs/x-account-safety.md).
--
-- The queue (/api/actionable-x) now excludes any tweet already -- or possibly
-- already -- replied to, keyed on the tweet's numeric status id
-- (= leads.external_id), built two ways and unioned in the handler
-- (fetchXRepliedTweetIds in apps/api-vm/src/routes/actuator.ts):
--   Source B (authoritative, covers ALL history with no backfill): every reply
--     approval already marked 'sent' -> its tweet's id via the lead's external_id.
--   Source A (safety net): x_activity rows the extension stamps with tweet_id
--     at post time -- written independently of markSent:
--       type='reply' -> the reply CONFIRMED landing but markSent may never
--         have confirmed (approval still 'pending').
--       type='skip' with tweet_id -> an AMBIGUOUS submit: a submit gesture was
--         dispatched but landing was never confirmed (reason
--         'reply-failed:*:ambiguous-dropped'), so the draft was dropped
--         without markSent. The post may have landed; fail closed and block
--         the tweet so the pending approval is never re-served and re-posted.
--         These are the ONLY skip rows carrying a tweet_id, and the stamp is
--         deliberately a permanent reply-block (operator reconciles the
--         pending approval by hand).
--
-- This migration only adds the lookup index Source A needs. No backfill:
-- Source B derives every historically replied-to tweet from existing 'sent'
-- approvals. (Historical x_activity 'reply'/'skip' rows carried neither
-- approval_id nor tweet_id -- the extension only stamps them from this change
-- on -- which is exactly why the dedup does NOT depend on them for history.)

-- Lookup index for Source A: org + tweet id, restricted to the exact rows the
-- query reads (reply rows + ambiguous-dropped skip rows carrying a tweet id).
-- 'like' rows also carry tweet_id but are excluded: liked != replied.
-- Partial => small + selective.
create index if not exists x_activity_org_reply_tweet
  on noelle.x_activity (org_id, tweet_id)
  where type in ('reply', 'skip') and tweet_id is not null;
