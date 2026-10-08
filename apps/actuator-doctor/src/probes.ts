import type { Sql } from "postgres";
import type {
  BridgeHealth,
  DoctorTarget,
  HeartbeatStatus,
  ProbeResult,
} from "@noelle/contracts";
import type { Env } from "./env.js";
import { httpGet } from "./http.js";
import type { Pm2App } from "./pm2.js";
import { ALL_TARGETS, BROWSER_LANE_TARGETS, HEARTBEAT_SOURCE_TO_TARGET, LANE_TARGETS, ROLE_TO_TARGET, isLaneTarget } from "./targets.js";

// The deterministic sensing layer. Every probe returns ProbeResult[] and NEVER
// throws — a network/DB failure comes back as a fail-SAFE result (fail-open for
// DB probes so a blip can't trigger remediation; the reachability probes report
// the outage as the fault it is). runAllProbes fans them out per tick.

type Metrics = Record<string, number | string | boolean | null>;

function mk(
  target: DoctorTarget,
  check: string,
  ok: boolean,
  reason: string | undefined,
  metrics: Metrics,
  at: string,
): ProbeResult {
  const r: ProbeResult = { target, check, ok, metrics, at };
  if (reason) r.reason = reason;
  return r;
}

// ---------------------------------------------------------------------------
// pm2 — one aggregate probe per target.
// ---------------------------------------------------------------------------

// pm2 statuses that are transient (a process mid start/stop, e.g. during a
// deploy). Never a fault: restarting one would fight the deploy's own restart.
const TRANSIENT = new Set(["launching", "stopping", "one-launch-status"]);

function classifyApp(name: string, env: Env): DoctorTarget | null {
  if (name === env.NOELLE_API_APP) return "api-vm";
  if (name === env.NOELLE_BRIDGE_APP) return "bridge";
  if (/^noelle-linkedin-/.test(name)) return "linkedin-actuator";
  if (/^noelle-reddit-/.test(name)) return "reddit-intern";
  if (/^noelle-(discovery|classifier|drafter|profiler|send|ideation|account-feeder)$/.test(name))
    return "x-actuator";
  return null; // noelle-app / noelle-video-* / noelle-spend-rollup — not doctor targets
}

export function probePm2(env: Env, apps: Pm2App[], at: string): ProbeResult[] {
  const byTarget = new Map<DoctorTarget, Pm2App[]>();
  for (const t of ALL_TARGETS) byTarget.set(t, []);
  for (const a of apps) {
    const t = classifyApp(a.name, env);
    if (t) byTarget.get(t)!.push(a);
  }

  const out: ProbeResult[] = [];
  for (const target of ALL_TARGETS) {
    const relevant = byTarget.get(target)!;

    if (target === "api-vm" || target === "bridge") {
      // Core infra must be present and online. A TRANSIENT status (mid deploy
      // restart) is NOT a fault — restarting a launching app would fight the
      // deploy. "stopped"/"errored"/absent ARE faults (core is never paused).
      const wanted = target === "api-vm" ? env.NOELLE_API_APP : env.NOELLE_BRIDGE_APP;
      const app = relevant.find((a) => a.name === wanted);
      if (!app) {
        out.push(mk(target, "pm2", false, "pm2-absent", { app: wanted, present: false }, at));
      } else {
        const ok = app.status === "online" || TRANSIENT.has(app.status);
        out.push(
          mk(target, "pm2", ok, ok ? undefined : `pm2-${app.status}`, {
            app: wanted,
            status: app.status,
            restarts: app.restart_time,
          }, at),
        );
      }
      continue;
    }

    // Lane: consider only pm2-SUPERVISED apps (status !== "stopped"). A stopped
    // app is an intentional pause (autostart:false send/feeder, or `noelle
    // stop`), never a fault. Among those, fault ONLY on "errored" — the
    // definitive crash. Transient launching/stopping (a deploy in flight) is not
    // a fault, so the doctor never restart-storms a worker that is mid-boot.
    const supervised = relevant.filter((a) => a.status !== "stopped");
    if (supervised.length === 0) {
      out.push(mk(target, "pm2", true, undefined, { supervised: 0, present: relevant.length }, at));
      continue;
    }
    const errored = supervised.filter((a) => a.status === "errored");
    const ok = errored.length === 0;
    out.push(
      mk(target, "pm2", ok, ok ? undefined : "pm2-errored", {
        supervised: supervised.length,
        offline: errored.length,
        offline_apps: errored.map((a) => a.name).join(","),
      }, at),
    );
  }
  return out;
}

