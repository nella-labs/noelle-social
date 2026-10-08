import { Hono } from "hono";
import type {
  ServiceStatus,
  SystemStatus,
  WorkerRunStatus,
} from "@noelle/contracts";
import { noelleDb } from "../lib/db.js";

/**
 * GET /api/system/status — self-host VM observability.
 *
 * Assembles the shared @noelle/contracts SystemStatus the dashboard's System
 * page renders, from things api-vm can see directly: a live Postgres probe,
 * worker_runs freshness, configured-provider env, applied migrations (the
 * self-host CLI's noelle.schema_migrations table), and host/process info. The
 * CLI's `noelle status --json` reads the same contract — one source of truth.
 *
 * Mounted under the JWT-protected group, so only an authenticated operator can
 * read it. On the managed deployment the route exists but is unused.
 */

const SERVICE_VERSION = "0.0.1-alpha.0";

const WORKER_KINDS = ["discovery", "classifier", "drafter", "send"] as const;

// How long since a worker's last successful run before we flag it stale. Tuned
// to a few multiples of each worker's poll cadence (apps/x-intern/src/env.ts).
const WORKER_STALE_MS: Record<(typeof WORKER_KINDS)[number], number> = {
  discovery: 15 * 60_000,
  classifier: 5 * 60_000,
  drafter: 5 * 60_000,
  send: 10 * 60_000,
};

function mapPlatform(p: string): SystemStatus["host"]["platform"] {
  if (p === "darwin" || p === "linux" || p === "win32") return p;
  return "unknown";
}

function envHas(...names: string[]): boolean {
  return names.some((n) => {
    const v = process.env[n];
    return typeof v === "string" && v.length > 0;
  });
}

export const system = new Hono();

system.get("/api/system/status", async (c) => {
  const sql = noelleDb();
  const services: ServiceStatus[] = [];

  // Live Postgres probe.
  const pgStart = Date.now();
  let pgOk = true;
  let pgDetail: string | undefined;
  try {
    await sql`select 1 as ok`;
  } catch (err) {
    pgOk = false;
    pgDetail = err instanceof Error ? err.message : String(err);
  }
  services.push({
    name: "postgres",
    state: pgOk ? "ok" : "down",
    latencyMs: Date.now() - pgStart,
    ...(pgDetail ? { detail: pgDetail } : {}),
  });

  // api-vm is answering this request, so it's up.
  services.push({ name: "api-vm", state: "ok", latencyMs: 0 });

  // The dashboard reaches this endpoint via its own server-side fetch; if the
  // operator is seeing the page, the app is serving.
  services.push({ name: "app", state: "ok", detail: "dashboard reachable" });

  // Worker liveness from worker_runs (success = finished_at set, error null).
  const workersEnabled = process.env.NOELLE_WORKERS_ENABLED === "1";
  let workerRuns: WorkerRunStatus[];
  try {
    const rows = await sql<Array<{ worker: string; last_success_at: Date | null }>>`
      select worker, max(finished_at) filter (where error is null) as last_success_at
      from noelle.worker_runs
      group by worker
    `;
    const byKind = new Map(rows.map((r) => [r.worker, r.last_success_at]));
    workerRuns = WORKER_KINDS.map((kind) => {
      const last = byKind.get(kind) ?? null;
      const lastMs = last ? new Date(last).getTime() : null;
      const stale =
        workersEnabled &&
        (lastMs == null || Date.now() - lastMs > WORKER_STALE_MS[kind]);
      return {
        kind,
        lastSuccessAt: lastMs == null ? null : new Date(lastMs).toISOString(),
        stale,
        enabled: workersEnabled,
      };
    });
  } catch {
    workerRuns = WORKER_KINDS.map((kind) => ({
      kind,
      lastSuccessAt: null,
      stale: false,
      enabled: workersEnabled,
    }));
  }

  // Which provider credentials are configured (env or env-backed secrets).
  const providers = {
    anthropic: envHas("ANTHROPIC_API_KEY", "NOELLE_SECRET_NOELLE_WORKER_ANTHROPIC_API_KEY"),
    openai: envHas("OPENAI_API_KEY", "NOELLE_SECRET_NOELLE_WORKER_OPENAI_API_KEY"),
    codex: process.env.NOELLE_CODEX_ENABLED === "1",
    vertex:
      process.env.NOELLE_VERTEX_ENABLED === "1" ||
      envHas("GOOGLE_APPLICATION_CREDENTIALS"),
    bedrock:
      (envHas("AWS_ACCESS_KEY_ID") && envHas("AWS_SECRET_ACCESS_KEY")) ||
      envHas("NOELLE_SECRET_NOELLE_WORKER_BEDROCK_AWS_ACCESS_KEY_ID"),
  };

  // Applied migrations — best-effort. The self-host CLI records each applied
  // file in noelle.schema_migrations; on the managed box (no such table) this
  // returns empty, which the UI renders as "n/a".
  let applied: string[] = [];
  try {
    const rows = await sql<Array<{ filename: string }>>`
      select filename from noelle.schema_migrations order by filename
    `;
    applied = rows.map((r) => r.filename);
  } catch {
    applied = [];
  }

  const status: SystemStatus = {
    ok: pgOk,
    service: "noelle-self-host",
    ts: new Date().toISOString(),
    host: {
      platform: mapPlatform(process.platform),
      uptimeSeconds: Math.round(process.uptime()),
      version: process.env.NOELLE_BUILD_VERSION ?? SERVICE_VERSION,
      tunnel: process.env.NOELLE_TUNNEL_HOSTNAME ?? null,
    },
    services,
    schema: { applied, pending: [] },
    providers,
    workerRuns,
  };

  return c.json(status);
});
