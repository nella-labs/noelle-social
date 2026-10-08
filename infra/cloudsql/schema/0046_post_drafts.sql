-- infra/cloudsql/schema/0046_post_drafts.sql
-- Posts lane, stage 2: the generated post.
--
-- When the operator clicks "Generate" on an idea, the post-drafter worker
-- writes the full post here (grounded in the operator's vault voice, the
-- inspiration posts, top-performer hook patterns, and any pinned drafter
-- rules), runs the existing verifier, and leaves it as 'draft'. The operator
-- reviews it in Approvals → Posts → Drafts (inline edit + the drafter chat),
-- then Mark ready / Copy out / Dismiss. NEVER auto-published.
--
-- Deliberately a DEDICATED table, not an overload of noelle.drafts: a post has
-- a different lifecycle (idea → draft → ready) with no lead/approval coupling,
-- and one idea may be regenerated several times via the chat. Keeping it
-- separate avoids polluting the reply/DM approval queue.
create table if not exists noelle.post_drafts (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references noelle.organizations(id) on delete cascade,
  agent_instance_id  uuid not null references noelle.agent_instances(id) on delete cascade,
  idea_id            uuid not null references noelle.post_ideas(id) on delete cascade,
  platform           text not null default 'linkedin',
  -- The generated post. final_body holds the operator's inline edit (null until
  -- edited), mirroring noelle.drafts.body / final_body.
  body               text not null,
  final_body         text,
  char_count         integer,
  source_engine      text,
  model              text,
  -- Verifier verdict (voice/grounding/format), same shape as the reply drafter.
  quality_score      numeric(5,4),
  quality_passed     boolean,
  verifier_meta      jsonb,
  -- draft → ready → published | dismissed.
  status             text not null default 'draft',
  marked_ready_at    timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists post_drafts_instance_status_idx
  on noelle.post_drafts (agent_instance_id, status, created_at desc);

create index if not exists post_drafts_idea_idx
  on noelle.post_drafts (idea_id, created_at desc);
