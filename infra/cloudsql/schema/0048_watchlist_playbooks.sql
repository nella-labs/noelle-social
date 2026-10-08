-- infra/cloudsql/schema/0048_watchlist_playbooks.sql
-- Engagement Analyst output: per-author "how they win" playbooks.
--
-- The Intelligence box gains a third component (alongside watchlist + profiler):
-- the Engagement Analyst. It ranks the watchlist people by the REAL engagement
-- already captured on their posts (each LinkedIn lead's payload.reactions /
-- payload.comments in noelle.leads) and distills the top performers into a
-- reusable playbook — the hook patterns, post structure, length, cadence and
-- topics that over-perform for that person. This is the operator's "analyze the
-- most-performing people and see how they work."
--
-- It runs as a second pass inside the profiler worker (which already deep-reads
-- each person's post history, so it has the raw material) and feeds the Posts
-- ideation worker (top-performer teardown source) and the post-drafter (hook
-- patterns). Refreshed in place per (agent_instance_id, author).
create table if not exists noelle.watchlist_playbooks (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references noelle.organizations(id) on delete cascade,
  agent_instance_id      uuid not null references noelle.agent_instances(id) on delete cascade,
  -- Identify the author. fsd_profile_id is the stable urn (when known);
  -- author_handle is the public slug, always present.
  fsd_profile_id         text,
  author_handle          text not null,
  -- Distilled signals. hook_patterns/top_topics are string[] in jsonb.
  hook_patterns          jsonb not null default '[]',
  structure_notes        text,
  cadence_notes          text,
  top_topics             jsonb not null default '[]',
  -- Where this author ranks among the watchlist (0-1; 1 = top performer).
  engagement_percentile  numeric,
  -- The leads.external_id values the playbook was distilled from (provenance).
  sample_post_ids        text[],
  model                  text,
  generated_at           timestamptz not null default now(),
  unique (agent_instance_id, author_handle)
);

create index if not exists watchlist_playbooks_rank_idx
  on noelle.watchlist_playbooks (agent_instance_id, engagement_percentile desc);
