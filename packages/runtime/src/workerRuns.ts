// Consolidated from four per-app copies (all four diffed against each other):
//   apps/x-intern/src/lib/worker-runs.ts        (base shape)
//   apps/linkedin-intern/src/lib/worker-runs.ts (same body, different kind union)
//   apps/reddit-intern/src/lib/worker-runs.ts   (same body, different kind union)
//   apps/video-intern/src/lib/worker-runs.ts    (SUPERSET: instanceId + updateSummary
//                                                + isCancelRequested, from 0078)
//
// Two kinds of difference existed, handled differently:
//
// 1. The WorkerKind union is narrowed PER APP and the four unions are almost
//    disjoint (video-intern's is entirely disjoint: harvester/teardown/…). That
//    narrowing is deliberate — worker_runs.worker is read by the dashboard, so an
//    app must not be able to stamp a name that dashboard doesn't know. This module
//    therefore takes the kind as `string` and each app keeps a type-only binding
//    (`export const recordRun: RecordRun<WorkerKind> = …`) that re-narrows it to
//    exactly the union it had before.
//
// 2. video-intern's copy is a strict superset of the others: it also writes
//    instance_id and exposes updateSummary()/isCancelRequested() (schema 0078).
//    The superset is taken here. It is behaviour-neutral for the three interns
//    that don't use it: instance_id is nullable with no default, so writing an
//    explicit NULL is identical to omitting the column, and the two extra handle
//    methods only touch the DB when a caller calls them.
//
// Everything else was byte-identical apart from docstring/comment prose.

import type { Sql } from "postgres";
import type { HarvestRunSummary } from "@noelle/contracts";
import type { Bus } from "./bus.js";

export interface RunHandle {
  id: string;
  /**
   * Overwrite the run's live summary (worker_runs.summary). The video harvester
   * calls this after each lane so the console can watch progress fill in (~3s
   * poll). Fail-soft: a summary write never throws into the run.
   */
  updateSummary(summary: HarvestRunSummary): Promise<void>;
  /**
   * True once the operator has hit Stop (worker_runs.cancel_requested). The tick
   * polls this between pulls to bail cleanly mid-run. Fail-soft → false.
   */
  isCancelRequested(): Promise<boolean>;
  finish(opts: {
    status: "ok" | "error";
    rowsProcessed?: number;
    errorMessage?: string;
  }): Promise<void>;
}

export type RecordRunArgs<K extends string = string> = {
  sql: Sql;
  /**
   * The worker name stamped into worker_runs.worker. Left as an app-supplied type
   * parameter on purpose: each app narrows it to its own union (see the header),
   * and this module must not widen what any of them may write.
   */
  kind: K;
  /**
   * Which agent_instance this run belongs to. Lets the console query "latest
   * harvester run for this instance" (worker_runs was worker-only before 0078).
   * Omitted → the column is written NULL, exactly as before 0078.
   */
  instanceId?: string;
  /**
   * Optional shared-memory bus. When provided, recordRun mirrors the run into
   * the bus so the orchestration view sees live worker state without polling
   * worker_runs: a `worker_status` KV entry (running → idle/error, with the row
   * count) on start + finish, plus a `worker.error` stream event on failure.
   * All bus writes are fail-soft — they never throw, so they can't affect the
   * worker_runs ledger or the tick.
   */
  bus?: Bus;
};

/**
 * The per-app view of recordRun: same function, kind narrowed to the union that
 * app is allowed to stamp. Each intern exports `recordRun: RecordRun<WorkerKind>`
 * from its own lib/worker-runs.ts, which is where its union is declared.
 */
export type RecordRun<K extends string> = (args: RecordRunArgs<K>) => Promise<RunHandle>;

/**
 * Records a worker_runs row keyed by the schema columns from
 * infra/cloudsql/schema/0001_noelle_schema.sql (+ 0078):
 *   worker text, instance_id uuid, started_at timestamptz,
 *   finished_at timestamptz, rows_processed integer, error text,
 *   summary jsonb, cancel_requested boolean
 *
 * "status" is derived: running = finished_at IS NULL; ok = finished_at
 * IS NOT NULL AND error IS NULL; error = error IS NOT NULL. We don't
 * store the literal "running" / "ok" / "error" string in the DB.
 */
export async function recordRun(args: RecordRunArgs): Promise<RunHandle> {
  const { sql, kind, instanceId, bus } = args;
  // worker_status is org-scoped, so the key must include the agent role —
  // otherwise two agents in one org (x_intern + linkedin_intern) collide on the
  // same worker kind (e.g. both "profiler"). Key = "<role>:<kind>".
  const statusKey = bus ? `${bus.agentRole}:${kind}` : kind;
  const rows = await sql<{ id: string }[]>`
    insert into noelle.worker_runs (worker, instance_id)
    values (${kind}, ${instanceId ?? null})
    returning id
  `;
  const id = rows[0]!.id;
  await bus?.put(
    "worker_status",
    statusKey,
    { state: "running", at: new Date().toISOString() },
    { worker: kind },
  );
  return {
    id,
    async updateSummary(summary) {
      await sql`
        update noelle.worker_runs set summary = ${sql.json(summary)} where id = ${id}
      `.catch(() => {});
    },
    async isCancelRequested() {
      const r = await sql<{ cancel_requested: boolean }[]>`
        select cancel_requested from noelle.worker_runs where id = ${id}
      `.catch(() => [] as { cancel_requested: boolean }[]);
      return r[0]?.cancel_requested === true;
    },
    async finish({ status, rowsProcessed = 0, errorMessage }) {
      await sql`
        update noelle.worker_runs
        set finished_at = now(),
            rows_processed = ${rowsProcessed},
            error = ${status === "error" ? (errorMessage || "error") : null}
        where id = ${id}
      `;
      const at = new Date().toISOString();
      if (status === "error") {
        await bus?.put(
          "worker_status",
          statusKey,
          { state: "error", at, rows: rowsProcessed, lastError: errorMessage || "error" },
          { worker: kind },
        );
        await bus?.emit({
          topic: "worker.error",
          worker: kind,
          severity: "error",
          summary: `${kind} failed: ${errorMessage || "error"}`,
          payload: { error: errorMessage || "error" },
        });
      } else {
        await bus?.put(
          "worker_status",
          statusKey,
          { state: "idle", at, rows: rowsProcessed },
          { worker: kind },
        );
      }
    },
  };
}
