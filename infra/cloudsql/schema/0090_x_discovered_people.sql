-- infra/cloudsql/schema/0090_x_discovered_people.sql
-- Person-first discovery for the X intern (Vega) — the analogue of
-- 0044_linkedin_discovered_people.
--
-- Vega's lead model was entirely POST-first: the keyword lane found tweets,
-- turned the good ones into leads, and threw the author away. A person who
-- clearly matches the ICP but whose current tweet was not reply-worthy left no
-- trace at all, so the same person had to be re-discovered from scratch every
-- time. Lyra has retained qualified people since #185; this gives Vega the same
-- accumulating, organically-grown prospect list.
--
-- WHY A SEPARATE TABLE FROM LINKEDIN'S: the identity keys genuinely differ. A
-- LinkedIn person is keyed by the vanity slug with an optional fsd_profile_id;
-- an X person is keyed by @handle with a numeric user id, and a handle can be
-- CHANGED by its owner while the id is stable. Folding both into one table would
-- mean a nullable-everything schema and a dedup key that means different things
-- per row, so they stay parallel — the same shape, honest column names.
--
-- Sourcing note: X has no people-search actor wired (the client exposes
-- userTweets / searchTimeline / conversationReplies only), so unlike Lyra's
-- Feeder A there is no profile-search source. Candidates come from authors seen
-- in the keyword lane, gated on their BIO by the ICP gate. `source` records
-- which path surfaced them so a future people-search lane can be told apart.
create table if not exists noelle.x_discovered_people (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references noelle.organizations(id) on delete cascade,
  agent_instance_id uuid not null references noelle.agent_instances(id) on delete cascade,
  -- @-stripped, lowercased handle — the dedup key, matching how every other X
  -- table normalises handles (x_watchlist_people, leads.author_handle).
  handle            text not null,
  -- Numeric X user id when the scraper returned one. Stable across a handle
  -- rename, so it is the durable identity even though `handle` is the key.
  author_id         text,
  display_name      text,
  -- Profile bio. This is what the ICP gate qualified on, so it is kept for
  -- auditing WHY a person was retained.
  bio               text,
  -- 'keyword_author' (a qualified author seen in the keyword lane).
  -- Reserved for a future people-search lane: 'profile_search'.
  source            text not null default 'keyword_author',
  -- How many times discovery has re-surfaced this person (a popularity signal,
  -- and the natural ranking for "who is worth polling first").
  seen_count        integer not null default 1,
  -- Last time their timeline was actually polled for leads (NULL = never).
  -- Drives the person-poll cooldown so one person cannot be re-fetched every
  -- tick while the rest of the list starves.
  last_polled_at    timestamptz,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  unique (agent_instance_id, handle)
);

-- Ranking for the person-poll: least-recently-polled first, never-polled first
-- of all (nulls first), tie-broken by how often we have seen them.
create index if not exists x_discovered_people_poll_idx
  on noelle.x_discovered_people (agent_instance_id, last_polled_at asc nulls first, seen_count desc);

create index if not exists x_discovered_people_instance_idx
  on noelle.x_discovered_people (agent_instance_id, last_seen_at desc);

grant select, insert, update, delete on noelle.x_discovered_people to noelle_app;
