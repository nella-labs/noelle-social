-- infra/cloudsql/schema/0040_connections_multi_token.sql
-- Multi-token Apify fallback: stack N Apify tokens per org and rotate to the next
-- when one hits its monthly usage hard limit (Apify returns 403
-- "platform-feature-disabled / Monthly usage hard limit exceeded"). 0033 kept
-- exactly ONE active token per (org, kind) via a partial unique index; that's the
-- wrong shape for fallback, so we lift it here.
--
-- `exhausted_at` records when a token last hit its cap. The discovery worker sets
-- it on a 403 and rotates to the next token; it clears it on the next successful
-- call with that token (so a token whose monthly cycle reset comes back into the
-- pool automatically — no cron). The resolver orders non-exhausted tokens first,
-- then oldest-exhausted (most likely to have reset), so a dead token is skipped
-- without being deleted (spend history via llm_calls.credential_id survives).

alter table noelle.connections
  add column if not exists exhausted_at timestamptz;

-- Drop the one-active-per-(org,kind) guarantee — multiple active apify tokens is
-- now the whole point. Other connection kinds are Secret-Manager-backed and never
-- land in this table, so nothing else relied on it.
drop index if exists noelle.connections_one_active_per_kind;

-- Resolver ordering index: active tokens for an org+kind, non-exhausted first.
create index if not exists connections_org_kind_active_idx
  on noelle.connections (org_id, kind, exhausted_at nulls first, created_at)
  where active;

-- noelle_app already has select/insert/update on noelle.connections (0033); the
-- worker only needs update (set/clear exhausted_at), which is covered.
