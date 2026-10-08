import type { Sql } from "postgres";
import type {
  DoctorReport,
  DoctorTarget,
  Incident,
  RemediationAction,
} from "@noelle/contracts";
import { makeAlert, type AlertFn } from "./alert.js";
import { noelleDb } from "./db.js";
import { loadEnv, type Env } from "./env.js";
import { maybeEscalate } from "./escalate.js";
import { httpPostJson } from "./http.js";
import { appendIncident, updateIncident, writeLastReport } from "./incidents.js";
import { createLogger, type Logger } from "./logger.js";
import { pm2List, restartApp } from "./pm2.js";
import {
  applyArmAwareness,
  isInOperatingWindow,
  offlineAppsFor,
  readArmState,
  readBrowserDue,
  runAllProbes,
  type ArmState,
} from "./probes.js";
import {
  decideAction,
  isMutating,
  makeBridgeRemediator,
  makeDbRemediator,
  remediate,
  RollingCounter,
  type BridgeRemediator,
  type DbRemediator,
  type RemediateCtx,
} from "./remediate.js";
import {
  bumpSignatureOnMatch,
  loadSignatureStore,
  markSignatureResolved,
  matchSignatures,
  persistStore,
  topMatchPerTarget,
} from "./signatures.js";
import { ALL_TARGETS } from "./targets.js";
import type { ProbeResult, SignatureStore } from "@noelle/contracts";

// The Actuator Doctor loop. Each tick: probe -> arm-aware downgrade -> match
// signatures -> verify/resolve prior incidents -> remediate current faults on the
// capped ladder -> persist state + last-report -> stamp own liveness. Everything
// is fail-soft: a tick that throws is logged + alerted, and the loop continues.

// Doctor process boot time — drives the heartbeat warmup grace (an armed lane
// that has never heartbeated is tolerated for a window after boot, covering the
// post-deploy window before the actuator's Chrome extension self-reloads onto
// the sink build). Reset on every restart, which is exactly when a deploy lands.
const BOOT_MS = Date.now();

// In-memory ladder state per target (survives across ticks within one process).
interface OpenIncident {
  signatureId: string;
  lastAction: RemediationAction;
  incident: Incident;
  capped: boolean;
  /** When this incident last paged a human — drives repeat-page dedup. */
  pagedAt?: number;
}

interface TickContext {
  env: Env;
  sql: Sql;
  logger: Logger;
  alert: AlertFn;
  store: SignatureStore;
  counter: RollingCounter;
  openIncidents: Map<DoctorTarget, OpenIncident>;
  bridgeRemediator: BridgeRemediator;
  dbRemediator: DbRemediator;
  tick: number;
}

function buildReport(cx: {
  tick: number;
  now: number;
  probes: ProbeResult[];
  arm: ArmState;
  openIncidents: Map<DoctorTarget, OpenIncident>;
  counter: RollingCounter;
  store: SignatureStore;
  env: Env;
  inWindow: boolean;
}): DoctorReport {
  const targets = ALL_TARGETS.map((target) => ({
    target,
    healthy: !cx.openIncidents.has(target),
    armed: cx.arm[target]?.armed ?? false,
    // Whether the browser actuators are expected to be up now (operating hours).
    // Off-hours, a closed Chrome / disconnected extension is expected, not a fault.
    inWindow: cx.inWindow,
    probes: cx.probes.filter((p) => p.target === target),
    openIncident: cx.openIncidents.get(target)?.incident ?? null,
  }));
  const remediationsThisHour: Record<string, number> = {};
  for (const s of cx.store.signatures) {
    const c = cx.counter.count(s.id, cx.now);
    if (c > 0) remediationsThisHour[s.id] = c;
  }
  return {
    at: new Date(cx.now).toISOString(),
    tick: cx.tick,
    healthy: cx.openIncidents.size === 0,
    targets,
    remediationsThisHour,
    autofixEnabled: cx.env.NOELLE_DOCTOR_AUTOFIX,
  };
}

async function stampHeartbeat(env: Env, nowIso: string): Promise<void> {
  // Loopback-open ingest (no token). httpPostJson never rejects.
  await httpPostJson(
    `${env.NOELLE_BRIDGE_URL}/ingest/heartbeat`,
    { source: "actuator-doctor", at: nowIso, state: "running" },
    { timeoutMs: env.NOELLE_DOCTOR_HTTP_TIMEOUT_MS },
  );
}

async function recordDoctorRun(sql: Sql, rows: number): Promise<void> {
  try {
    // A finished-immediately worker_runs row (worker='actuator-doctor') so
    // infra-health / freshness views see the doctor as live. Fail-open on a DB
    // outage — the pm2 app + heartbeat still make it observable.
    await sql`
      insert into noelle.worker_runs (worker, finished_at, rows_processed, error)
      values ('actuator-doctor', now(), ${rows}, null)
    `;
  } catch {
    // swallow
  }
}

