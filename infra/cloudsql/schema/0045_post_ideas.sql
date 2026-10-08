-- infra/cloudsql/schema/0045_post_ideas.sql
-- Posts lane, stage 1: idea cards.
--
-- Lyra's new Posts lane is two-stage and generate-on-demand. The ideation
-- worker researches what performs (watchlist engagement mining, net-new keyword
-- search, vault content pillars, top-performer playbooks) and proposes IDEAS —
-- a hook + thesis + the posts it's inspired by — WITHOUT writing a full draft.
-- The operator reviews an idea in the approvals inbox and only then clicks
-- "Generate", which flips status to 'approved' and lets the post-drafter worker
-- claim it. Nothing is ever auto-published.
--
-- Platform-generic on purpose (platform column, no linkedin_ prefix) so a
-- mirrored Posts lane can drop under Vega (X) later with no schema rework.
--
-- status flow:
--   proposed → approved → drafting → drafted → ready → published | dismissed
--   (proposed: ideation output; approved: operator clicked Generate;
--    drafting/drafted: post-drafter claimed/finished; ready: operator approved
--    the generated draft; published/dismissed: terminal)
create table if not exists noelle.post_ideas (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references noelle.organizations(id) on delete cascade,
  agent_instance_id  uuid not null references noelle.agent_instances(id) on delete cascade,
  platform           text not null default 'linkedin',
  -- The opening line / angle the idea hangs on (what the operator reads first).
  hook               text not null,
  -- 1-2 sentence summary of the point the post would make.
  thesis             text,
  -- contrarian | story | how_to | observation | ... (free text, model-chosen).
  angle              text,
  -- Which content pillar this serves (from the vault pillars).
  pillar             text,
  -- The posts/playbooks that inspired this idea — surfaced as "inspired by"
  -- links in the UI. Shape: [{ kind, lead_id?, url?, author?, note }].
  inspiration_refs   jsonb not null default '[]',
  -- Weekly-batch slot (Mon-Sun). NULL for single on-demand ideas.
  suggested_day      date,
  -- Groups the ~7 ideas produced by one weekly-batch run.
  batch_id           uuid,
  status             text not null default 'proposed',
  source_engine      text,
  model              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists post_ideas_instance_status_idx
  on noelle.post_ideas (agent_instance_id, status, created_at desc);

-- The post-drafter claims rows in 'approved' across instances; partial index
-- keeps that scan tight.
create index if not exists post_ideas_claimable_idx
  on noelle.post_ideas (status)
  where status = 'approved';

create index if not exists post_ideas_batch_idx
  on noelle.post_ideas (batch_id)
  where batch_id is not null;
