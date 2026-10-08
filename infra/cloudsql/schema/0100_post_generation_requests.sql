-- infra/cloudsql/schema/0100_post_generation_requests.sql
-- Durable operator-triggered post generation requests for MCP/chat workflows.
--
-- A request row lets noelle_get_post(requestId) show the exact worker-created
-- drafts for that request later, without confusing old drafts or later versions
-- for the result. The current request id is mirrored on post_ideas so the
-- post-drafter can stamp generated post_drafts without an extra lookup.

create table if not exists noelle.post_generation_requests (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references noelle.organizations(id) on delete cascade,
  agent_instance_id  uuid not null references noelle.agent_instances(id) on delete cascade,
  idea_id            uuid not null references noelle.post_ideas(id) on delete cascade,
  platforms          text[] not null,
  guidance           text,
  review_required    boolean not null default true,
  source             text not null default 'mcp',
  status             text not null default 'queued',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  completed_at       timestamptz
);

create index if not exists post_generation_requests_idea_idx
  on noelle.post_generation_requests (idea_id, created_at desc);

create index if not exists post_generation_requests_status_idx
  on noelle.post_generation_requests (agent_instance_id, status, created_at desc)
  where status in ('queued', 'drafting', 'review_pending');

alter table noelle.post_ideas
  add column if not exists generation_request_id uuid references noelle.post_generation_requests(id) on delete set null,
  add column if not exists generation_review_required boolean not null default false;

alter table noelle.post_drafts
  add column if not exists generation_request_id uuid references noelle.post_generation_requests(id) on delete set null;

create index if not exists post_drafts_generation_request_idx
  on noelle.post_drafts (generation_request_id, platform, created_at desc)
  where generation_request_id is not null;

-- 0001's default privileges only apply when future tables are created by the
-- same role. Grant this table explicitly so local MCP/API roles can create and
-- poll durable generation requests on clean installs.
grant select, insert, update, delete on noelle.post_generation_requests to noelle_app;
