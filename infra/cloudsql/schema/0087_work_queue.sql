-- Durable work queue backing PgWorkQueue (packages/runtime/src/queue.ts) —
-- the retry / dead-letter / orphan-reclaim primitive the worker pipeline
-- lacked (docs/scalability.md § Pluggable WorkQueue, the Phase-5 item).
--
-- Semantics, all enforced by the claim/ack/nack SQL, not by triggers:
--   claim   — atomically stamps claim_id + claimed_until (TTL) and increments
--             attempts, using FOR UPDATE SKIP LOCKED so concurrent workers
--             never double-claim. A row whose claimed_until has passed is
--             claimable again: a worker that dies mid-job orphans nothing —
--             the claim simply expires and the next sweep redelivers it.
--   ack     — deletes the row. History lives in worker_runs, not here.
--   nack    — releases the claim and delays redelivery; once attempts has
--             reached the queue's max_attempts the row is dead-lettered
--             (dead_at set) and never delivered again.
--
-- One table serves every logical queue, discriminated by `queue`. Jobs are an
-- opaque jsonb payload; tenant scoping stays in app code (callers enforce
-- assertOrgMember before enqueueing, and per-org fairness reads job->>'org_id'
-- via ClaimOptions.perKeyMax). No RLS on Cloud SQL — same posture as every
-- other noelle.* table.

create table if not exists noelle.work_queue (
  id            uuid primary key default gen_random_uuid(),
  seq           bigint generated always as identity,  -- insertion order; FIFO tie-break when available_at collides
  queue         text not null,          -- logical queue name ("drafts.autosend", …)
  job           jsonb not null,         -- opaque payload (WorkQueue<T>'s T)
  key           text,                   -- optional idempotency/dedupe key
  attempts      int not null default 0, -- delivery count (incremented at claim)
  available_at  timestamptz not null default now(),  -- earliest next delivery
  claim_id      uuid,                   -- current claim token (ack/nack handle)
  claimed_until timestamptz,            -- claim TTL; past = claim expired (orphan reclaim)
  dead_at       timestamptz,            -- dead-lettered at (attempts exhausted)
  created_at    timestamptz not null default now()
);

-- Dedupe: a second enqueue with the same (queue, key) is a no-op.
create unique index if not exists work_queue_queue_key_uq
  on noelle.work_queue (queue, key) where key is not null;

-- The claim hot path: "claimable rows of queue X, oldest first".
create index if not exists work_queue_claim_idx
  on noelle.work_queue (queue, available_at, seq) where dead_at is null;

comment on table noelle.work_queue is
  'Durable job queue (PgWorkQueue): claim via FOR UPDATE SKIP LOCKED with TTL-expiring claims (orphan reclaim), attempt-counted redelivery, dead-letter on exhaustion.';

grant select, insert, update, delete on noelle.work_queue to noelle_app;
