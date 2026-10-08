-- infra/cloudsql/schema/0053_reddit_watchlist.sql
-- Watchlist of subreddits the Reddit intern (Orion) monitors for in-ICP threads
-- to reply to. This is the Reddit analogue of noelle.linkedin_watchlist_people,
-- but the targeting unit is a SUBREDDIT, not a person.
--
-- IMPORTANT difference vs the LinkedIn/X people-watchlists: a watchlisted
-- subreddit is the discovery SOURCE, not a priority bypass. A subreddit carries
-- far more volume than a single person's feed and most of it is off-ICP, so every
-- discovered post still flows through the classifier (leads.priority stays false).
-- The classifier is what selects the "thoughtful, on-brand reply" candidates.
--
-- Orion is DRAFT-ONLY: it never posts to Reddit. Drafts queue for approval
-- (human-in-the-loop), exactly like the LinkedIn intern's DMs.
--
-- Tenancy: every row carries (org_id, agent_instance_id); the discovery worker
-- scopes its read by agent_instance_id.

create table if not exists noelle.reddit_watchlist (
  id                uuid        primary key default gen_random_uuid(),
  org_id            uuid        not null references noelle.organizations(id) on delete cascade,
  agent_instance_id uuid        not null references noelle.agent_instances(id) on delete cascade,
  subreddit         text        not null,                     -- community name, lowercased, WITHOUT the "r/" prefix
  objective         text,                                     -- optional per-subreddit engagement steer
  min_score         integer     not null default 0,           -- skip posts below this upvote score at discovery
  added_at          timestamptz not null default now(),       -- "from this day forward" anchor (posted_at >= added_at)
  created_at        timestamptz not null default now(),
  unique (agent_instance_id, subreddit)
);

create index if not exists reddit_watchlist_instance_idx
  on noelle.reddit_watchlist (agent_instance_id);

grant select, insert, update, delete on noelle.reddit_watchlist to noelle_app;
