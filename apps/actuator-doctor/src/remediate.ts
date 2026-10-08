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
        // The reload path is unavailable — fall back to bouncing the bridge.
        const rb = await deps.pm2.restartApp(env.NOELLE_BRIDGE_APP);
        await alert(
          cat,
          `[doctor] reload_extension unavailable (${r.detail ?? ""}); reconnect_bridge ${rb.ok ? "ok" : "FAILED " + (rb.detail ?? "")}`,
        );
        return { ok: rb.ok, mutated: true, detail: "reload->reconnect fallback" };
      }
      await alert(cat, `[doctor] reload_extension FAILED (${ctx.target}): ${r.detail ?? ""}`);
      return { ok: false, mutated: r.mutated ?? true, detail: r.detail };
    }

    case "reconnect_bridge": {
      const r = await deps.pm2.restartApp(env.NOELLE_BRIDGE_APP);
      await alert(
        cat,
        `[doctor] reconnect_bridge (restart ${env.NOELLE_BRIDGE_APP}) ${r.ok ? "ok" : "FAILED " + (r.detail ?? "")}`,
      );
      return { ok: r.ok, mutated: true };
    }

    case "restart_worker": {
      const apps = ctx.appsToRestart.length > 0 ? ctx.appsToRestart : defaultRestartApps(ctx.target, env);
      let allOk = apps.length > 0;
      const results: string[] = [];
      for (const app of apps) {
        const r = await deps.pm2.restartApp(app);
        allOk = allOk && r.ok;
        results.push(`${app}:${r.ok ? "ok" : "fail"}`);
      }
      await alert(cat, `[doctor] restart_worker (${ctx.target}) ${results.join(" ") || "no-apps"}`);
      return { ok: allOk, mutated: true, detail: results.join(" ") };
    }

    case "engage_kill_switch": {
      // FAIL-CLOSED brake: reply_send_enabled=false stops ALL posting on the lane.
      // Always alert — a human must know the doctor pulled the brake.
      const r = await deps.db.engageKillSwitch(ctx.instanceIds);
      await alert(
        cat,
        `[doctor] ENGAGED KILL SWITCH on ${ctx.target}: reply_send_enabled=false for ${r.count} instance(s) — sending STOPPED${r.ok ? "" : ` (DB error: ${r.detail ?? ""})`}`,
      );
      return { ok: r.ok, mutated: true, detail: `kill-switch count=${r.count}` };
    }
  }

  return { ok: false, mutated: false, detail: "unknown-action" };
}

// ---------------------------------------------------------------------------
// Real remediator implementations (index.ts wires these; tests inject fakes).
// ---------------------------------------------------------------------------

function extractExtId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  // meta.info's shape is the extension's; probe the likely fields defensively.
  const candidates = [
    v.extId,
    v.id,
    (v.ext as Record<string, unknown> | undefined)?.id,
    (v.extension as Record<string, unknown> | undefined)?.id,
  ];
  for (const c of candidates) if (typeof c === "string" && c.length > 0) return c;
  return null;
}

export function makeBridgeRemediator(env: Env): BridgeRemediator {
  const base = env.NOELLE_BRIDGE_URL;
  const opts = { timeoutMs: env.NOELLE_DOCTOR_HTTP_TIMEOUT_MS, token: env.NOELLE_BRIDGE_TOKEN };
  return {
    async reloadExtension(target = "bridge") {
      let extId: string | null;
      if (target !== "bridge") {
        const name = ACTUATOR_EXTENSION_NAMES[target as keyof typeof ACTUATOR_EXTENSION_NAMES];
        if (!name) return { ok: false, fallback: false, mutated: false, detail: "target-has-no-extension" };
        const listed = await httpPostJson(`${base}/op`, { op: "ext.list" }, opts);
        const result = listed.json as ChromeOpResult | null;
        if (listed.status !== 200 || result?.ok !== true || !Array.isArray(result.value)) {
          return { ok: false, fallback: false, mutated: false, detail: "extension-list-unavailable" };
        }
        const matches = result.value.filter((entry): entry is { id: string } => {
          if (!entry || typeof entry !== "object") return false;
          const e = entry as Record<string, unknown>;
          return e.name === name && e.enabled === true && e.installType === "development" && e.mayDisable === true
            && typeof e.id === "string" && e.id.length > 0;
        });
        if (matches.length !== 1) return { ok: false, fallback: false, mutated: false, detail: "extension-target-not-unique" };
        extId = matches[0]!.id;
      } else {
        const info = await httpPostJson(`${base}/op`, { op: "meta.info" }, opts);
        if (info.status !== 200 || !info.json) {
          return { ok: false, fallback: true, detail: `meta.info http ${info.status ?? "unreachable"}` };
        }
        const infoRes = info.json as ChromeOpResult;
        extId = infoRes.ok ? extractExtId(infoRes.value) : null;
        if (!extId) return { ok: false, fallback: true, detail: "no ext id from meta.info" };
      }
      const rel = await httpPostJson(`${base}/op`, { op: "ext.reload", extId }, opts);
      const relRes = (rel.json ?? null) as ChromeOpResult | null;
      const value = relRes?.value as { reloaded?: unknown } | undefined;
      const ok = rel.status === 200 && relRes?.ok === true && value?.reloaded === extId;
      return { ok, fallback: !ok && target === "bridge", mutated: true,
        detail: ok ? undefined : `ext.reload receipt unavailable (${rel.status ?? "unreachable"})` };
    },
  };
}

export function makeDbRemediator(sql: Sql): DbRemediator {
  return {
    async engageKillSwitch(instanceIds: string[]) {
      if (instanceIds.length === 0) return { ok: true, count: 0 };
      try {
        const rows = await sql<Array<{ id: string }>>`
          update noelle.agent_instances
          set reply_send_enabled = false
          where id = any(${instanceIds}::uuid[]) and reply_send_enabled = true
          returning id
        `;
        return { ok: true, count: rows.length };
      } catch (e) {
        return { ok: false, count: 0, detail: String(e).slice(0, 160) };
      }
    },
  };
}
