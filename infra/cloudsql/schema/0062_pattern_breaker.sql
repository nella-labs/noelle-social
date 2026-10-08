-- infra/cloudsql/schema/0062_pattern_breaker.sql
-- Pattern Breaker agent.
--
-- The per-draft verifier (packages/runtime/src/drafting/draftVerifier.ts) catches
-- a HARDCODED slop list. The Pattern Breaker is its cross-post sibling: it reads
-- the operator's last N posts (10/20/30/40/50/100) as a corpus, an LLM finds
-- STRUCTURAL habits that repeat too often (e.g. "wall of text → tiny congrats
-- phrase", a repeated opener, the same rhythm), and writes them back as DB-backed
-- rules the drafter + verifier consume at draft time — instead of someone
-- hand-editing SLOP_PHRASES.
--
-- Two tables:
--   pattern_rules  — machine-consumed. Active rows are injected into the drafter
--                    system prompt and the verifier's checks.
--   pattern_alerts — operator-facing. Surfaced as a popup on the approvals page
--                    with Revert (kill the rule) and Refine (AI rewrites it).

-- The discovered anti-pattern rules the drafter + verifier read.
create table if not exists noelle.pattern_rules (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references noelle.organizations(id) on delete cascade,
  agent_instance_id  uuid not null references noelle.agent_instances(id) on delete cascade,
  -- 'phrase'    → a deterministic catch (regex), like a dynamic SLOP_PHRASES entry.
  -- 'structure' → a shape the regex can't express ("opens with a one-line hook
  --               then a blank line then a list"); injected as an instruction into
  --               the drafter prompt + the LLM judge.
  kind               text not null check (kind in ('phrase', 'structure')),
  label              text not null,            -- short human tag, e.g. "wall-of-text → tiny congrats"
  instruction        text not null,            -- the NEVER-DO line injected into prompts/judge
  regex              text,                     -- optional deterministic catch (kind='phrase')
  severity           text not null default 'medium' check (severity in ('low', 'medium', 'high')),
  active             boolean not null default true,
  -- 'auto'   → minted by the pattern breaker
  -- 'refined'→ operator hit Refine; AI rewrote the instruction
  -- 'manual' → typed by hand
  source             text not null default 'auto' check (source in ('auto', 'refined', 'manual')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Hot path: the drafter loads active rules for an instance once per tick.
create index if not exists pattern_rules_active_idx
  on noelle.pattern_rules (agent_instance_id)
  where active;

-- Dedup guard: one active rule per (instance, label). The breaker upserts on this.
create unique index if not exists pattern_rules_instance_label_idx
  on noelle.pattern_rules (agent_instance_id, lower(label))
  where active;

-- Operator-facing notifications. One per detected pattern; the approvals page
-- shows status='open' rows.
create table if not exists noelle.pattern_alerts (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references noelle.organizations(id) on delete cascade,
  agent_instance_id  uuid not null references noelle.agent_instances(id) on delete cascade,
  rule_id            uuid references noelle.pattern_rules(id) on delete set null,
  pattern_name       text not null,            -- short title for the popup
  description        text not null,            -- plain-English "you keep doing X across N posts"
  severity           text not null default 'medium' check (severity in ('low', 'medium', 'high')),
  window_size        integer not null,         -- how many posts were analyzed (10/20/.../100)
  frequency_count    integer not null,         -- how many of those N matched the pattern
  examples           jsonb not null default '[]'::jsonb,  -- [{draft_id, snippet}]
  -- Lifecycle:
  --   open        → just detected, awaiting the operator.
  --   refining    → operator hit Refine; the worker will AI-rewrite the rule.
  --   refined     → worker rewrote it; the new instruction is live, shown for review.
  --   reverted    → operator killed the rule (drafting reverts). Hidden.
  --   acknowledged→ operator kept it as-is. Hidden.
  -- The popup shows open | refining | refined.
  status             text not null default 'open'
    check (status in ('open', 'refining', 'refined', 'reverted', 'acknowledged')),
  -- The operator's optional steer for the AI rewrite (set when status→refining).
  refine_note        text,
  created_at         timestamptz not null default now(),
  decided_at         timestamptz,
  decided_by         text
);

-- Popup feed: the still-actionable alerts for an instance.
create index if not exists pattern_alerts_visible_idx
  on noelle.pattern_alerts (agent_instance_id, created_at desc)
  where status in ('open', 'refining', 'refined');

-- Refine queue: the worker drains alerts the operator asked to AI-rewrite.
create index if not exists pattern_alerts_refining_idx
  on noelle.pattern_alerts (agent_instance_id)
  where status = 'refining';
