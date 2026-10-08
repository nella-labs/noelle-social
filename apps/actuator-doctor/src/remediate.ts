import type { Sql } from "postgres";
import { ACTUATOR_EXTENSION_NAMES, type ChromeOpResult, type DoctorTarget, type RemediationAction } from "@noelle/contracts";
import type { AlertFn } from "./alert.js";
import type { Env } from "./env.js";
import { httpPostJson } from "./http.js";
import type { Logger } from "./logger.js";
import type { RestartResult } from "./pm2.js";
import { DEFAULT_RESTART_APPS } from "./targets.js";

// The remediation ladder + the hourly caps that bound it.
//
// The PURE core (RollingCounter, nextRung, decideAction, isMutating) carries the
// cap logic and is unit-tested without any pm2/DB/HTTP. remediate() performs the
// side effects through injected deps so tests substitute fakes. Two invariants:
//   - DRYRUN suppresses every mutation (pm2/DB/ext) — alert-only.
//   - engage_kill_switch is FAIL-CLOSED (stops sending) and ALWAYS alerts.

// ---------------------------------------------------------------------------
// Pure cap logic.
// ---------------------------------------------------------------------------

const HOUR_MS = 3_600_000;

// A rolling one-hour event counter, keyed by signature id (plus an implicit
// global via total()). In-memory only: a doctor restart resets the window, which
// is fine — a fresh process should be free to act.
export class RollingCounter {
  private events = new Map<string, number[]>();
  constructor(private readonly windowMs: number = HOUR_MS) {}

  private prune(key: string, now: number): number[] {
    const arr = (this.events.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.events.set(key, arr);
    return arr;
  }

  count(key: string, now: number): number {
    return this.prune(key, now).length;
  }

  total(now: number): number {
    let n = 0;
    for (const key of [...this.events.keys()]) n += this.prune(key, now).length;
    return n;
  }

  record(key: string, now: number): void {
    const arr = this.prune(key, now);
    arr.push(now);
    this.events.set(key, arr);
  }
}

export function isMutating(a: RemediationAction): boolean {
  return (
    a === "reload_extension" ||
    a === "reconnect_bridge" ||
    a === "restart_worker" ||
    a === "engage_kill_switch"
  );
}

export function canRemediate(
  counter: RollingCounter,
  signatureId: string,
  maxPerHour: number,
  globalCap: number,
  now: number,
): boolean {
  if (counter.count(signatureId, now) >= maxPerHour) return false;
  if (counter.total(now) >= globalCap) return false;
  return true;
}

// The next rung to try: the first rung for a new fault, else one step past the
// last action, clamped to the final rung (ladders end at page_human).
export function nextRung(
  ladder: RemediationAction[],
  last: RemediationAction | null,
): RemediationAction {
  if (last === null) return ladder[0] ?? "page_human";
  const i = ladder.indexOf(last);
  if (i < 0) return ladder[0] ?? "page_human";
  return ladder[Math.min(i + 1, ladder.length - 1)] ?? "page_human";
}

export interface DecideArgs {
  ladder: RemediationAction[];
  lastAction: RemediationAction | null;
  counter: RollingCounter;
  signatureId: string;
  maxPerHour: number;
  globalCap: number;
  now: number;
  /** When this open incident last paged a human (ms epoch), if ever. */
  lastPagedAt?: number | null;
  /** Minimum gap between repeat pages for ONE incident. 0 disables dedup. */
  repageMs?: number;
}

// Choose the action for this tick. A mutating rung that would breach the
// per-signature or global cap is replaced by a one-shot page_human (capped=true),
// so a flapping fault pages a human instead of hammering pm2/the DB forever.
// page_human is the TERMINAL rung, so an incident that stays open proposes it
// every tick — dedup it per incident (page once, re-page after repageMs) or a
// 60s tick spams the operator's phone once a minute until someone intervenes.
// A suppressed page returns "none"; the caller must NOT overwrite the ladder's
// lastAction with it (an unknown lastAction restarts the ladder from rung 0).
export function decideAction(a: DecideArgs): { action: RemediationAction; capped: boolean } {
  const proposed = nextRung(a.ladder, a.lastAction);
  let action = proposed;
  let capped = false;
  if (isMutating(proposed) && !canRemediate(a.counter, a.signatureId, a.maxPerHour, a.globalCap, a.now)) {
    action = "page_human";
    capped = true;
  }
  if (action === "page_human" && pageIsDeduped(a)) return { action: "none", capped };
  return { action, capped };
}

/** Pure: has this incident already paged within the repage window? */
function pageIsDeduped(a: DecideArgs): boolean {
  const gap = a.repageMs ?? 0;
  if (gap <= 0 || a.lastPagedAt == null) return false;
  return a.now - a.lastPagedAt < gap;
}

// ---------------------------------------------------------------------------
// Side-effecting remediation (injected deps).
// ---------------------------------------------------------------------------

export interface BridgeRemediator {
  reloadExtension(target?: DoctorTarget): Promise<{ ok: boolean; fallback: boolean; mutated?: boolean; detail?: string }>;
}

export interface DbRemediator {
  engageKillSwitch(instanceIds: string[]): Promise<{ ok: boolean; count: number; detail?: string }>;
}

export interface RemediateDeps {
  env: Env;
  alert: AlertFn;
  logger: Logger;
  pm2: { restartApp: (name: string) => Promise<RestartResult> };
  bridge: BridgeRemediator;
  db: DbRemediator;
}

export interface RemediateCtx {
  target: DoctorTarget;
  signatureId: string;
  appsToRestart: string[];
  instanceIds: string[];
}

export interface RemediateResult {
  ok: boolean;
  mutated: boolean;
  detail?: string;
}

function defaultRestartApps(target: DoctorTarget, env: Env): string[] {
  if (target === "api-vm") return [env.NOELLE_API_APP];
  if (target === "bridge") return [env.NOELLE_BRIDGE_APP];
  return DEFAULT_RESTART_APPS[target];
}

export async function remediate(
  action: RemediationAction,
  ctx: RemediateCtx,
  deps: RemediateDeps,
): Promise<RemediateResult> {
  const { env, alert, logger } = deps;
  const cat = env.NOELLE_DOCTOR_ALERT_CATEGORY;

  if (action === "none") return { ok: true, mutated: false };

  if (action === "page_human") {
    await alert(cat, `[doctor] PAGE: ${ctx.target} / ${ctx.signatureId} — no automated step left (or cap hit)`);
    return { ok: true, mutated: false };
  }

  // Everything below MUTATES. DRYRUN => alert the intent, touch NOTHING.
  if (env.NOELLE_DOCTOR_DRYRUN) {
    logger.warn(
      { action, target: ctx.target, signatureId: ctx.signatureId, dryrun: true },
      "remediation suppressed (dry-run)",
    );
    await alert(cat, `[doctor] DRY-RUN would ${action} on ${ctx.target} (${ctx.signatureId})`);
    return { ok: true, mutated: false, detail: "dry-run" };
  }

  switch (action) {
    case "reload_extension": {
      const r = await deps.bridge.reloadExtension(ctx.target);
      if (r.ok) {
        await alert(cat, `[doctor] reload_extension ok (${ctx.target})`);
        return { ok: true, mutated: true };
      }
      if (r.fallback) {
