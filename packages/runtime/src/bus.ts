/**
 * Shared memory bus client.
 *
 * A tiny, driver-agnostic client over the bus tables (noelle.bus_events +
 * noelle.bus_state, migration 0032) so any agent/worker can publish what it is
 * doing and read the org's current state at any moment. Two shapes:
 *
 *   - emit()              → append a row to the event STREAM (bus_events).
 *   - put()/get()/list()  → upsert/read current-value KV "buckets" (bus_state).
 *   - tail()              → read recent events.
 *
 * WRITES ARE FAIL-SOFT. emit()/put() swallow + log any error and never throw:
 * telemetry must never break a worker pipeline. Reads are strict (they surface
 * errors to the caller). It is safe to emit after a claim — no worker path
 * holds an open transaction (every claim is one autocommitted
 * FOR UPDATE SKIP LOCKED statement), so a failed emit cannot poison a txn.
 *
 * Like tenancy.ts, this stays free of any `postgres`/`pg` dependency by
 * consuming a `QueryExecutor` (a `(sql, params) => rows` function). The apps
 * bind it with a 3-line postgres.js adapter (see apps/api-vm/src/lib/auth.ts).
 *
 * NAMING: a bus "bucket" is a KV NAMESPACE. It is UNRELATED to the budget spend
 * bucket in budgetBucket.ts / noelle.llm_calls.bucket. The two never interact.
 */

import type { QueryExecutor } from "./tenancy.js";
import { BusEventsQuerySchema } from "@noelle/contracts";

export type BusSeverity = "info" | "warn" | "error";

/**
 * Well-known KV namespaces. The type is an open string union — callers may use
 * any namespace — but these are the ones the orchestration view reads:
 *   - "worker_status": key = worker kind ('discovery' | 'classifier' | …),
 *      value = { state, at, rows?, lastError? }.
 */
export type BusBucket = "worker_status" | "pipeline" | (string & {});

export interface BusEmit {
  topic: string;
  summary?: string | null;
  worker?: string | null;
  severity?: BusSeverity;
  payload?: Record<string, unknown>;
  correlationId?: string | null;
}

export interface BusPutOptions {
  worker?: string | null;
  /** Optional TTL — readers ignore rows past expiry (lazy expiry, no sweeper). */
  ttlSeconds?: number | null;
}

export interface BusStateRow {
  bucket: string;
  key: string;
  value: unknown;
  version: number;
  updatedByWorker: string | null;
  updatedAt: string;
}

export interface BusEventRow {
  id: string;
  agentInstanceId: string | null;
  agentRole: string;
  worker: string | null;
  topic: string;
  severity: BusSeverity;
  summary: string | null;
  payload: Record<string, unknown>;
  correlationId: string | null;
  createdAt: string;
}

export interface Bus {
  /** The agent role this bus is scoped to (e.g. "x_intern"). "system" if unset. */
  readonly agentRole: string;
  /** The agent instance this bus is scoped to, or null for org-level writes. */
  readonly agentInstanceId: string | null;
  emit(e: BusEmit): Promise<void>;
  put(bucket: BusBucket, key: string, value: unknown, opts?: BusPutOptions): Promise<void>;
  get<T = unknown>(bucket: BusBucket, key: string): Promise<T | null>;
  list(bucket: BusBucket): Promise<BusStateRow[]>;
  tail(opts?: { topic?: string; limit?: number }): Promise<BusEventRow[]>;
}

export interface CreateBusArgs {
  exec: QueryExecutor;
  orgId: string;
  agentInstanceId?: string | null;
  agentRole?: string;
  /** Override the default console.warn logger used when a fail-soft write throws. */
  onError?: (where: string, err: unknown) => void;
}

/** postgres.js parses jsonb to JS objects, but be defensive about a raw string. */
function parseJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/** timestamptz comes back as a Date from postgres.js; the contracts want ISO. */
function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function mapEvent(r: Record<string, unknown>): BusEventRow {
  return {
    id: String(r.id),
    agentInstanceId: (r.agent_instance_id as string | null) ?? null,
    agentRole: String(r.agent_role),
    worker: (r.worker as string | null) ?? null,
    topic: String(r.topic),
    severity: (r.severity as BusSeverity) ?? "info",
    summary: (r.summary as string | null) ?? null,
    payload: (parseJson(r.payload) as Record<string, unknown>) ?? {},
    correlationId: (r.correlation_id as string | null) ?? null,
    createdAt: toIso(r.created_at),
  };
}

export function createBus(args: CreateBusArgs): Bus {
  const { exec, orgId } = args;
  const agentInstanceId = args.agentInstanceId ?? null;
  const agentRole = args.agentRole ?? "system";
  const onError =
    args.onError ??
    ((where, err) => {
      console.warn(`[bus] ${where} failed (swallowed):`, (err as Error)?.message ?? err);
    });

  return {
    agentRole,
    agentInstanceId,
    async emit(e) {
      try {
        await exec(
          `insert into noelle.bus_events
             (org_id, agent_instance_id, agent_role, worker, topic, severity, summary, payload, correlation_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
          [
            orgId,
            agentInstanceId,
            agentRole,
            e.worker ?? null,
            e.topic,
            e.severity ?? "info",
            e.summary ?? null,
            // Pass the OBJECT, not a JSON string: postgres.js serializes objects
            // to jsonb itself. Pre-stringifying double-encodes it into a jsonb
            // STRING scalar (value->>'k' then reads null).
            e.payload ?? {},
            e.correlationId ?? null,
          ],
        );
      } catch (err) {
        onError("emit", err);
      }
    },

    async put(bucket, key, value, opts) {
      try {
        await exec(
          `insert into noelle.bus_state
             (org_id, bucket, key, value, updated_by_instance_id, updated_by_worker, expires_at)
           values ($1, $2, $3, $4::jsonb, $5, $6,
             case when $7::int is null then null else now() + ($7::int * interval '1 second') end)
           on conflict (org_id, bucket, key) do update set
             value                  = excluded.value,
             version                = noelle.bus_state.version + 1,
             updated_by_instance_id = excluded.updated_by_instance_id,
             updated_by_worker      = excluded.updated_by_worker,
             expires_at             = excluded.expires_at,
             updated_at             = now()`,
          [
            orgId,
            bucket,
            key,
            // Pass the OBJECT, not a JSON string — see emit() above. postgres.js
            // serializes it to jsonb; pre-stringifying double-encodes.
            value ?? null,
            agentInstanceId,
            opts?.worker ?? null,
            opts?.ttlSeconds ?? null,
          ],
        );
      } catch (err) {
        onError("put", err);
      }
    },

    async get<T = unknown>(bucket: BusBucket, key: string): Promise<T | null> {
      const rows = await exec(
        `select value
