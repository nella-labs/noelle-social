-- infra/cloudsql/schema/0031_leads_comment_bait.sql
-- Engagement-bait flag for reaction-based Opus tiering (LinkedIn intern, Lyra).
--
-- Lyra drafts a STRONGER comment (Opus) for leads whose source post is
-- high-engagement, because a great comment on a high-eyeball post earns
-- reciprocal engagement (the operator's growth strategy). The decision uses
-- engagement data Apify already fetched (no extra LinkedIn calls):
--
--   useOpus = likes > LINKEDIN_OPUS_LIKES
--          || (comments > LINKEDIN_OPUS_COMMENTS && !comment_bait)
--
-- The comments trigger is only trustworthy when the comments are GENUINE
-- discussion. An engagement-bait post farms low-value comments via a CTA
-- ("comment WORD below", "drop a LINK", "type X to get Y", giveaway-for-comment)
-- and inflates its comment count without any real discussion — so when a post is
-- comment-bait we IGNORE the comment count (the likes trigger still applies).
--
-- The classifier (which already reads the post text) sets this flag. Default
-- false so every existing lead — and every fail-open verdict — is treated as
-- genuine (the conservative choice: a real discussion never gets demoted).

alter table noelle.leads
  add column if not exists comment_bait boolean not null default false;

-- Re-define claim_leads_for_drafting to surface `comment_bait` so the drafter
-- can read it (alongside payload.reactions/payload.comments) and pick Opus for a
-- high-engagement lead. CREATE OR REPLACE cannot change a function's OUT columns
-- / return type, so we DROP then CREATE. (Prior definition: 0018_x_watchlist_people.sql.)
drop function if exists noelle.claim_leads_for_drafting(uuid, integer);
create function noelle.claim_leads_for_drafting(
  p_agent_instance_id uuid,
  p_batch             integer
)
returns table (
  id                uuid,
  external_id       text,
  payload           jsonb,
  author_handle     text,
  author_id         text,
  tier              text,
  classifier_label  text,
  classifier_score  numeric,
  status            text,
  priority          boolean,
  comment_bait      boolean
)
language sql
as $$
  update noelle.leads
  set status = 'drafting', updated_at = now()
  where id in (
    select id from noelle.leads
    where agent_instance_id = p_agent_instance_id
      and status = 'classified'
    order by created_at asc
    for update skip locked
    limit p_batch
  )
  returning id, external_id, payload, author_handle, author_id, tier,
            classifier_label, classifier_score, status, priority, comment_bait;
$$;

grant execute on function noelle.claim_leads_for_drafting(uuid, integer)
  to noelle_app;
