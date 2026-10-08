-- Rename the `drafter-codex` spend bucket to the generic `drafter`.
--
-- Background: pre-2026-05-26 the X intern's primary engine was Codex
-- (gpt-5 via ChatGPT OAuth). The bucket name baked the engine into the
-- billing label, so the dashboard read "drafter-codex" everywhere. Codex
-- has now been removed as an engine (the X intern defaults to Bedrock
-- claude-sonnet-4-6, with Vertex sonnet as the fallback), and the bucket
-- name needs to follow: it's the *drafter's* bucket, not Codex's.
--
-- Apply BEFORE deploying the matching code change: the new
-- packages/contracts BucketSchema no longer accepts `drafter-codex`, so
-- any worker booting against the new code with old bucket rows will
-- start failing validation on insert. After this migration both
-- noelle.llm_calls and noelle.org_spend_month carry the renamed value.

begin;

-- Per-call rows (forward-going).
update noelle.llm_calls
   set bucket = 'drafter'
 where bucket = 'drafter-codex';

-- Monthly rollups (historical spend).
update noelle.org_spend_month
   set bucket = 'drafter'
 where bucket = 'drafter-codex';

-- agent_instances.* doesn't store a bucket name today (the bucket is
-- resolved from the agent type at call time), so no row updates are
-- needed there. If a future migration ever persists per-instance bucket
-- overrides, add the analogous UPDATE here.

commit;