async function runTick(cx: TickContext): Promise<void> {
  const { env, sql, logger, alert, store, counter, openIncidents } = cx;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const cat = env.NOELLE_DOCTOR_ALERT_CATEGORY;

  // Are the actuators expected to be up right now? Outside the operating window
  // (Chrome closed overnight) or during the post-deploy warmup, browser-actuation
  // faults are expected and get downgraded to observe-only (never page).
  const inWindow = isInOperatingWindow(
    now,
    env.NOELLE_DOCTOR_ACTIVE_START_HOUR,
    env.NOELLE_DOCTOR_ACTIVE_END_HOUR,
  );
  const inWarmup = now - BOOT_MS < env.NOELLE_DOCTOR_HEARTBEAT_GRACE_MS;

  // Probe -> arm-aware downgrade -> match.
  const pm2Apps = await pm2List(env);
  const rawProbes = await runAllProbes({ env, sql, now, pm2Apps, startedAt: BOOT_MS });
  const arm = await readArmState(sql);
  // Idle gate: connectivity faults only page while browser work is actually due
  // (a closed Chrome on an idle lane is deliberate). null — from the flag or a
  // failed due-read — disables the gate, failing toward the old paging behavior.
  const pendingDue = env.NOELLE_DOCTOR_PAGE_WHEN_IDLE ? null : await readBrowserDue(sql);
  const probes = applyArmAwareness(rawProbes, arm, { inWindow, inWarmup, pendingDue });
  const byTarget = topMatchPerTarget(matchSignatures(store, probes));

  // 1) Verify prior open incidents: a target whose fault is GONE (or changed
  //    signature) this tick is resolved.
  for (const [target, open] of [...openIncidents.entries()]) {
    const still = byTarget.get(target);
    if (!still || still.signature.id !== open.signatureId) {
      // An incident whose fault went away because the IDLE GATE swallowed it
      // (the due browser work drained while the actuator stayed down) is not a
      // recovery: it proves nothing about the last remediation, teaches the
      // signature store nothing, and needs no RESOLVED page.
      const idleResolved = probes.some(
        (p) => p.target === target && p.metrics.downgraded_reason === "idle",
      );
      const resolvedActionOk = idleResolved
        ? open.incident.actionOk
        : open.lastAction === "page_human" || open.lastAction === "none"
          ? open.incident.actionOk
          : true; // a mutating rung that was followed by the fault clearing = it worked
      const resolved: Incident = {
        ...open.incident,
        resolved: true,
        actionOk: resolvedActionOk,
        verifiedAt: nowIso,
      };
      updateIncident(env, resolved);
      if (!idleResolved) {
        markSignatureResolved(store, open.signatureId);
        await alert(cat, `[doctor] RESOLVED ${target} (${open.signatureId}) after ${open.lastAction}`);
      }
      openIncidents.delete(target);
      logger.info(
        { target, signature: open.signatureId, lastAction: open.lastAction, idleResolved },
        "incident resolved",
      );
    }
  }

  // 2) Handle current faults — one incident per target, climbing the ladder.
  for (const [target, match] of byTarget.entries()) {
    bumpSignatureOnMatch(store, match.signature.id, nowIso);
    const prior = openIncidents.get(target);
    const continuing = prior && prior.signatureId === match.signature.id;
    const lastAction = continuing ? prior.lastAction : null;

    const { action, capped } = decideAction({
      ladder: match.signature.ladder,
      lastAction,
      counter,
      signatureId: match.signature.id,
      maxPerHour: match.signature.maxPerHour,
      globalCap: env.NOELLE_DOCTOR_MAX_REMEDIATIONS_PER_HOUR,
      now,
      lastPagedAt: continuing ? prior.pagedAt ?? null : null,
      repageMs: env.NOELLE_DOCTOR_REPAGE_MS,
    });

    const ctx: RemediateCtx = {
      target,
      signatureId: match.signature.id,
      appsToRestart: offlineAppsFor(target, probes),
      instanceIds: arm[target]?.instanceIds ?? [],
    };
    const res = await remediate(action, ctx, {
      env,
      alert,
      logger,
      pm2: { restartApp: (name) => restartApp(env, name) },
      bridge: cx.bridgeRemediator,
      db: cx.dbRemediator,
    });

    // Count only actions that actually mutated (not dry-run, not page_human).
    if (isMutating(action) && !env.NOELLE_DOCTOR_DRYRUN && res.mutated) {
      counter.record(match.signature.id, now);
    }

    const incident: Incident = {
      id: continuing ? prior.incident.id : `${nowIso}::${target}`,
      at: nowIso,
      target,
      signatureId: match.signature.id,
      summary: `${match.signature.title} on ${target}${capped ? " [capped -> page]" : ""}`,
      probes: probes.filter((p) => p.target === target),
      actionTaken: action,
      // null = awaiting verification next tick; false only if the action itself failed.
      actionOk: env.NOELLE_DOCTOR_DRYRUN ? null : res.ok ? null : false,
      verifiedAt: null,
      resolved: false,
      escalated: false,
    };
    appendIncident(env, incident);
    // "none" from decideAction means a deduped repeat page: keep the ladder's
    // real lastAction (nextRung restarts the ladder on an unknown action) and
    // the original page stamp. A real page refreshes the stamp.
    const dedupedPage = action === "none" && continuing;
    openIncidents.set(target, {
      signatureId: match.signature.id,
      lastAction: dedupedPage ? prior.lastAction : action,
      incident,
      capped,
      pagedAt: action === "page_human" ? now : continuing ? prior.pagedAt : undefined,
    });

    logger.warn(
      { target, signature: match.signature.id, action, capped, ok: res.ok, dryrun: env.NOELLE_DOCTOR_DRYRUN },
      "fault handled",
    );
  }

  // Escalation pass (OFF by default; NOELLE_DOCTOR_AUTOFIX). Sees the full tick:
  // an UNMATCHED fault (a failing probe no signature covers) may spawn `claude -p`
  // to propose a strictly-validated new signature. No-op unless autofix is on.
  await maybeEscalate({
    env,
    store,
    logger,
    alert,
    probes,
    matchedTargets: new Set(byTarget.keys()),
    nowIso,
  });

  persistStore(env, store);
  writeLastReport(
    env,
    buildReport({ tick: cx.tick, now, probes, arm, openIncidents, counter, store, env, inWindow }),
  );

  await stampHeartbeat(env, nowIso);
  await recordDoctorRun(sql, probes.length);

  logger.info(
    { tick: cx.tick, faults: byTarget.size, open: openIncidents.size, dryrun: env.NOELLE_DOCTOR_DRYRUN },
    "tick complete",
  );
}

