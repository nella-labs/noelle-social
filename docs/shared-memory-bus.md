# Shared memory bus

A Postgres-backed store any agent/worker writes to and reads from **at any
moment**, so every agent knows what is happening across the org — and so a live
orchestration view can render the whole company working in real time.

Before this, workers coordinated **only** through `noelle.leads.status`
transitions. There was no event stream and no "what is each worker doing right
now" store; the only telemetry was `worker_runs` (start/finish) and `llm_calls`
(spend). The bus is the missing shared-memory layer.

> **Naming.** A bus **bucket** is a KV *namespace*. It is unrelated to the
> budget spend *bucket* (`packages/runtime/src/budgetBucket.ts`,
> `noelle.llm_calls.bucket`). The two never interact.

## Two shapes

| Shape | Table | Question it answers |
|---|---|---|
| **Event stream** (append-only) | `noelle.bus_events` | "what happened, and when" |
| **KV buckets** (current value) | `noelle.bus_state` | "what is the latest state of X right now" |

Schema: `infra/cloudsql/schema/0032_bus.sql`. Applied by both the Cloud SQL
`psql` path and the self-host CLI (`noelle db migrate` — the
`noelle.schema_migrations` ledger picks it up automatically).

### `noelle.bus_events`

`id, org_id, agent_instance_id?, agent_role, worker?, topic, severity, summary,
payload jsonb, correlation_id?, created_at`. `agent_instance_id` is `on delete
set null` — events are an audit log and outlive the instance. `correlation_id`
chains a single lead's journey across workers (it is the lead id).

### `noelle.bus_state`

PK `(org_id, bucket, key)`, plus `value jsonb, version bigint,
updated_by_instance_id?, updated_by_worker?, expires_at?, updated_at`. Upsert
bumps `version`. `expires_at` is an optional TTL — readers ignore expired rows
(lazy expiry; no sweeper in 0.0.1). `version` is bigint, so postgres.js returns
it as a **string** — always `Number()` it on read.

## Topic taxonomy (events)

| topic | worker | emitted when |
|---|---|---|
| `lead.discovered` | discovery | a genuinely new lead is inserted |
| `lead.classified` | classifier | a lead is graded (payload carries `tier`/`label`) |
| `draft.created` | drafter | a lead is drafted (payload carries `angles`/`reply_kind`) |
| `draft.sent` | send | a reply is posted to X (X intern only — Lyra never sends) |
| `worker.error` | any | a tick throws (severity `error`) |

## Bucket namespaces (state)

| bucket | key | value |
|---|---|---|
| `worker_status` | `<agentRole>:<workerKind>` (e.g. `x_intern:discovery`) | `{ state: running\|idle\|error, at, rows?, lastError? }` |
| `own_account` | platform (`x`) | `{ handle, followers, following, posts, capturedAt, source }` — the OPERATOR's own account |

`worker_status` is written by `recordRun` (`packages/runtime/src/workerRuns.ts`,
re-exported per app from `apps/*/src/lib/worker-runs.ts` with that app's
worker-kind union) on every tick start + finish, so the orchestration view sees live worker state
without polling `worker_runs`. The key includes the agent role because
`bus_state` is org-scoped — without it, two agents in one org (x_intern +
linkedin_intern) would collide on the same worker kind (both have a `profiler`).

`own_account` is the operator's own follower/following/post counts, refreshed by
the own-account sweep in the X ideation worker (`workers/own-account-tick.ts`)
and read by the drafter. It lives on the bus rather than in a table precisely
because it is a fact EVERY agent needs: any agent that writes first-person copy
can state a real number instead of inventing one. Counts are nullable — `null`
means unknown and must never be rendered as `0`, because the drafter is allowed
to say the number out loud. Readers must also check `capturedAt`: past
`OWN_ACCOUNT_MAX_AGE_DAYS` (3) the count is treated as unknown. See
`apps/x-intern/src/lib/own-account.ts` and the "24 followers" incident in
`docs/grounded-drafting.md`.

## Runtime client — `createBus`

`packages/runtime/src/bus.ts`. Driver-agnostic: it consumes the same
`QueryExecutor` seam as `tenancy.ts` (a `(sql, params) => rows` function), so
`@noelle/runtime` stays free of a `postgres` dependency. Each worker app binds
it with a 3-line adapter in `apps/<app>/src/lib/bus.ts` (`busForInstance(inst)`).

```ts
const bus = createBus({ exec, orgId, agentInstanceId, agentRole });
await bus.emit({ topic: "lead.discovered", worker: "discovery", summary, payload, correlationId });
await bus.put("worker_status", "discovery", { state: "running" }, { worker: "discovery" });
const status = await bus.get("worker_status", "discovery");
const all    = await bus.list("worker_status");
const recent = await bus.tail({ topic: "worker.error", limit: 50 });
```

### Fail-soft contract (important)

`emit()` and `put()` **never throw** — they swallow + log any error. Telemetry
must never break a worker pipeline. This is safe because no worker path holds an
open transaction: every claim is one autocommitted `FOR UPDATE SKIP LOCKED`
statement, so an emit after the claim cannot poison a txn. Reads (`get`/`list`/
`tail`) are strict and surface errors to the caller.

## HTTP surface (`apps/api-vm/src/routes/bus.ts`)

| Method + path | Auth | Use |
|---|---|---|
| `GET /api/bus/events?org_id=&topic?=&agent_instance_id?=&limit?=` | JWT | dashboard / viewer reads the stream |
| `GET /api/bus/state?org_id=&bucket?=` | JWT | reads current KV state |
| `POST /api/bus/emit` | HMAC | out-of-process emitter appends an event |
| `POST /api/bus/state` | HMAC | out-of-process emitter upserts KV state |

In-process workers write **directly** via `createBus` (no HTTP hop); the HMAC
routes exist for emitters that aren't holding a Cloud SQL handle. HMAC is applied
as **per-route middleware** on the POST handlers (not a path-glob `use`) so it
never shadows the JWT `GET /api/bus/state` that shares the path.

Dashboard read helpers: `listBusEvents(orgId, opts)` and `getBusState(orgId,
bucket?)` in `apps/app/src/lib/queries.ts` (org-member-gated).

## Consumers

- **Live orchestration view** — renders the org's agents + worker pipelines with
  live status/counts pulled from `worker_status` + the event stream.
- **Future cross-agent coordination** — the read side is in place; agents acting
  on each other's state (dedupe, hand-offs, supervisor directives) builds on
  `get`/`list` without new substrate.
