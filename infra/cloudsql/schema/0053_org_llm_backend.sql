-- 0053_org_llm_backend.sql
-- Global per-org agent LLM backend switch.
--
-- One column on noelle.organizations selects which engine the agent workers
-- route their primary LLM call through:
--   'aws'    — AWS Bedrock (per-token, billed; the historical default path)
--   'claude' — the local `claude -p` Claude Max/Pro subscription (~$0/call),
--              wired by the claude-cli backend (see packages/runtime
--              callAgentModel.ts rewriteForClaudeCli + engineRegistryFromEnv.ts).
--
-- callAgentModel resolves this per-org at call time (makeLlmBackendResolver,
-- 30s TTL cache) and rewrites a `bedrock` PRIMARY handle to `claude-cli` only
-- when the org is set to 'claude' AND the claude-cli backend is actually wired
-- on the box. The routing FALLBACK stays Bedrock, so a CLI failure (auth
-- expired, binary missing, timeout) falls back automatically. With no resolver
-- the behavior is the legacy env-driven NOELLE_CLAUDE_CLI flag — unchanged.
--
-- Default 'claude' so a fresh row prefers the subscription path; the resolver
-- ALSO defaults to 'claude' on a null/missing column or any read error, so the
-- whole feature fails toward the current (claude-cli) behavior.
--
-- Idempotent: re-runnable. No new grant — the column lives on an existing table
-- already granted to noelle_app.
--
-- Migration numbering note: `main` topped at 0052_account_style_embeddings.sql
-- when this was authored, so 0053 is the next free slot. If a sibling session
-- lands a 0053 first, renumber this to the next free integer before merge.

alter table noelle.organizations
  add column if not exists llm_backend text not null default 'claude';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'organizations_llm_backend_chk') then
    alter table noelle.organizations
      add constraint organizations_llm_backend_chk
      check (llm_backend in ('aws','claude')) not valid;
  end if;
end $$;
