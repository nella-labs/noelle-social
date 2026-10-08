-- infra/cloudsql/schema/0058_connections_in_use.sql
-- Split the Apify token pool into two buckets: IN USE vs SPARE. Until now every
-- active token was live — the resolver (listApifyTokens) handed the workers every
-- non-invalid token and rotated through all of them. The operator had no way to
-- park a token (bulk-paste a batch to have ready) without the agents immediately
-- burning it.
--
-- `in_use` is that switch. The resolver now only sees `in_use = true` tokens; a
-- SPARE token (`in_use = false`) sits in noelle.connections, visible + testable in
-- the dashboard, but no worker ever fetches it until the operator promotes it.
-- Moving a token between buckets is just a flag flip — spend history
-- (llm_calls.credential_id) and exhausted/invalid/retry state are untouched.

alter table noelle.connections
  -- false = SPARE (parked, agents never touch it); true = IN USE (live rotation).
  -- Defaults to false so newly-pasted tokens land parked and must be promoted by
  -- hand. The backfill below keeps every CURRENT token live, so nothing breaks on
  -- deploy.
  add column if not exists in_use boolean not null default false;

-- Backfill: every token that exists today was live, so keep it in use. Only apify
-- rows use this column; other kinds are Secret-Manager-backed and never land here.
update noelle.connections
  set in_use = true
  where kind = 'apify' and active;

-- Resolver hot path: the in-use, non-exhausted tokens for an org+kind, in try-order.
-- Mirrors connections_org_kind_active_idx (0040) but scoped to the in-use bucket so
-- the workers' per-tick read stays a tight index scan as the spare bucket grows.
create index if not exists connections_org_kind_inuse_idx
  on noelle.connections (org_id, kind, exhausted_at nulls first, created_at)
  where active and in_use;
