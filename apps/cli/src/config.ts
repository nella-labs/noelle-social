import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Self-host configuration + filesystem layout for the `noelle` CLI.
 *
 * Everything the CLI generates lives under NOELLE_HOME (default ~/.noelle):
 *   .env                  — runtime env shared by app / api-vm / workers
 *   config.json           — durable operator choices (this shape)
 *   ecosystem.config.cjs  — pm2 process definitions
 *   pgdata/               — Docker Postgres data volume
 *   logs/                 — pm2 + tunnel logs
 *   heartbeats/           — per-process liveness files
 *   cloudflared/          — generated tunnel config
 *   doctor/               — actuator-doctor runtime state (signatures, incidents, last-report)
 */

export type LlmProvider = "anthropic" | "openai" | "codex" | "vertex" | "bedrock";
export type PostgresMode = "docker" | "native";

/** Where the stack runs: inside a Lima guest, or natively on the host Mac. */
export type Runtime = "vm" | "native";

/** How the dashboard port is published over Tailscale. */
export type TailscaleMode = "https" | "http";

/**
 * Remote-access settings (a host-side concern). The dashboard + api-vm run
 * INSIDE the Lima VM, so they can't drive the Mac's launchd or tailscale — these
 * fields are read by the host-side `noelle expose` / `noelle autostart` commands
 * and the login LaunchAgent, NOT by anything in the VM. Stored here so the one
 * config.json stays the single source of truth.
 */
export interface RemoteAccessConfig {
  tailscale: {
    /** Expose the dashboard port over Tailscale (`tailscale serve`). */
    enabled: boolean;
    /** "https" = a ts.net cert URL; "http" = a plain port on the tailnet. */
    mode: TailscaleMode;
    /**
     * Tailnet-facing listen port. Default 443 (HTTPS root). Set a non-443 port
     * to keep the dashboard off a shared `https://<host>/` root that other apps
     * use — e.g. 8443 → https://<host>:8443/.
     */
    port: number;
    /** Last resolved public URL (e.g. https://noelle.example.ts.net:8443). */
    url: string | null;
  };
  autostart: {
    /** Login LaunchAgent installed + active (start VM + bring Noelle up). */
    enabled: boolean;
    /** Lima VM name to start on login. */
    vm: string;
    /**
     * Command run inside the VM (via `limactl shell <vm> -- bash -lc`) to bring
     * Noelle up on login. Resolved at `autostart install` time — "noelle up" if
     * the CLI is on the VM's PATH, else a `cd <repo> && node …` fallback.
     */
    vmUpCommand: string;
  };
}

export interface SelfHostConfig {
  operator: { sub: string; email: string; name: string };
  orgSlug: string;
  /** Where the stack runs. "vm" = inside Lima (rsync deploy); "native" = on this Mac (build-from-local). */
  runtime: Runtime;
  /** Operator's chosen primary LLM provider (creds live in .env, not here). */
  llmProvider: LlmProvider;
  postgres: {
    mode: PostgresMode;
    host: string;
    port: number;
    /** Database name. Self-host uses `postgres` (schema `noelle` lives inside). */
    database: string;
  };
  ports: { app: number; apiVm: number };
  workersEnabled: boolean;
  /** Local markdown vault dir for voice anchors (enables NOELLE_NELLA_BACKEND=local). */
  vaultDir?: string;
  /**
   * Comma-separated, vault-root-relative subdirs to scope drafter retrieval to
   * (e.g. "noelle-voice,content/voice-anchors,02-brand"). The drafter grounds on
   * the operator's curated voice/style instead of whatever vault doc shares
   * keywords with the post. Unset → index the whole vaultDir. Emitted as
   * NOELLE_VOICE_DIRS. No effect without vaultDir.
   */
  voiceDirs?: string;
  /**
   * Per-instance LLM spend cap for the X-intern, in cents. Default 2500 ($25) —
   * matches the dashboard's $25 minimum so the config page, the "spent this
   * month" line, and the org/instance enforcement all agree. A lower cap (e.g.
   * the old $5) froze the pipeline within a day and read inconsistently against
   * the $25-floored dashboard input. Override with `--budget-cents`.
   */
  budgetCapCents: number;
  tunnel: { enabled: boolean; hostname: string | null };
  /** Phone/remote access over Tailscale + auto-start on Mac login (host-side). */
  remoteAccess: RemoteAccessConfig;
  /**
   * Keep the VM tracking a branch: the Mac (the only GitHub-authed side) pulls,
   * rsyncs the repo into the VM, and rebuilds. A Mac launchd timer runs
   * `noelle sync` every `intervalMinutes`. Host-side; see `noelle autoupdate`.
   */
  autoUpdate: {
    enabled: boolean;
    /** Branch the VM tracks (the Mac fast-forwards to origin/<branch>). */
    branch: string;
    /** launchd poll interval in minutes. */
    intervalMinutes: number;
    /** Last <branch> sha rsynced + rebuilt into the VM (skip rebuild if same). */
    lastSyncedSha: string | null;
    /** Native only: last local HEAD sha built + restarted (skip rebuild if same). */
    lastBuiltSha: string | null;
    /**
     * Native only: consecutive deploy failures of one sha. Pages on the first
     * failure only; auto ticks hold the sha after 3 attempts until it changes.
     */
    lastFailure?: { sha: string; attempts: number } | null;
  };
}

