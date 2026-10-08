-- 0057_content_media.sql
-- Cross-platform media library for the Content workspace: images/video uploaded
-- by the operator and (optionally) attached to a post idea/draft. The bytes
-- live in object storage (per-org GCS prefix in prod; a local dir served by the
-- api-vm on self-host) — `storage_key` is the storage-agnostic handle, `url` the
-- resolved fetch URL. Org-scoped; platform is nullable (an asset can be shared
-- across LinkedIn/X/Reddit).
create table if not exists noelle.content_media (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references noelle.organizations(id) on delete cascade,
  agent_instance_id  uuid references noelle.agent_instances(id) on delete set null,
  platform           text,                       -- null = cross-platform asset
  kind               text not null default 'image', -- image | video | other
  mime_type          text,
  storage_key        text not null,              -- e.g. <orgSlug>/media/<uuid>.<ext>
  url                text,                       -- resolved fetch URL (null until ready)
  width              integer,
  height             integer,
  duration_ms        integer,
  bytes              bigint,
  -- Optional links to the post this asset belongs to.
  idea_id            uuid references noelle.post_ideas(id) on delete set null,
  draft_id           uuid references noelle.post_drafts(id) on delete set null,
  caption            text,
  status             text not null default 'ready', -- uploading | ready | failed
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- One storage_key maps to exactly one row.
create unique index if not exists content_media_storage_key_idx
  on noelle.content_media (storage_key);

create index if not exists content_media_org_idx
  on noelle.content_media (org_id, created_at desc);
create index if not exists content_media_idea_idx
  on noelle.content_media (idea_id) where idea_id is not null;
create index if not exists content_media_draft_idx
  on noelle.content_media (draft_id) where draft_id is not null;