// The offline apps a restart_worker remediation should target, recovered from
// the pm2 probe's metrics (index.ts hands them to remediate()).
export function offlineAppsFor(target: DoctorTarget, probes: ProbeResult[]): string[] {
  const p = probes.find((x) => x.target === target && x.check === "pm2");
  const raw = p?.metrics.offline_apps;
  if (typeof raw === "string" && raw.length > 0) return raw.split(",");
  return [];
}

// ---------------------------------------------------------------------------
// chrome_reachable — is the extension connected to the bridge?
// ---------------------------------------------------------------------------

export async function probeChromeReachable(env: Env, at: string): Promise<ProbeResult[]> {
  const r = await httpGet(`${env.NOELLE_BRIDGE_URL}/health`, {
    timeoutMs: env.NOELLE_DOCTOR_HTTP_TIMEOUT_MS,
  });
  if (r.status === null) {
    return [
      mk("bridge", "chrome_reachable", false, "bridge-unreachable", {
        error: (r.error ?? "").slice(0, 120),
      }, at),
    ];
  }
  if (r.status !== 200) {
    return [mk("bridge", "chrome_reachable", false, "bridge-unhealthy", { http_status: r.status }, at)];
  }
  const health = (r.json ?? null) as Partial<BridgeHealth> | null;
  if (typeof health?.ext_connected !== "boolean") {
    return [mk("bridge", "chrome_reachable", false, "bridge-health-invalid", { http_status: r.status }, at)];
  }
  const connected = health?.ext_connected === true;
  return [
    mk("bridge", "chrome_reachable", connected, connected ? undefined : "ext-disconnected", {
      http_status: r.status,
      ext_connected: health?.ext_connected === true,
      ext_version: typeof health?.ext_version === "string" ? health.ext_version : null,
    }, at),
  ];
}

// ---------------------------------------------------------------------------
// build_stamp — lenient presence check (observe-only; no seed).
// ---------------------------------------------------------------------------

export async function probeBuildStamp(env: Env, at: string): Promise<ProbeResult[]> {
  const r = await httpGet(`${env.NOELLE_BRIDGE_URL}/ext/build`, {
    timeoutMs: env.NOELLE_DOCTOR_HTTP_TIMEOUT_MS,
  });
  if (r.status === null) {
    return [
      mk("bridge", "build_stamp", false, "build-endpoint-unreachable", {
        error: (r.error ?? "").slice(0, 120),
      }, at),
    ];
  }
  // A responding endpoint is "ok" even with a null stamp (no build yet).
  const stamp = (r.json as { stamp?: unknown } | null)?.stamp;
  return [
    mk("bridge", "build_stamp", true, undefined, {
      stamp: typeof stamp === "string" ? stamp : null,
      http_status: r.status,
    }, at),
  ];
}

// ---------------------------------------------------------------------------
// heartbeat — per lane, from the bridge sink.
// ---------------------------------------------------------------------------