// A sleep that a signal can interrupt, so SIGTERM stops the loop promptly.
function makeSleeper() {
  let wake: (() => void) | null = null;
  return {
    sleep(ms: number): Promise<void> {
      return new Promise((resolve) => {
        const t = setTimeout(() => {
          wake = null;
          resolve();
        }, ms);
        wake = () => {
          clearTimeout(t);
          wake = null;
          resolve();
        };
      });
    },
    wake() {
      wake?.();
    },
  };
}

function emptyReport(env: Env): DoctorReport {
  return {
    at: new Date().toISOString(),
    tick: 0,
    healthy: true,
    targets: ALL_TARGETS.map((target) => ({
      target,
      healthy: true,
      armed: false,
      inWindow: true,
      probes: [],
      openIncident: null,
    })),
    remediationsThisHour: {},
    autofixEnabled: env.NOELLE_DOCTOR_AUTOFIX,
  };
}

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({ kind: "actuator-doctor", workerId: "0" });
  const alert = makeAlert({ cmd: env.NOELLE_ALERT_CMD, dryrun: env.NOELLE_DOCTOR_DRYRUN, logger });
  const sql = noelleDb();
  const store = loadSignatureStore(env);
  const counter = new RollingCounter();
  const openIncidents = new Map<DoctorTarget, OpenIncident>();
  const bridgeRemediator = makeBridgeRemediator(env);
  const dbRemediator = makeDbRemediator(sql);
  const sleeper = makeSleeper();

  let stopping = false;
  const onStop = (sig: string) => {
    logger.info({ sig }, "signal received; stopping after this tick");
    stopping = true;
    sleeper.wake();
  };
  process.on("SIGTERM", () => onStop("SIGTERM"));
  process.on("SIGINT", () => onStop("SIGINT"));

  logger.info(
    {
      dryrun: env.NOELLE_DOCTOR_DRYRUN,
      intervalMs: env.NOELLE_DOCTOR_INTERVAL_MS,
      bridge: env.NOELLE_BRIDGE_URL,
      api: env.NOELLE_API_URL,
      stateDir: env.NOELLE_DOCTOR_STATE_DIR,
      signatures: store.signatures.length,
    },
    "actuator-doctor starting",
  );

  // Always leave a last-report.json on disk, even before tick 1 finishes.
  writeLastReport(env, emptyReport(env));

  let tick = 0;
  while (!stopping) {
    tick++;
    try {
      await runTick({
        env,
        sql,
        logger,
        alert,
        store,
        counter,
        openIncidents,
        bridgeRemediator,
        dbRemediator,
        tick,
      });
    } catch (e) {
      logger.error({ err: String(e) }, "tick failed (loop continues)");
      await alert(env.NOELLE_DOCTOR_ALERT_CATEGORY, `[doctor] tick error: ${String(e).slice(0, 160)}`);
    }
    if (stopping) break;
    await sleeper.sleep(env.NOELLE_DOCTOR_INTERVAL_MS);
  }

  logger.info("actuator-doctor stopped");
  try {
    await sql.end({ timeout: 5 });
  } catch {
    // ignore
  }
  process.exit(0);
}

main().catch((e) => {
  // Last-resort: never exit silently.
  console.error("actuator-doctor fatal:", e);
  process.exit(1);
});
