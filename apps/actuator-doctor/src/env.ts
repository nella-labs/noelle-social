import os from "node:os";
import path from "node:path";
import { z } from "zod";

// Env for the Actuator Doctor loop. Mirrors the zod loadEnv pattern in
// apps/reddit-intern/src/env.ts. Only NOELLE_DATABASE_URL is required; every
// operational knob has a sensible default so the doctor boots with zero config.

// Truthy env flag ("1"/"true", case-insensitive). Unset -> false. (z.coerce.boolean
// is unsafe here — Boolean("false") is true.)
const boolFlag = z
  .string()
  .optional()
  .transform((v) => v === "1" || (v ?? "").toLowerCase() === "true");

const HOME = os.homedir();

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),

  // The only required value. The smoke boot sets this to postgres://invalid so
  // every DB probe fails safe (fail-open to ok=true) and nothing mutates.
  NOELLE_DATABASE_URL: z.string().min(1),

  // Loop cadence.
  NOELLE_DOCTOR_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),

  // Repeat-page dedup: one open incident pages at most once per this window
  // (page_human is the terminal ladder rung, proposed every tick). 0 disables
  // dedup and restores page-every-tick.
  NOELLE_DOCTOR_REPAGE_MS: z.coerce.number().int().nonnegative().default(3_600_000),

  // Chrome Bridge control server (loopback). /health + /ext/build are open;
  // /heartbeats + /op need the bearer token.
  NOELLE_BRIDGE_URL: z.string().url().default("http://127.0.0.1:18792"),
  NOELLE_BRIDGE_TOKEN: z.string().optional(),

  // api-vm base. /health is unauth (reachability); /api/system/status is
  // JWT-gated — the operator JWT below is optional and only enriches lane
  // freshness when present (we otherwise read worker_runs directly).
  NOELLE_API_URL: z.string().url().default("http://127.0.0.1:18791"),
  NOELLE_LOCAL_OPERATOR_JWT: z.string().optional(),

  // Runtime state (signatures.json, incidents.ndjson, last-report.json).
  NOELLE_DOCTOR_STATE_DIR: z.string().default(path.join(HOME, ".noelle", "doctor")),
  // Optional explicit seed path; otherwise resolved next to this module.
  NOELLE_DOCTOR_SEED_PATH: z.string().optional(),

  // Observe + alert only, never mutate. The smoke boot sets this.
  NOELLE_DOCTOR_DRYRUN: boolFlag,
  // The LLM auto-fixer flag. OFF by default. When "1"/"true", an UNMATCHED fault
  // (a failing probe no signature covers) may spawn `claude -p` to propose a NEW
  // signature, which is strictly validated + clamped before it joins the store.
  // It only ever writes signatures (never code), and a signature can only pick
  // from the fixed, safe RemediationAction enum, so the blast radius is bounded.
  NOELLE_DOCTOR_AUTOFIX: boolFlag,
  // Escalation guardrails (only consulted when AUTOFIX is on).
  NOELLE_DOCTOR_MAX_ESCALATIONS_PER_HOUR: z.coerce.number().int().positive().default(2),
  NOELLE_DOCTOR_CLAUDE_BIN: z.string().default("claude"),
  NOELLE_DOCTOR_ESCALATE_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

  // An unconfigured reporter records faults locally without invoking a command.
  NOELLE_ALERT_CMD: z.string().default(""),
  NOELLE_DOCTOR_ALERT_CATEGORY: z.string().default("actuator-down"),

  // Global remediation brake: at most this many automated remediations/hour
  // across ALL signatures. Per-signature caps live on each Signature.maxPerHour.
  NOELLE_DOCTOR_MAX_REMEDIATIONS_PER_HOUR: z.coerce.number().int().positive().default(6),

  // Resolve the installation's CLI-bundled binary; explicit paths take precedence.
  NOELLE_PM2_BIN: z
    .string()
    .default(path.resolve(import.meta.dirname, "../../cli/node_modules/.bin/pm2")),
  // pm2 app names (match generateEcosystem() in apps/cli).
  NOELLE_BRIDGE_APP: z.string().default("chrome-bridge"),
  NOELLE_API_APP: z.string().default("noelle-api-vm"),

  // Stuck-queue thresholds: an approval still `pending` this many minutes past
  // its auto_send_target_at is "stuck"; the lane faults once at least DEPTH such
  // rows pile up.
  NOELLE_DOCTOR_STUCK_QUEUE_MIN: z.coerce.number().int().positive().default(30),
  NOELLE_DOCTOR_STUCK_QUEUE_DEPTH: z.coerce.number().int().positive().default(5),
  // Age rule for approvals with NO auto_send_target_at. The X intern stopped
  // stamping that column (drafter-tick: `const autoSend = null`), so in practice
  // EVERY pending approval is unstamped — which made the target-based rule above
  // match zero rows on every lane and left the probe dead. Vega then sat idle for
  // days with a growing queue and nothing paged. Unstamped rows use their own,
  // deliberately longer threshold so a normal short-lived pending queue stays
  // quiet while a genuinely stalled lane still faults.
  NOELLE_DOCTOR_STUCK_QUEUE_AGE_MIN: z.coerce.number().int().positive().default(120),

  // Skip/send-failure spike: more than MAX 'skip' activity rows in the trailing
  // WINDOW minutes is a fault (the actuator is trying to post and failing).
  NOELLE_DOCTOR_SEND_FAIL_MAX: z.coerce.number().int().positive().default(8),
  NOELLE_DOCTOR_SEND_FAIL_WINDOW_MIN: z.coerce.number().int().positive().default(60),

  // HTTP probe timeout (bridge + api-vm fetches).
  NOELLE_DOCTOR_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  // Heartbeat warmup grace: after the doctor boots (which coincides with a
  // deploy), an armed actuator lane that has NEVER heartbeated is tolerated for
  // this long — its Chrome extension is still on the pre-deploy build until it
  // self-reloads onto the one with the sink (~5 min). Past it, a still-absent
  // heartbeat is a real fault. A heartbeat that went STALE (was alive) faults
  // immediately regardless. Also used as the ext-connection warmup for
  // chrome_reachable. Default 15 min.
  NOELLE_DOCTOR_HEARTBEAT_GRACE_MS: z.coerce.number().int().positive().default(900_000),

  // Operating window (local hours, [start, end)) — the hours the browser
  // actuators are EXPECTED to be up. Outside it, Chrome being closed / the
  // extension disconnected / an armed lane not heartbeating / approvals not
  // draining are all EXPECTED (you close Chrome overnight), so those
  // browser-actuation faults are downgraded to observe-only and never page. The
  // 24/7 infra faults (db_reachable, api_freshness, worker pm2) still page
  // anytime. A wrapping window (e.g. start 22, end 6) is supported. Default
  // 8:00–23:00. Set start=0 end=24 to treat every hour as in-window.
  NOELLE_DOCTOR_ACTIVE_START_HOUR: z.coerce.number().int().min(0).max(24).default(8),
  NOELLE_DOCTOR_ACTIVE_END_HOUR: z.coerce.number().int().min(0).max(24).default(23),

  // Idle-gate escape hatch. By default a pure connectivity fault (an armed
  // lane's heartbeat, the bridge ext-disconnect) is downgraded to observe-only
  // while NO due browser work is waiting (readBrowserDue: stamped-due
  // linkedin/reddit approvals; X's stamped rows are API-autosend-owned and its
  // browser queue is operator-initiated, so X never counts) — a closed Chrome
  // on an idle lane is the operator's choice, not an emergency. Activity
  // faults (stuck_queue, send_failures), bridge-unreachable, and the 24/7
  // infra faults are unaffected. Set "1" to restore
  // page-on-any-disconnect-while-armed.
  NOELLE_DOCTOR_PAGE_WHEN_IDLE: boolFlag,

  // incidents.ndjson rotates to a single .1 backup past this size.
  NOELLE_DOCTOR_STATE_MAX_BYTES: z.coerce.number().int().positive().default(5_000_000),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;
  cached = EnvSchema.parse(process.env);
  return cached;
}

export function resetEnvForTests() {
  cached = undefined;
}
