-- 0067_video_intern_studio.sql
-- Nova's studio output: video ideas + the generated drafts (structure + script +
-- asset suggestions). Mirrors the Posts lane (0045 post_ideas / 0046 post_drafts)
-- but the unit is a SHORT-FORM VIDEO: an idea fans out to a draft carrying a timed
-- structure, a script, and asset suggestions (transitions/sounds/graph specs).
--
-- Nova is DRAFT-ONLY: the operator records + posts every video by hand. Status
-- flow matches the posts lane so the studio can reuse the content-workspace shell.

-- A) video ideas (the Ideas board)
create table if not exists noelle.video_ideas (
  id                   uuid        primary key default gen_random_uuid(),
  org_id               uuid        not null references noelle.organizations(id) on delete cascade,
  agent_instance_id    uuid        not null references noelle.agent_instances(id) on delete cascade,
  platform             text        not null default 'instagram',
  hook                 text        not null,                     -- the scroll-stopping opening line
  concept              text,                                     -- 1-2 sentence concept
  angle                text,
  pillar               text,
  inspiration_clip_ids text[]      not null default '{}',        -- video_clips.id values this idea is grounded on
  suggested_day        date,                                     -- weekly-calendar Mon-Sun slot; null for singles
  batch_id             uuid,                                     -- groups a weekly batch
  status               text        not null default 'proposed',  -- proposed→approved→drafting→drafted→ready→published|dismissed
  source_engine        text,
  model                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists video_ideas_instance_status_idx
  on noelle.video_ideas (agent_instance_id, status, created_at desc);
create index if not exists video_ideas_claimable_idx
  on noelle.video_ideas (status) where status = 'approved';
create index if not exists video_ideas_batch_idx
  on noelle.video_ideas (batch_id) where batch_id is not null;
grant select, insert, update, delete on noelle.video_ideas to noelle_app;

drop trigger if exists video_ideas_set_updated_at on noelle.video_ideas;
create trigger video_ideas_set_updated_at
  before update on noelle.video_ideas
  for each row execute function noelle.tg_set_updated_at();

-- B) generated drafts (the Build panel): structure + script + asset suggestions
create table if not exists noelle.video_drafts (
  id                uuid        primary key default gen_random_uuid(),
  org_id            uuid        not null references noelle.organizations(id) on delete cascade,
  agent_instance_id uuid        not null references noelle.agent_instances(id) on delete cascade,
  idea_id           uuid        not null references noelle.video_ideas(id) on delete cascade,
  platform          text        not null default 'instagram',
  structure         jsonb       not null default '[]'::jsonb,    -- timed beats [{tStart,tEnd,purpose,line}]
  script            text        not null default '',             -- the script body (hook -> beats -> CTA)
  final_script      text,                                        -- operator's inline edit (null until edited)
  transitions       jsonb       not null default '[]'::jsonb,    -- suggested transitions
  sounds            jsonb       not null default '[]'::jsonb,    -- suggested sounds/music
  graph_specs       jsonb       not null default '[]'::jsonb,    -- Remotion overlay/graph asset specs (Phase 4 populates)
  source_engine     text,
  model             text,
  quality_score     numeric(5,4),
  quality_passed    boolean,
  verifier_meta     jsonb,                                       -- Critic verdict (hook/on-brand/structure/cta scores + attempts)
  status            text        not null default 'draft',        -- draft→ready→published|dismissed
  marked_ready_at   timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists video_drafts_instance_status_idx
  on noelle.video_drafts (agent_instance_id, status, created_at desc);
create index if not exists video_drafts_idea_idx
  on noelle.video_drafts (idea_id, created_at desc);
grant select, insert, update, delete on noelle.video_drafts to noelle_app;

drop trigger if exists video_drafts_set_updated_at on noelle.video_drafts;
create trigger video_drafts_set_updated_at
  before update on noelle.video_drafts
  for each row execute function noelle.tg_set_updated_at();
