-- Reserve a thread before one browser submit. Unknown outcomes remain reserved.
create table if not exists noelle.reddit_reply_claims (
  org_id uuid not null references noelle.organizations(id) on delete cascade,
  post_id text not null check (post_id ~ '^[a-z0-9]+$'),
  agent_instance_id uuid not null,
  approval_id uuid not null,
  draft_id uuid not null,
  lead_id uuid not null,
  body_sha256 text not null check (body_sha256 ~ '^[a-f0-9]{64}$'),
  target_sha256 text not null check (target_sha256 ~ '^[a-f0-9]{64}$'),
  source_sha256 text not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  draft_sha256 text not null check (draft_sha256 ~ '^[a-f0-9]{64}$'),
  receipt_draft_sha256 text check (receipt_draft_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null default 'claimed' check (status in ('claimed', 'sent')),
  claimed_at timestamptz not null default now(),
  sent_at timestamptz,
  primary key (org_id, post_id)
);
create index if not exists reddit_reply_claims_approval_idx
  on noelle.reddit_reply_claims(org_id, approval_id);
create index if not exists reddit_reply_claims_usage_idx
  on noelle.reddit_reply_claims(org_id, claimed_at);
-- Default privileges from 0001 also grant DELETE; reservations cannot be released.
revoke delete on noelle.reddit_reply_claims from noelle_app;
grant select, insert, update on noelle.reddit_reply_claims to noelle_app;