// `sinceBootMs` = how long the doctor has been running. Within the warmup grace
// (NOELLE_DOCTOR_HEARTBEAT_GRACE_MS), a lane that has NEVER sent a heartbeat is
// treated as still warming up, not faulted: right after a deploy the actuator's
// Chrome extension is still on the OLD build (no sink) until it self-reloads
// (~5 min), and the doctor itself just restarted, so an absent heartbeat is
// expected transiently. A heartbeat that was seen and then went STALE is always
// a real fault (a live extension went silent), grace or not.
export async function probeHeartbeat(env: Env, at: string, sinceBootMs: number): Promise<ProbeResult[]> {
  const r = await httpGet(`${env.NOELLE_BRIDGE_URL}/heartbeats`, {
    timeoutMs: env.NOELLE_DOCTOR_HTTP_TIMEOUT_MS,
    token: env.NOELLE_BRIDGE_TOKEN,
  });
  const out: ProbeResult[] = [];
  const sourceSlugs = Object.keys(HEARTBEAT_SOURCE_TO_TARGET);
  const inWarmup = sinceBootMs < env.NOELLE_DOCTOR_HEARTBEAT_GRACE_MS;

  if (r.status !== 200 || !r.json) {
    // 401/403 means the bridge is UP but rejecting our token — heartbeat-stale
    // detection is then silently disabled, a config fault that must not masquerade
    // as healthy. Surface it on the bridge target (NOT arm-downgraded) so the
    // `heartbeats-unauthorized` seed pages it. A null status is bridge-DOWN, which
    // the chrome_reachable probe already owns, so there we only emit the lanes
    // ok=true to keep the report complete and avoid a double-fault.
    if (r.status === 401 || r.status === 403) {
      out.push(mk("bridge", "heartbeat", false, "heartbeats-unauthorized", { http_status: r.status }, at));
    }
    for (const source of sourceSlugs) {
      out.push(
        mk(HEARTBEAT_SOURCE_TO_TARGET[source]!, "heartbeat", true, undefined, {
          note: "heartbeats-unavailable",
          http_status: r.status ?? -1,
        }, at),
      );
    }
    return out;
  }

  const sources = ((r.json as { sources?: HeartbeatStatus[] }).sources ?? []) as HeartbeatStatus[];
  const bySource = new Map(sources.map((s) => [s.source, s]));
  for (const source of sourceSlugs) {
    const target = HEARTBEAT_SOURCE_TO_TARGET[source]!;
    const hb = bySource.get(source);
    if (!hb) {
      // Never heartbeated. During the warmup grace this is expected (ext not yet
      // self-reloaded onto the sink build), so keep it ok=true; past the grace an
      // armed lane that still has NO heartbeat is a genuine "never came online"
      // fault worth paging.
      out.push(
        inWarmup
          ? mk(target, "heartbeat", true, undefined, { present: false, note: "heartbeat-warmup" }, at)
          : mk(target, "heartbeat", false, "heartbeat-absent", { present: false }, at),
      );
    } else {
      const ok = !hb.stale;
      out.push(
        mk(target, "heartbeat", ok, ok ? undefined : "heartbeat-stale", {
          present: true,
          age_ms: hb.age_ms,
          stale: hb.stale,
          state: hb.state,
        }, at),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// api_freshness (+ pipeline lane_freshness from worker_runs).
// ---------------------------------------------------------------------------

// Reuses apps/api-vm/src/routes/system.ts thresholds.
const WORKER_STALE_MS: Record<string, number> = {
  discovery: 15 * 60_000,
  classifier: 5 * 60_000,
  drafter: 5 * 60_000,
  send: 10 * 60_000,
};

interface WorkerFreshness {
  kind: string;
  lastSuccessAt: string | null;
  stale: boolean;
  staleMinutes: number | null;
}

async function readWorkerFreshness(sql: Sql, now: number): Promise<WorkerFreshness[]> {
  try {
    const rows = await sql<Array<{ worker: string; last_success_at: Date | null }>>`
      select worker, max(finished_at) filter (where error is null) as last_success_at
      from noelle.worker_runs
      group by worker
    `;
    const byKind = new Map(rows.map((r) => [r.worker, r.last_success_at]));
    return Object.keys(WORKER_STALE_MS).map((kind) => {
      const last = byKind.get(kind) ?? null;
      const lastMs = last ? new Date(last).getTime() : null;
      const ageMs = lastMs == null ? null : now - lastMs;
      // Never-ran => NOT stale (observe-only; avoids a false "stale" on a box
      // where that worker isn't deployed).
      const stale = lastMs != null && now - lastMs > (WORKER_STALE_MS[kind] ?? Infinity);
      return {
        kind,
        lastSuccessAt: lastMs == null ? null : new Date(lastMs).toISOString(),
        stale,
        staleMinutes: ageMs == null ? null : Math.round(ageMs / 60_000),
      };
    });
  } catch {
    return [];
  }
}

export async function probeApiFreshness(
  env: Env,
  sql: Sql,
  at: string,
  now: number,
): Promise<ProbeResult[]> {
  const out: ProbeResult[] = [];

  // Reachability. /api/system/status is JWT-gated; use it only when an operator
  // JWT is configured (to detect a `degraded` body), and ALWAYS fall back to the
  // unauth /health so we can tell "api-vm down" (no response) from "unauthorized".
  let reachable = false;
  let detail: string | undefined;

  if (env.NOELLE_LOCAL_OPERATOR_JWT) {
    const s = await httpGet(`${env.NOELLE_API_URL}/api/system/status`, {
      timeoutMs: env.NOELLE_DOCTOR_HTTP_TIMEOUT_MS,
      token: env.NOELLE_LOCAL_OPERATOR_JWT,
    });
    if (s.status !== null && s.status !== 401 && s.status !== 403) {
      reachable = true;
      if (s.status !== 200) detail = `status-${s.status}`;
      else if ((s.json as { ok?: unknown } | null)?.ok !== true) detail = "status-degraded";
    }
  }
  if (!reachable) {
    const h = await httpGet(`${env.NOELLE_API_URL}/health`, {
      timeoutMs: env.NOELLE_DOCTOR_HTTP_TIMEOUT_MS,
    });
    if (h.status !== null) {
      reachable = true;
      if (h.status !== 200) detail = `health-${h.status}`;
      else if ((h.json as { ok?: unknown } | null)?.ok !== true) detail = "health-degraded";
    } else {
      detail = "unreachable";
    }
  }
  const apiOk = reachable && detail === undefined;
  out.push(
    mk("api-vm", "api_freshness", apiOk, apiOk ? undefined : detail ?? "unreachable", {
      reachable,
      detail: detail ?? null,
    }, at),
  );

  // Pipeline freshness. worker_runs.worker is NOT lane-namespaced (all interns
  // write "discovery"/"classifier"/"drafter"), so this is a GLOBAL pipeline
  // signal — tagged api-vm + observe-only (no seed remediates it).
  for (const wr of await readWorkerFreshness(sql, now)) {
    out.push(
      mk("api-vm", "lane_freshness", !wr.stale, wr.stale ? "worker-stale" : undefined, {
        worker: wr.kind,
        stale_minutes: wr.staleMinutes,
        last_success_at: wr.lastSuccessAt,
      }, at),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// stuck_queue — approvals pending past their auto-send target, OR simply pending
// far too long with no target stamped.
//
// The second arm exists because the target-based rule alone was dead: the X
// intern no longer stamps auto_send_target_at, so every pending approval in the
// system is unstamped and `auto_send_target_at is not null` matched NOTHING on
// every lane. Vega sat idle for days behind a 40/day write cap with 33 approvals
// pending and the doctor never faulted. Unstamped rows therefore get their own
// (longer) age threshold so a normal short-lived queue stays quiet.
// ---------------------------------------------------------------------------

export async function probeStuckQueue(env: Env, sql: Sql, at: string): Promise<ProbeResult[]> {
  const depths = new Map<DoctorTarget, number>();
  let dbErr = false;
  try {
    const rows = await sql<Array<{ role: string; depth: number }>>`
      select ai.role, count(*)::int as depth
      from noelle.approvals a
      join noelle.agent_instances ai on ai.id = a.agent_instance_id
      where a.status = 'pending'
        and (
          (a.auto_send_target_at is not null
            and a.auto_send_target_at < now() - make_interval(mins => ${env.NOELLE_DOCTOR_STUCK_QUEUE_MIN}))
          or
          (a.auto_send_target_at is null
            and a.created_at < now() - make_interval(mins => ${env.NOELLE_DOCTOR_STUCK_QUEUE_AGE_MIN}))
        )
      group by ai.role
    `;
    for (const r of rows) {
      const t = ROLE_TO_TARGET[r.role];
      if (t) depths.set(t, Number(r.depth));
    }
  } catch {
    dbErr = true;
  }

  const out: ProbeResult[] = [];
  for (const target of LANE_TARGETS) {
    if (dbErr) {
      // fail-open: an unreadable DB must never look like a stuck queue.
      out.push(mk(target, "stuck_queue", true, undefined, { note: "db-error" }, at));
      continue;
    }
    const depth = depths.get(target) ?? 0;
    const ok = depth < env.NOELLE_DOCTOR_STUCK_QUEUE_DEPTH;
    out.push(mk(target, "stuck_queue", ok, ok ? undefined : "queue-stuck", { depth }, at));
  }
  return out;
}