export const DEFAULT_OPERATOR = {
  email: "operator@example.com",
  name: "Operator",
};

export function defaultConfig(): SelfHostConfig {
  return {
    operator: { ...DEFAULT_OPERATOR, sub: randomUUID() },
    orgSlug: "workspace",
    runtime: "native",
    llmProvider: "anthropic",
    postgres: { mode: "docker", host: "127.0.0.1", port: 5432, database: "postgres" },
    ports: { app: 3001, apiVm: 18791 },
    workersEnabled: false,
    budgetCapCents: 2500,
    tunnel: { enabled: false, hostname: null },
    remoteAccess: {
      tailscale: { enabled: false, mode: "https", port: 443, url: null },
      autostart: { enabled: false, vm: "default", vmUpCommand: "noelle up" },
    },
    autoUpdate: {
      enabled: false,
      branch: "main",
      intervalMinutes: 10,
      lastSyncedSha: null,
      lastBuiltSha: null,
      lastFailure: null,
    },
  };
}

/** NOELLE_HOME, the root of all generated state. */
export function noelleHome(): string {
  const raw = process.env.NOELLE_HOME;
  if (raw && raw.length > 0) return expandHome(raw);
  return resolve(homedir(), ".noelle");
}

export interface Paths {
  home: string;
  envFile: string;
  configFile: string;
  ecosystem: string;
  pgdata: string;
  logs: string;
  heartbeats: string;
  cloudflared: string;
  /** Actuator-doctor runtime state dir (signatures.json, incidents.ndjson, last-report.json). */
  doctor: string;
  /** Marker written by `noelle down`: the stack is down ON PURPOSE, so the auto tick must not self-heal it back up. Cleared by `noelle up`. */
  stackDownMarker: string;
}

export function paths(): Paths {
  const home = noelleHome();
  return {
    home,
    envFile: resolve(home, ".env"),
    configFile: resolve(home, "config.json"),
    ecosystem: resolve(home, "ecosystem.config.cjs"),
    pgdata: resolve(home, "pgdata"),
    logs: resolve(home, "logs"),
    heartbeats: resolve(home, "heartbeats"),
    cloudflared: resolve(home, "cloudflared"),
    doctor: resolve(home, "doctor"),
    stackDownMarker: resolve(home, "stack.down"),
  };
}

/** Create the NOELLE_HOME directory tree if missing. */
export function ensureHome(): Paths {
  const p = paths();
  for (const dir of [p.home, p.pgdata, p.logs, p.heartbeats, p.cloudflared, p.doctor]) {
    mkdirSync(dir, { recursive: true });
  }
