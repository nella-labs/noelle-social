-- infra/cloudsql/schema/0047_drafter_notes.sql
-- Drafter chat transcripts + pinned standing rules.
--
-- The Posts lane has a mini chat attached to each idea/draft: the operator
-- gives framing, a personal anecdote, things to avoid → the post is
-- regenerated. Each turn (operator + agent) is stored here scope='post',
-- idea_id set. Any operator turn can be PINNED (pinned=true, scope='standing')
-- to become a standing rule injected into every future post draft's gather
-- step — so the operator teaches the drafter once and it sticks.
--
-- lane defaults to 'posts' but is kept generic so reply/DM drafters can grow
-- their own standing rules later.
create table if not exists noelle.drafter_notes (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references noelle.organizations(id) on delete cascade,
  agent_instance_id  uuid not null references noelle.agent_instances(id) on delete cascade,
  -- 'post'     : a chat turn attached to one idea (idea_id set).
  -- 'standing' : a pinned rule applied to all future drafts in this lane.
  scope              text not null,
  lane               text not null default 'posts',
  idea_id            uuid references noelle.post_ideas(id) on delete cascade,
  -- 'operator' | 'agent'
  role               text not null,
  body               text not null,
  pinned             boolean not null default false,
  created_at         timestamptz not null default now()
);

-- Per-idea chat history (render the thread in order).
create index if not exists drafter_notes_idea_idx
  on noelle.drafter_notes (idea_id, created_at)
  where idea_id is not null;

-- Standing rules pulled per instance+lane on every post-drafter gather.
create index if not exists drafter_notes_standing_idx
  on noelle.drafter_notes (agent_instance_id, lane)
  where scope = 'standing' and pinned = true;
