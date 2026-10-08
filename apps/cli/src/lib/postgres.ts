import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import type { SelfHostConfig } from "../config.js";
import { run, type ContainerRuntime } from "./platform.js";

/**
 * Local Postgres 16 provisioning + connection helpers.
 *
 * Self-host uses the default `postgres` database with the `noelle` schema
 * inside it (matching the schema's grants, e.g. `grant connect on database
 * postgres`). The CLI applies DDL as the `postgres` superuser; the app/api-vm
 * connect as the least-privilege `noelle_app` role (created by 0001).
 */

export const DOCKER_CONTAINER = "noelle-pg";
export const DOCKER_IMAGE = "postgres:16";

/** Superuser connection string (DDL + role/password management). */
export function composeAdminUrl(config: SelfHostConfig, rootPassword: string): string {
  const { host, port } = config.postgres;
  return `postgres://postgres:${encodeURIComponent(rootPassword)}@${host}:${port}/postgres`;
}

/** noelle_app runtime connection string written into NOELLE_DATABASE_URL. */
export function composeAppUrl(config: SelfHostConfig, appPassword: string): string {
  const { host, port, database } = config.postgres;
  return `postgres://noelle_app:${encodeURIComponent(appPassword)}@${host}:${port}/${database}?sslmode=disable`;
}

/**
 * Ensure a containerized Postgres is running, via the given runtime (docker or
 * nerdctl — both share this CLI surface). Idempotent: starts an existing
 * container, or runs a fresh one with a persistent data volume.
 */
export async function ensureContainerPostgres(args: {
  runtime: ContainerRuntime;
  config: SelfHostConfig;
  rootPassword: string;
  pgdataDir: string;
  log: (msg: string) => void;
}): Promise<void> {
  const { runtime, config, rootPassword, pgdataDir, log } = args;
  const inspect = await run(runtime, ["inspect", "-f", "{{.State.Running}}", DOCKER_CONTAINER], {
    allowFailure: true,
  });
  if (inspect.code === 0) {
    if (inspect.stdout.trim() === "true") {
      log(`Postgres container "${DOCKER_CONTAINER}" already running (${runtime}).`);
      return;
    }
    log(`Starting existing Postgres container "${DOCKER_CONTAINER}" (${runtime})…`);
    await run(runtime, ["start", DOCKER_CONTAINER]);
    return;
  }
  log(`Running Postgres ${DOCKER_IMAGE} as "${DOCKER_CONTAINER}" (${runtime})…`);
  await run(runtime, [
    "run",
    "-d",
    "--name",
    DOCKER_CONTAINER,
    "-e",
    `POSTGRES_PASSWORD=${rootPassword}`,
    "-p",
    `${config.postgres.host}:${config.postgres.port}:5432`,
    "-v",
    `${pgdataDir}:/var/lib/postgresql/data`,
    "--restart",
    "unless-stopped",
    DOCKER_IMAGE,
  ]);
}

/** Stop (and optionally remove) the containerized Postgres. */
export async function stopContainerPostgres(
  runtime: ContainerRuntime,
  remove: boolean,
): Promise<void> {
  await run(runtime, ["stop", DOCKER_CONTAINER], { allowFailure: true });
  if (remove) await run(runtime, ["rm", DOCKER_CONTAINER], { allowFailure: true });
}

/** Poll until Postgres accepts a `select 1`, or throw after timeoutMs. */
export async function waitForPostgres(adminUrl: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    const sql = postgres(adminUrl, { max: 1, ssl: false, onnotice: () => {}, connect_timeout: 5 });
    try {
      await sql`select 1 as ok`;
      await sql.end({ timeout: 1 });
      return;
    } catch (err) {
      lastErr = err;
      await sql.end({ timeout: 1 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`Postgres not ready after ${timeoutMs}ms: ${String(lastErr)}`);
}

// ---------------------------------------------------------------------------
// Native (Homebrew) Postgres self-recovery. An unclean shutdown leaves a stale
// postmaster.pid behind; after a reboot the pid recorded in it can be recycled
// by an unrelated process, so Postgres refuses to start ("lock file already
// exists") and the brew KeepAlive loop retries every 10s forever without ever
// succeeding. Clearing a provably stale lock unblocks it.
// ---------------------------------------------------------------------------

/** Homebrew service the native-mode Postgres runs under. */
export const NATIVE_PG_SERVICE = "postgresql@16";

/** Candidate data dirs for the native service (Apple Silicon + Intel brew). */
export function nativePgDataDirs(service: string = NATIVE_PG_SERVICE): string[] {
  const override = process.env.NOELLE_PG_DATA_DIR;
  if (override) return [override];
  return [`/opt/homebrew/var/${service}`, `/usr/local/var/${service}`];
}

/** Pure: pid recorded on the first line of a postmaster.pid file, or null. */
export function parsePostmasterPid(content: string): number | null {
  const first = content.split("\n", 1)[0]?.trim() ?? "";
  if (!/^\d+$/.test(first)) return null;
  const pid = Number(first);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Pure: is the lock stale? The holder must be a LIVE process whose command
 * looks like postgres. A dead pid, or a recycled pid now owned by an unrelated
 * process (seen live: an Apple audio service after a reboot), means no
 * postmaster is running and the lock is safe to clear. An alive pid whose
 * command could not be read stays untouched — never clear a lock that might
 * belong to a running postmaster.
 */
export function postmasterLockIsStale(holder: {
  alive: boolean;
  command: string | null;
}): boolean {
  if (!holder.alive) return true;
  if (holder.command === null) return false;
  return !holder.command.toLowerCase().includes("postgres");
}

/** Signal-0 liveness probe; EPERM still means the pid exists. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function brewBin(): string {
  for (const p of ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]) {
    if (existsSync(p)) return p;
  }
  return "brew";
}

export interface NativePgRecovery {
  clearedStaleLock: boolean;
  kickedService: boolean;
  detail: string;
}

/**
 * Best-effort native Postgres recovery, called when the :5432 probe fails in
 * native mode. Clears a provably stale postmaster.pid, then (re)starts the
 * Homebrew service (darwin only). Fail-open everywhere — the caller's
 * `waitForPostgres` is what decides success.
 */
export async function recoverNativePostgres(args: {
  log: (msg: string) => void;
  service?: string;
}): Promise<NativePgRecovery> {
  const service = args.service ?? process.env.NOELLE_PG_SERVICE ?? NATIVE_PG_SERVICE;
  let cleared = false;
  for (const dir of nativePgDataDirs(service)) {
    const pidFile = join(dir, "postmaster.pid");
    if (!existsSync(pidFile)) continue;
    let pid: number | null = null;
    try {
      pid = parsePostmasterPid(readFileSync(pidFile, "utf8"));
    } catch {
      continue;
    }
    const alive = pid !== null && processAlive(pid);
    let command: string | null = null;
    if (pid !== null && alive) {
      const ps = await run("ps", ["-p", String(pid), "-o", "comm="], { allowFailure: true });
      command = ps.code === 0 ? ps.stdout.trim() : null;
    }
    if (pid !== null && !postmasterLockIsStale({ alive, command })) {
      args.log(`postmaster.pid in ${dir} is held by a live postgres (pid ${pid}); not touching it`);
      return { clearedStaleLock: false, kickedService: false, detail: `live postmaster pid ${pid}` };
    }
    try {
      rmSync(pidFile);
