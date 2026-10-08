-- Reserve a LinkedIn post before the browser clicks Comment. A lost response
-- after the click must never put the post back in the actionable queue.
-- Claims are deliberately permanent, including when the send outcome is unknown.
create table if not exists noelle.linkedin_reply_claims (
  org_id       uuid not null references noelle.organizations(id) on delete cascade,
  activity_urn text not null check (activity_urn ~ '^urn:li:activity:[0-9]+$'),
  approval_id  uuid not null,
  status       text not null default 'claimed' check (status in ('claimed', 'sent')),
  claimed_at   timestamptz not null default now(),
  sent_at      timestamptz,
  primary key (org_id, activity_urn)
);

create index if not exists linkedin_reply_claims_approval_idx
  on noelle.linkedin_reply_claims (org_id, approval_id);

-- Prefer the saved post URL: notification leads use their COMMENT urn as
-- external_id, and some historical leads have an external_id for a different
-- activity. The numeric external_id remains a fallback for old URL-less rows.
create or replace function noelle.linkedin_post_activity_urn(
  p_payload jsonb,
  p_external_id text
)
returns text
language sql
immutable
as $$
  select 'urn:li:activity:' || coalesce(
    substring(coalesce(p_payload->>'postUrl', p_payload->>'original_post_url', p_payload->>'url')
      from 'activity[-:]([0-9]+)'),
    case when p_external_id ~ '^[0-9]+$' then p_external_id end
  )
$$;

grant select, insert, update on noelle.linkedin_reply_claims to noelle_app;
grant execute on function noelle.linkedin_post_activity_urn(jsonb, text) to noelle_app;
