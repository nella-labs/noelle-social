-- infra/cloudsql/schema/0080_dismiss_onbrand_slop_drafts.sql
-- One-time cleanup: soft-dismiss the repetitive "On-brand post" slop drafts that
-- clog the Content → Drafts board.
--
-- Where they came from: the bulk Compose route (/api/content/slots/bulk) creates
-- one post_ideas row per planned slot, and when the operator gives no topic it
-- falls back to hook = 'On-brand post' (content-schedule.ts). The post-drafter
-- then fans each X idea into FRESH_VERSIONS.x = 3 draft versions and never
-- supersedes, so every such idea leaves a stack of near-identical 'On-brand post'
-- drafts behind. (The board's per-card Dismiss now drops the whole (idea,
-- platform) set — see the /api/posts/:id/dismiss scope:"set" fix — but the
-- backlog that already accumulated still needs clearing.)
--
-- What this preserves: the 12 good drafts pushed by the Claude content bridge
-- carry source_engine = 'claude-agent'; the `is distinct from 'claude-agent'`
-- guard keeps them (and anything already marked ready/published, via the
-- status = 'draft' guard) untouched. Only worker-generated (bedrock/codex/…/null
-- engine) 'On-brand post' drafts still sitting in 'draft' are dismissed.
--
-- Idempotent: once dismissed the rows no longer match status = 'draft', so a
-- re-run affects zero rows. Soft-delete only — nothing is physically removed, and
-- the owning ideas / schedule slots are left alone.

begin;

update noelle.post_drafts d
set status = 'dismissed',
    updated_at = now()
from noelle.post_ideas i
where d.idea_id = i.id
  and i.hook = 'On-brand post'
  and d.status = 'draft'
  and d.source_engine is distinct from 'claude-agent';

commit;
