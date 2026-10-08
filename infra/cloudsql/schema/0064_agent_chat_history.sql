-- infra/cloudsql/schema/0064_agent_chat_history.sql
-- Persist the "Talk to <agent>" chat on the per-agent detail page.
--
-- Before this, the chat panel (apps/app/.../AgentChat.tsx) was pure client
-- `useState` and the POST route sent NO history ("each turn is independent").
-- Every reload wiped the conversation and the model never saw prior turns.
--
-- This table stores every turn so a conversation survives reloads/navigation
-- and the model is fed the prior turns of the active conversation.
--
-- Scope: one row per message, keyed by (org, agent instance, user). A
-- `conversation_id` groups the turns of a single thread — "New chat" in the UI
-- just mints a fresh conversation_id; old threads are retained, never deleted.
-- Tenancy is enforced in app code (assertOrgMember via getAgentInstance); there
-- is no RLS in Cloud SQL.

create table if not exists noelle.agent_chat_messages (
  id                 uuid primary key default gen_random_uuid(),
  -- Monotonic insertion order. A user+agent turn is written in one multi-row
  -- INSERT, so both rows share `created_at` (now() is per-statement); `seq`
  -- is the reliable tiebreaker so the transcript renders user-before-agent
  -- and the model history stays correctly alternated.
  seq                bigint generated always as identity,
  org_id             uuid not null references noelle.organizations(id) on delete cascade,
  agent_instance_id  uuid not null references noelle.agent_instances(id) on delete cascade,
  -- Supabase auth.users.id (the `sub` claim) of the operator who owns this chat.
  user_id            uuid not null,
  -- Groups the turns of one thread. A new thread ("New chat") gets a new id.
  conversation_id    uuid not null,
  -- 'user'  → the operator typed it. 'agent' → the model's reply.
  role               text not null check (role in ('user', 'agent')),
  body               text not null,
  -- A targeting/mission proposal the agent attached to this turn (jsonb), if any.
  -- Mirrors the `proposal` the POST route already returns to the client.
  proposal           jsonb,
  -- A Head-of-Growth vault edit the agent attached to this turn (jsonb), if any.
  vault_edit         jsonb,
  created_at         timestamptz not null default now()
);

-- Read path: load the turns of one conversation in insertion order.
create index if not exists agent_chat_messages_conversation_idx
  on noelle.agent_chat_messages (agent_instance_id, user_id, conversation_id, seq);

-- Resume path: find the operator's most recent conversation for an instance.
create index if not exists agent_chat_messages_latest_idx
  on noelle.agent_chat_messages (agent_instance_id, user_id, seq desc);
