-- Definite rejections may release only their own target reservation.
-- Confirmed or uncertain dispatches retain claims without an expiry.
create or replace function noelle.release_x_reply_claim(
  p_org_id uuid,
  p_tweet_id text,
  p_approval_id uuid
)
returns boolean
language sql
security definer
set search_path = pg_catalog
as $$
  with released as (
    delete from noelle.x_reply_claims claim
    where claim.org_id = p_org_id and claim.tweet_id = p_tweet_id
      and claim.approval_id = p_approval_id
      and not exists (
        select 1 from noelle.approvals approval
        join noelle.drafts draft on draft.id = approval.draft_id and draft.org_id = p_org_id
        where approval.id = p_approval_id and approval.org_id = p_org_id
          and (draft.sent_external_id is not null or draft.sent_at is not null)
      )
      and not exists (
        select 1 from noelle.x_activity activity
        where activity.org_id = p_org_id and activity.tweet_id = p_tweet_id
          and activity.type in ('reply', 'skip')
      )
    returning 1
  )
  select exists (select 1 from released);
$$;

revoke delete on noelle.x_reply_claims from noelle_app;
revoke all on function noelle.release_x_reply_claim(uuid, text, uuid) from public;
grant execute on function noelle.release_x_reply_claim(uuid, text, uuid) to noelle_app;
