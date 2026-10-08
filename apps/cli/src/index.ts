#!/usr/bin/env node
/**
 * `noelle` — set up and operate a fully self-hosted Noelle on a personal VM
 * (macOS or Linux). See docs: docs/self-host.md.
 *
 * Convention (matches apps/x-intern/src/env.ts): plain process.argv parsing,
 * no commander/yargs.
 */
import { dirname, resolve } from "node:path";
import {
  defaultConfig,
  ensureHome,
  expandHome,
  findRepoRoot,
  loadConfig,
  paths,
  saveConfig,
  type LlmProvider,
  type PostgresMode,
  type SelfHostConfig,
  type TailscaleMode,
} from "./config.js";
import { ui } from "./lib/ui.js";
import { buildBackendServices } from "./lib/backend-build.js";
import {
  detectContainerRuntime,
  hasContainerRuntime,
  hasCommand,
  portInUse,
  platform,
  run,
} from "./lib/platform.js";
import { loadOrCreateSecrets, type SecretsState } from "./lib/secrets-state.js";
import { collectProviderEnv, collectWorkerCredsEnv } from "./lib/providers.js";
import { vegaEnable, vegaDisable, vegaState } from "./lib/vega.js";
import {
  vegaStyleAddSource,
  vegaStyleRemoveSource,
  vegaStylePin,
  vegaStyleUnpin,
  vegaStyleRun,
  vegaStyleList,
} from "./lib/vega-style.js";
import { mintOperatorJwt } from "./lib/identity.js";
import { ensureOperatorJwtFresh, reloadOperatorSession } from "./lib/operator-session.js";
import { composeEnv, writeEnvFile, readEnvFile } from "./lib/env-writer.js";
import { applyMigrations, seedOperator } from "./lib/migrate.js";
import {
  composeAdminUrl,
  composeAppUrl,
  ensureContainerPostgres,
  recoverNativePostgres,
  setAppPassword,
  stopContainerPostgres,
  waitForPostgres,
} from "./lib/postgres.js";
import {
  pm2Logs,
  pm2LogsOnce,
  pm2DeployRestartTargets,
  pm2RestartMany,
  pm2Start,
  pm2StartApp,
  pm2Status,
  pm2Stop,
  writeEcosystem,
  ecosystemRepoRoot,
} from "./lib/process-manager.js";
import { cloudflaredInstalled, installHint, runQuickTunnel } from "./lib/tunnel.js";
import {
  installHint as tailscaleInstallHint,
  resolveUrl as tailscaleResolveUrl,
  serve as tailscaleServe,
  serveOff as tailscaleServeOff,
  tailscaleInstalled,
} from "./lib/tailscale.js";
import {
  limaInstalled,
  readVmConfig,
  resolveVmUpCommand,
  shell as limaShell,
  startVm,
  waitVmReady,
  writeVmConfig,
} from "./lib/lima.js";
import {
  LABEL as AUTOSTART_LABEL,
  install as autostartInstall,
  isLoaded as autostartLoaded,
  status as autostartStatus,
  uninstall as autostartUninstall,
} from "./lib/autostart.js";
import {
  macFastForward,
  syncToVm,
  deployStampPayload,
  writeDeployStamp,
  restartVmWorkers,
  DEPLOY_STAMP_FILE,
  isNativeRuntime,
  localHeadSha,
  nativeFetchAndFastForward,
  recordDeployFailure,
  selfHealDecision,
  shouldHoldDeploy,
  DEPLOY_MAX_ATTEMPTS,
  isDocsOnlyDiff,
  pnpmInstallArgs,
} from "./lib/sync.js";
import { acquireLock, updateStage, releaseLock, lockPath, parseLock } from "./lib/deploy-lock.js";
import { sendDeployAlert } from "./lib/alert.js";
import { listWorktrees, classifyWorktree, removeWorktree } from "./lib/worktrees.js";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import {
  LABEL as AUTOUPDATE_LABEL,
  install as autoupdateInstall,
  installPostCommitHook,
  status as autoupdateStatus,
  uninstall as autoupdateUninstall,
} from "./lib/autoupdate.js";
import { initBrandFile, loadBrandFile, applyBrand, showBrand, brandFilePath } from "./lib/brand.js";
import { brandConfigHasContent, type BridgeHealth, type DoctorReport } from "@noelle/contracts";
import { readPayload, pushContent } from "./lib/content-push.js";

const VERSION = "0.0.1-alpha.0";
const PROVIDERS: LlmProvider[] = ["anthropic", "openai", "codex", "vertex", "bedrock"];

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      _.push(a);
    }
  }
  return { _, flags };
}

function str(flags: Args["flags"], key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}
function bool(flags: Args["flags"], key: string): boolean {
  return flags[key] === true || flags[key] === "true";
}

function schemaDir(repoRoot: string): string {
  return resolve(repoRoot, "infra/cloudsql/schema");
}

function adminUrlFor(config: SelfHostConfig, secrets: SecretsState): string {
  if (config.postgres.mode === "docker") return composeAdminUrl(config, secrets.rootPassword);
  return (
    process.env.NOELLE_PG_SUPERUSER_URL ??
    `postgres://postgres@${config.postgres.host}:${config.postgres.port}/postgres`
  );
}

/** Build the shared @noelle/* packages so app/api-vm resolve their dist. */
async function buildPackages(repoRoot: string): Promise<void> {
  await run("pnpm", ["-r", "--filter", "./packages/*", "build"], {
    cwd: repoRoot,
    inherit: true,
  });
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
async function cmdInit(args: Args): Promise<number> {
  const p = ensureHome();
  const repoRoot = findRepoRoot();
  ui.step(`Initializing self-hosted Noelle (${platform()})`);
  ui.info(`repo: ${repoRoot}`);
  ui.info(`home: ${p.home}`);

  const config: SelfHostConfig = loadConfig() ?? defaultConfig();
  const provider = str(args.flags, "provider");
  if (provider) {
    if (!PROVIDERS.includes(provider as LlmProvider)) {
      ui.err(`unknown --provider ${provider}; one of: ${PROVIDERS.join(", ")}`);
      return 2;
    }
    config.llmProvider = provider as LlmProvider;
  }
  config.operator.email = str(args.flags, "email") ?? config.operator.email;
  config.operator.name = str(args.flags, "name") ?? config.operator.name;
  config.operator.sub = str(args.flags, "sub") ?? config.operator.sub;
  config.orgSlug = str(args.flags, "org") ?? config.orgSlug;
  if (str(args.flags, "port-app")) config.ports.app = Number(str(args.flags, "port-app"));
  if (str(args.flags, "port-api")) config.ports.apiVm = Number(str(args.flags, "port-api"));
  if (bool(args.flags, "workers")) config.workersEnabled = true;
  if (str(args.flags, "vault-dir")) config.vaultDir = expandHome(str(args.flags, "vault-dir")!);
  if (str(args.flags, "voice-dirs")) config.voiceDirs = str(args.flags, "voice-dirs")!;
  if (str(args.flags, "budget-cents"))
    config.budgetCapCents = Number(str(args.flags, "budget-cents"));

  const pgFlag = str(args.flags, "pg");
  if (pgFlag === "docker" || pgFlag === "native") config.postgres.mode = pgFlag as PostgresMode;
  else config.postgres.mode = (await hasContainerRuntime()) ? "docker" : "native";
  ui.info(`postgres mode: ${config.postgres.mode}`);
  ui.info(`llm provider: ${config.llmProvider}`);

  const secrets = loadOrCreateSecrets(p);
  const chosen = collectProviderEnv(config.llmProvider, process.env);
  // Bake in the chosen provider's creds PLUS every other worker cred present in
  // the env (X cookies, Bedrock/Vertex, gemini, any NOELLE_SECRET_*), so a
  // single `export …; noelle init` wires the whole worker pool.
  const providerEnv = { ...chosen.env, ...collectWorkerCredsEnv(process.env) };
  const missing = chosen.missing;

  // --- Provision Postgres ---
  ui.step("Provisioning Postgres");
  const adminUrl = adminUrlFor(config, secrets);
  if (config.postgres.mode === "docker") {
    const runtime = await detectContainerRuntime();
    if (!runtime) {
      ui.err(
        "Container mode selected but no docker/nerdctl daemon is reachable. Start one or re-run with --pg native.",
      );
      return 1;
    }
    ui.info(`container runtime: ${runtime}`);
    await ensureContainerPostgres({
      runtime,
      config,
      rootPassword: secrets.rootPassword,
      pgdataDir: p.pgdata,
      log: (m) => ui.info(m),
    });
  } else {
    ui.info(
      `native mode — using superuser ${process.env.NOELLE_PG_SUPERUSER_URL ? "NOELLE_PG_SUPERUSER_URL" : `postgres@127.0.0.1:${config.postgres.port}`}`,
    );
  }
  try {
    await waitForPostgres(adminUrl, 90_000);
    ui.ok("Postgres is accepting connections");
  } catch (err) {
    ui.err(String(err));
    if (config.postgres.mode === "native") {
      ui.warn(
        "Install + start Postgres 16, then set NOELLE_PG_SUPERUSER_URL and re-run `noelle init`.",
      );
      ui.warn(
        platform() === "darwin"
          ? "  brew install postgresql@16 && brew services start postgresql@16"
          : "  sudo apt-get install -y postgresql-16 && sudo systemctl enable --now postgresql",
      );
    }
    return 1;
  }

  // --- Schema + seed ---
  ui.step("Applying schema");
  const applied = await applyMigrations({
    adminUrl,
    schemaDir: schemaDir(repoRoot),
    log: (m) => ui.info(m),
  });
  ui.ok(`applied ${applied.length} migration(s)`);
  await setAppPassword(adminUrl, secrets.appPassword);
  await seedOperator({ adminUrl, config, log: (m) => ui.info(m) });
  ui.ok(`operator ${config.operator.email} seeded into org "${config.orgSlug}"`);

  // --- Mint JWT + write env + ecosystem ---
  ui.step("Writing configuration");
  const databaseUrl = composeAppUrl(config, secrets.appPassword);
  const operatorJwt = await mintOperatorJwt({
    secret: secrets.jwtSecret,
    sub: config.operator.sub,
    email: config.operator.email,
  });
  const env = composeEnv({
    config,
    databaseUrl,
    jwtSecret: secrets.jwtSecret,
    gateCookieSecret: secrets.gateCookieSecret,
    hmacSecret: secrets.hmacSecret,
    cronSecret: secrets.cronSecret,
    operatorJwt,
    version: VERSION,
    heartbeatDir: p.heartbeats,
    providerEnv,
    tunnelHostname: config.tunnel.hostname,
  });
  writeEnvFile(p.envFile, env);
  ui.ok(`wrote ${p.envFile}`);
  writeEcosystem({ config, repoRoot, paths: p });
  ui.ok(`wrote ${p.ecosystem}`);
  saveConfig(config);

  if (missing.length > 0) {
    ui.warn(`LLM provider "${config.llmProvider}" is missing creds: ${missing.join(", ")}`);
    ui.warn(
      "Set them in your shell and re-run `noelle init`, or add to ~/.noelle/.env. (Not needed for the v1 dashboard.)",
    );
  }

  ui.plain();
  ui.ok("Init complete. Next: `noelle up` then open http://127.0.0.1:" + config.ports.app);
  return 0;
}

// ---------------------------------------------------------------------------
// migrate
// ---------------------------------------------------------------------------
async function cmdMigrate(): Promise<number> {
  const repoRoot = findRepoRoot();
  const p = ensureHome();
  const config = loadConfig();
  if (!config) {
    ui.err("No config found. Run `noelle init` first.");
    return 1;
  }
  const secrets = loadOrCreateSecrets(p);
  const adminUrl = adminUrlFor(config, secrets);
  await waitForPostgres(adminUrl, 30_000);
  const applied = await applyMigrations({
    adminUrl,
    schemaDir: schemaDir(repoRoot),
    log: (m) => ui.info(m),
  });
  await setAppPassword(adminUrl, secrets.appPassword);
  await seedOperator({ adminUrl, config, log: (m) => ui.info(m) });
  ui.ok(`migrate complete (${applied.length} files)`);
  return 0;
}

// ---------------------------------------------------------------------------
// up
// ---------------------------------------------------------------------------
async function cmdUp(args: Args): Promise<number> {
  const repoRoot = findRepoRoot();
  const p = ensureHome();
  const config = loadConfig();
  if (!config) {
    ui.err("No config found. Run `noelle init` first.");
    return 1;
  }
  const secrets = loadOrCreateSecrets(p);

  ui.step("Starting Postgres");
  if (config.postgres.mode === "docker") {
    const runtime = await detectContainerRuntime();
    if (!runtime) {
      ui.err("No docker/nerdctl runtime reachable to start Postgres.");
      return 1;
    }
    await ensureContainerPostgres({
      runtime,
      config,
      rootPassword: secrets.rootPassword,
      pgdataDir: p.pgdata,
      log: (m) => ui.info(m),
    });
  }
  const adminUrl = adminUrlFor(config, secrets);
  if (config.postgres.mode === "native") {
    // Native Postgres is owned by launchd/brew, not this CLI — but an unclean
    // shutdown can wedge it forever behind a stale postmaster.pid (the pid it
    // records gets recycled by an unrelated process after reboot, so Postgres
    // refuses to start and the brew KeepAlive loop never recovers). Probe
    // first: a healthy service is never touched.
    const quickOk = await waitForPostgres(adminUrl, 3_000).then(
      () => true,
      () => false,
    );
    if (!quickOk) {
      ui.warn("Postgres not answering — attempting native recovery (stale lock + service kick)");
      await recoverNativePostgres({ log: (m) => ui.info(m) });
    }
  }
  await waitForPostgres(adminUrl, 90_000);
  ui.ok("Postgres ready");

  ui.step("Applying schema (idempotent)");
  await applyMigrations({ adminUrl, schemaDir: schemaDir(repoRoot), log: () => {} });
  await setAppPassword(adminUrl, secrets.appPassword);
  await seedOperator({ adminUrl, config, log: () => {} });
  ui.ok("schema up to date");

  ui.step("Building");
  await buildPackages(repoRoot);
  const buildEnv = { ...process.env, ...readEnvFile(p.envFile) };
  const { existsSync } = await import("node:fs");
  // Both runtimes serve a prod build (`next start`), so `up` needs `next build`
  // on first run / --build. BUILD_ID only exists after a PRODUCTION build — a
  // leftover dev-mode .next (from the retired native `next dev` phase) doesn't
  // count and must be rebuilt.
  const buildId = resolve(repoRoot, "apps/app/.next/BUILD_ID");
  const rebuiltApp = bool(args.flags, "build") || !existsSync(buildId);
  if (rebuiltApp) {
    ui.info("next build (first run or --build)…");
    await run("pnpm", ["--filter", "@noelle/app", "build"], {
      cwd: repoRoot,
      env: buildEnv,
      inherit: true,
    });
  } else {
    ui.info("reusing existing apps/app/.next (pass --build to rebuild)");
  }
  await buildBackendServices({ repoRoot, workersEnabled: config.workersEnabled, env: buildEnv });
  if (config.workersEnabled) {
    // Enabling workers guarantees a spend cap EXISTS (and forces send/auto-send
    // off) before any worker boots — the budget pre-check can't be skipped.
    // It only SEEDS the cap, though: this path runs unattended on every `noelle
    // up`, on each `noelle sync` self-heal tick, and on login, so stamping it
    // unconditionally silently reverted any cap the operator raised in the
    // dashboard. Changing the cap is `noelle vega enable --budget-cents N`.
    const v = await vegaEnable({
      dbUrl: adminUrl,
      orgSlug: config.orgSlug,
      budgetCapCents: config.budgetCapCents,
      preserveExistingCap: true,
      preservePipelineState: true,
      log: (m) => ui.ok(m),
    });
    if (!v.found) ui.warn("Vega instance not found; workers will idle until it's seeded.");
    // Auto-apply the operator brand config if present, so the drafter tailors
    // replies + DMs to the operator's business from the first tick.
    if (existsSync(brandFilePath(p))) {
      try {
        const brand = loadBrandFile(p);
        const n = await applyBrand({ dbUrl: adminUrl, orgSlug: config.orgSlug, brand });
        ui.ok(
          `brand config applied (${n} instance) ${brandConfigHasContent(brand) ? "" : "(empty — generic voice)"}`,
        );
      } catch (err) {
        ui.warn(`brand.json present but not applied: ${(err as Error).message}`);
      }
    } else {
      ui.info(
        "no ~/.noelle/brand.json — drafting with generic voice. Run `noelle brand init` to tailor it.",
      );
    }
  }

  // Re-mint the operator JWT when it's missing or expiring, BEFORE pm2 reads
  // .env — fresh processes then pick it up for free.
  const jwtReminted = await ensureOperatorJwtFresh({
    envFile: p.envFile,
    config,
    fallbackSecret: secrets.jwtSecret,
  });
  if (jwtReminted) ui.ok("operator JWT re-minted (was missing or expiring)");

  ui.step("Starting services (pm2)");
  await pm2Start(repoRoot, p.ecosystem);
  // Any explicit bring-up cancels a prior `noelle down`: the auto tick's
  // self-heal is back in charge of keeping the stack alive.
  rmSync(p.stackDownMarker, { force: true });
  // Existing processes receive fresh auth/build state through the ecosystem.
  // A failed delivery remains pending across later unchanged-code ticks.
  await reloadOperatorSession({ envFile: p.envFile, config, repoRoot, ecosystem: p.ecosystem,
    fallbackSecret: secrets.jwtSecret, force: rebuiltApp });

  // Wait for /health then dashboard.
  const apiOk = await waitForHttp(`http://127.0.0.1:${config.ports.apiVm}/health`, 60_000);
  ui.info(apiOk ? "api-vm /health ok" : "api-vm /health not responding yet");
  const appOk = await waitForHttp(`http://127.0.0.1:${config.ports.app}/`, 90_000);
  ui.info(appOk ? "dashboard responding" : "dashboard not responding yet");

  ui.plain();
  ui.ok(`Noelle is up → http://127.0.0.1:${config.ports.app}/app/${config.orgSlug}`);
  ui.info(
    "`noelle status` for process health · `noelle logs` to tail · `noelle tunnel` for remote access",
  );
  return apiOk && appOk ? 0 : 1;
}

// ---------------------------------------------------------------------------
// down / status / logs / health / tunnel / doctor
// ---------------------------------------------------------------------------
async function cmdDown(args: Args): Promise<number> {
  const repoRoot = findRepoRoot();
  const purge = bool(args.flags, "purge");
  ui.step("Stopping services");
  // Record that this stop is deliberate BEFORE stopping anything, so an auto
  // tick racing this command cannot read "down + no marker" and heal the
  // stack right back up. Cleared by `noelle up` (login autostart included).
  const p = ensureHome();
  writeFileSync(p.stackDownMarker, `${new Date().toISOString()} noelle down\n`);
  await pm2Stop(repoRoot, true);
  ui.ok("pm2 processes stopped");
  const config = loadConfig();
  if (config?.postgres.mode === "docker") {
    const runtime = await detectContainerRuntime();
    if (runtime) {
      await stopContainerPostgres(runtime, purge);
      ui.ok(
        purge
          ? "Postgres container removed"
          : "Postgres container stopped (data kept; --purge to remove)",
      );
    }
  }
  return 0;
}

async function cmdStatus(args: Args): Promise<number> {
  const repoRoot = findRepoRoot();
  const p = ensureHome();
  const config = loadConfig() ?? defaultConfig();
  const secrets = loadOrCreateSecrets(p);
  const adminUrl = adminUrlFor(config, secrets);

  const procs = await pm2Status(repoRoot);
  let dbOk = false;
  try {
    await waitForPostgres(adminUrl, 3000);
    dbOk = true;
  } catch {
    dbOk = false;
  }
  const apiOk = await probeHttp(`http://127.0.0.1:${config.ports.apiVm}/health`);
  const appOk = await probeHttp(`http://127.0.0.1:${config.ports.app}/`);

  if (bool(args.flags, "json")) {
    console.log(
      JSON.stringify(
        {
          postgres: dbOk ? "ok" : "down",
          apiVm: apiOk ? "ok" : "down",
          app: appOk ? "ok" : "down",
          processes: procs,
          workersEnabled: config.workersEnabled,
          remoteAccess: config.remoteAccess,
        },
        null,
        2,
      ),
    );
    return dbOk && apiOk && appOk ? 0 : 1;
  }

  ui.step("Noelle self-host status");
  ui.plain(`  postgres   ${dbOk ? "✓ ok" : "✗ down"}`);
  ui.plain(`  api-vm     ${apiOk ? "✓ ok" : "✗ down"}  (:${config.ports.apiVm})`);
  ui.plain(`  dashboard  ${appOk ? "✓ ok" : "✗ down"}  (:${config.ports.app})`);
  ui.plain("  processes:");
  if (procs.length === 0) ui.plain("    (none — run `noelle up`)");
  for (const proc of procs) {
    ui.plain(
      `    ${proc.status === "online" ? "✓" : "✗"} ${proc.name}  ${proc.status}  ${proc.memoryMb}MB  ↺${proc.restarts}`,
    );
  }
  const ra = config.remoteAccess;
  ui.plain("  remote access:");
  ui.plain(`    tailscale  ${ra.tailscale.enabled ? `✓ ${ra.tailscale.url ?? "(on)"}` : "· off"}`);
  ui.plain(`    autostart  ${ra.autostart.enabled ? "✓ on (Mac login)" : "· off"}`);
  return dbOk && apiOk && appOk ? 0 : 1;
}

async function cmdLogs(args: Args): Promise<number> {
  const repoRoot = findRepoRoot();
  await pm2Logs(repoRoot, args._[1]);
  return 0;
}

async function cmdHealth(): Promise<number> {
  const config = loadConfig() ?? defaultConfig();
  const apiOk = await probeHttp(`http://127.0.0.1:${config.ports.apiVm}/health`);
  const appOk = await probeHttp(`http://127.0.0.1:${config.ports.app}/`);
  ui.plain(`api-vm ${apiOk ? "ok" : "down"} · dashboard ${appOk ? "ok" : "down"}`);
  return apiOk && appOk ? 0 : 1;
}

async function cmdTunnel(): Promise<number> {
  const config = loadConfig() ?? defaultConfig();
  if (!(await cloudflaredInstalled())) {
    ui.err(`cloudflared not found. Install it: ${installHint()}`);
    return 1;
  }
  ui.step(`Opening a Cloudflare quick tunnel → http://127.0.0.1:${config.ports.app}`);
  ui.info("Copy the printed *.trycloudflare.com URL. Ctrl-C to stop.");
  ui.info(
    "For a stable hostname, run a named tunnel and set NOELLE_TUNNEL_HOSTNAME, then `noelle init`.",
  );
  await runQuickTunnel(config.ports.app);
  return 0;
}

// ---------------------------------------------------------------------------
// expose / autostart — phone access over Tailscale + Mac-login auto-start.
//
// These are HOST-side (the Mac): the dashboard + api-vm run inside the Lima VM
// and can't touch the host's launchd or tailscale. They read the operator's app
// port + remoteAccess settings from the VM's config.json (the source of truth)
// via `limactl shell`, and write resolved state back the same way.
// ---------------------------------------------------------------------------
function requireDarwinHost(action: string): boolean {
  if (platform() === "darwin") return true;
  ui.err(`\`noelle ${action}\` runs on the Mac host, not inside the Linux VM.`);
  ui.info("It manages launchd + tailscale, which only exist on the host.");
  return false;
}

/**
 * A stable absolute node for the LaunchAgent. `process.execPath` is a
 * version-pinned Cellar path (e.g. .../node/25.8.1/bin/node) that breaks on the
 * next `brew upgrade node`; the `which node` symlink (/opt/homebrew/bin/node)
 * survives upgrades. Fall back to execPath if PATH has no node.
 */
async function resolveStableNode(): Promise<string> {
  const r = await run("which", ["node"], { allowFailure: true });
  const p = r.stdout.trim();
  return r.code === 0 && p ? p : process.execPath;
}

/** Dirs to put on the LaunchAgent's PATH so limactl/tailscale/node resolve. */
async function resolvePathDirs(): Promise<string[]> {
  const dirs = new Set<string>([dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin"]);
  for (const bin of ["limactl", "tailscale"]) {
    const r = await run("which", [bin], { allowFailure: true });
    if (r.code === 0 && r.stdout.trim()) dirs.add(dirname(r.stdout.trim()));
  }
  return [...dirs];
}

function resolveMode(args: Args, fallback: TailscaleMode): TailscaleMode {
  const m = str(args.flags, "mode");
  return m === "http" || m === "https" ? m : fallback;
}

async function cmdExpose(args: Args): Promise<number> {
  if (!requireDarwinHost("expose")) return 2;
  const vm = str(args.flags, "vm") ?? "default";
  if (!(await limaInstalled())) {
    ui.err("limactl not found — this self-host runs inside a Lima VM.");
    return 1;
  }
  const config = await readVmConfig(vm);
  if (!config) {
    ui.err(`Couldn't read ~/.noelle/config.json in VM "${vm}". Is it running + initialized?`);
    return 1;
  }
  const appPort = config.ports.app;
  const ts = config.remoteAccess.tailscale;

  if (bool(args.flags, "off")) {
    // Target only OUR listener (never `serve reset` — other apps may be served).
    await tailscaleServeOff(ts.mode, ts.port);
    ts.enabled = false;
    ts.url = null;
    await writeVmConfig(vm, config);
    ui.ok(`Tailscale serve on :${ts.port} cleared. The dashboard is no longer published.`);
    return 0;
  }

  if (!(await tailscaleInstalled())) {
    ui.err(`tailscale not found. Install it: ${tailscaleInstallHint()}`);
    return 1;
  }
  const mode = resolveMode(args, ts.mode);
  const portFlag = str(args.flags, "port");
  const port = portFlag !== undefined ? Number(portFlag) : ts.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    ui.err(`--port must be 1-65535 (got "${portFlag}")`);
    return 2;
  }

  // Switching port/mode? Clear the old listener first so we don't leave a stale
  // mapping behind (e.g. the previous 443 root the operator wanted off of).
  if (ts.enabled && (ts.port !== port || ts.mode !== mode)) {
    await tailscaleServeOff(ts.mode, ts.port);
    ui.info(`cleared previous serve on :${ts.port}`);
  }

  ui.step(`Exposing dashboard (:${appPort}) over Tailscale [${mode} :${port}]`);
  try {
    await tailscaleServe(appPort, mode, port);
  } catch (err) {
    ui.err((err as Error).message);
    if (mode === "https") {
      ui.warn("If that's a cert error, enable HTTPS certs once in the Tailscale admin:");
      ui.warn("  https://login.tailscale.com/admin/dns  → enable MagicDNS + HTTPS Certificates");
    }
    return 1;
  }
  const url = await tailscaleResolveUrl(mode, port);
  config.remoteAccess.tailscale = { enabled: true, mode, port, url };
  await writeVmConfig(vm, config);
  ui.ok(`Exposed → ${url ?? "(couldn't resolve URL — see `tailscale serve status`)"}`);
  ui.info("Open that URL on your phone (signed into the same tailnet). Survives reboots (--bg).");
  ui.info("`noelle autostart install` also re-exposes it automatically on Mac login.");
  return 0;
}

async function cmdAutostart(args: Args): Promise<number> {
  if (!requireDarwinHost("autostart")) return 2;
  const sub = args._[1] ?? "status";
  const vm = str(args.flags, "vm") ?? "default";

  if (sub === "install") {
    if (!(await limaInstalled())) {
      ui.err("limactl not found — this self-host runs inside a Lima VM.");
      return 1;
    }
    const repoRoot = str(args.flags, "repo")
      ? expandHome(str(args.flags, "repo")!)
      : findRepoRoot();
    ui.step("Installing the login LaunchAgent");
    ui.info(`repo (host): ${repoRoot}`);
    const vmUpCommand = await resolveVmUpCommand(vm);
    const pathDirs = await resolvePathDirs();
    const nodeBin = await resolveStableNode();
    await autostartInstall({ repoRoot, nodeBin, pathDirs, vm });

    const config = await readVmConfig(vm);
    if (config) {
      config.remoteAccess.autostart = { enabled: true, vm, vmUpCommand };
      // Installing autostart implies we want login to also expose the port.
      config.remoteAccess.tailscale.enabled = true;
      await writeVmConfig(vm, config);
    } else {
      ui.warn(`LaunchAgent installed, but couldn't persist state to VM "${vm}" (start + init it).`);
    }
    ui.ok(`Installed (${AUTOSTART_LABEL}). Noelle starts on every login.`);
    ui.info(`VM bring-up: ${vmUpCommand}`);
    ui.info(`Test now without a reboot:  launchctl kickstart -k gui/$(id -u)/${AUTOSTART_LABEL}`);
    return 0;
  }
  if (sub === "uninstall") {
    await autostartUninstall();
    const config = await readVmConfig(vm);
    if (config) {
      config.remoteAccess.autostart.enabled = false;
      await writeVmConfig(vm, config);
    }
    ui.ok("LaunchAgent removed. Noelle will no longer start on login.");
    return 0;
  }
  // status (default)
  const st = await autostartStatus();
  ui.step("Autostart (login LaunchAgent)");
  ui.plain(`  loaded     ${st.loaded ? "✓ yes" : "· no"}`);
  ui.plain(`  plist      ${st.plistExists ? st.plist : "(not installed)"}`);
  if (st.lastLog) {
    ui.plain("  recent log:");
    for (const line of st.lastLog.split("\n")) ui.plain(`    ${line}`);
  }
  return 0;
}

/** Internal: invoked by the login LaunchAgent. Start VM → up → expose. */
async function cmdAutostartRun(args: Args): Promise<number> {
  const vm = str(args.flags, "vm") ?? "default";
  ui.step(`[autostart-run] vm=${vm}`);
  if (platform() !== "darwin") {
    ui.err("autostart-run is host-only.");
    return 2;
  }
  // Native install: bring the stack up on this Mac, no VM to boot.
  const hostConfig = loadConfig();
  if (isNativeRuntime(hostConfig)) return autostartRunNative(args, hostConfig!);
  if (!(await limaInstalled())) {
    ui.err("limactl not found.");
    return 1;
  }
  await startVm(vm);
  if (!(await waitVmReady(vm, 120_000))) {
    ui.err("VM did not become ready within 120s.");
    return 1;
  }
  ui.ok("VM ready");

  const config = await readVmConfig(vm);
  if (!config) {
    ui.err("Could not read VM config; aborting.");
    return 1;
  }

  const up = config.remoteAccess.autostart.vmUpCommand || "noelle up";
  ui.step(`Bringing Noelle up in VM: ${up}`);
  const upRes = await limaShell(vm, up);
  ui.info(upRes.code === 0 ? "noelle up ok" : `noelle up exited ${upRes.code} (continuing)`);

  if (config.remoteAccess.tailscale.enabled) {
    const { mode, port } = config.remoteAccess.tailscale;
    const appPort = config.ports.app;
    if (await tailscaleInstalled()) {
      try {
        await tailscaleServe(appPort, mode, port);
        const url = await tailscaleResolveUrl(mode, port);
        config.remoteAccess.tailscale.url = url;
        await writeVmConfig(vm, config);
        ui.ok(`Exposed → ${url ?? "(url unresolved)"}`);
      } catch (err) {
        ui.warn(`tailscale serve failed: ${(err as Error).message}`);
      }
    } else {
      ui.warn("tailscale not installed; skipping expose.");
    }
  } else {
    ui.info("Tailscale expose disabled in config; skipping.");
  }
  ui.ok("[autostart-run] done");
  return 0;
}

/** Native login bring-up: start the stack on this Mac, then expose over Tailscale. No VM. */
async function autostartRunNative(args: Args, config: SelfHostConfig): Promise<number> {
  ui.step("[autostart-run] native (no VM)");
  const upCode = await cmdUp(args); // ensures Postgres + pm2 (dev dashboard) locally
  if (upCode !== 0) ui.warn(`noelle up exited ${upCode} (continuing to expose)`);
  if (config.remoteAccess.tailscale.enabled && (await tailscaleInstalled())) {
    const { mode, port } = config.remoteAccess.tailscale;
    try {
      await tailscaleServe(config.ports.app, mode, port);
      const url = await tailscaleResolveUrl(mode, port);
      config.remoteAccess.tailscale.url = url;
      saveConfig(config);
      ui.ok(`Exposed → ${url ?? "(url unresolved)"}`);
    } catch (err) {
      ui.warn(`tailscale serve failed: ${(err as Error).message}`);
    }
  }
  ui.ok("[autostart-run] done (native)");
  return 0;
}

/**
 * Internal: invoked by the auto-update LaunchAgent (and runnable by hand).
 * Fast-forward the tracked branch on the Mac, build here (the 4 GB VM OOM-kills
 * on `next build`), then rsync the built repo into the VM. Skips build+ship when
 * the branch head hasn't moved since the last sync.
 */
/**
 * The one deploy pipeline. Called by `noelle sync` (auto:true, run by the
 * LaunchAgent) and `noelle deploy` (auto:false, manual). Serialized by the Mac
 * deploy lock; ships only when origin/<branch> advanced past lastSyncedSha;
 * stamps the shipped SHA into the tree; restarts VM workers; advances
 * lastSyncedSha ONLY after a successful restart so a failed restart self-heals.
 */
async function runDeploy(args: Args, opts: { auto: boolean }): Promise<number> {
  // Git exports GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE to hook children (the
  // post-commit hook spawns `noelle sync`). Inherited, they silently retarget
  // every `git -C <repoRoot>` call at the COMMITTING repo — a worktree commit
  // once deployed a branch sha this way. The hook scrubs too; this is the
  // belt-and-braces for every other entry path.
  delete process.env.GIT_DIR;
  delete process.env.GIT_WORK_TREE;
  delete process.env.GIT_INDEX_FILE;
  const vm = str(args.flags, "vm") ?? "default";
  if (platform() !== "darwin") {
    ui.err("deploy is host-only — it builds on the Mac and rsyncs into the VM.");
    return 2;
  }
  // Native install: no VM. Build the local checkout + restart local workers.
  const hostConfig = loadConfig();
  if (isNativeRuntime(hostConfig)) return runDeployNative(args, opts, hostConfig!);
  const force = bool(args.flags, "force");
  const config = await readVmConfig(vm);
  if (!config) {
    ui.err(`Could not read VM config for "${vm}"; is the VM up and initialized?`);
    return 1;
  }
  const repoRoot = str(args.flags, "repo") ? expandHome(str(args.flags, "repo")!) : findRepoRoot();
  const branch = config.autoUpdate.branch;

  // Acquire the deploy lock (serialize against the LaunchAgent / other deploys).
  const got = acquireLock({
    pid: process.pid,
    host: hostname(),
    sha: "pending",
    stage: "fast-forward",
  });
  if (!got.ok) {
    const h = got.holder;
    if (!h) { ui.err("[deploy] existing lock ownership cannot be verified; deploy skipped."); return 1; }
    const ageMin = Math.round((Date.now() - h.startedAt) / 60000);
    if (opts.auto && !force) {
      ui.info(
        `[deploy] another deploy in progress (pid ${h.pid}, stage ${h.stage}, ${ageMin}m) — next tick will catch it.`,
      );
      return 0; // launchd re-polls; nothing to do
    }
    ui.err(
      `[deploy] locked by pid ${h.pid} on ${h.host} (stage ${h.stage}, sha ${h.sha.slice(0, 8)}, ${ageMin}m ago).`,
    );
    ui.info("Wait for the current deploy to finish. A live holder keeps its lock.");
    return 1;
  }

  try {
    ui.step(`[deploy] fast-forwarding ${branch} (host repo: ${repoRoot})`);
    const sha = await macFastForward(repoRoot, branch);
    if (sha === config.autoUpdate.lastSyncedSha && !force) {
      ui.info(`[deploy] already at ${sha.slice(0, 8)} — nothing to build or ship.`);
      return 0;
    }

    updateStage("build");
    // Install before building: a merged PR that added a workspace package or
    // dependency has no node_modules here yet (see pnpmInstallArgs). No-op
    // when nothing changed.
    ui.step("[deploy] installing workspace deps");
    await run("pnpm", pnpmInstallArgs(), { cwd: repoRoot, inherit: true });
    ui.step("[deploy] building on the Mac (the VM OOM-kills on `next build`)");
    // Exclude the browser extensions (apps/*-actuator, `wxt build`): they are
    // built separately into dist-unpacked and loaded in Chrome — NOT server
    // artifacts. A missing/cleared wxt node_modules in the deploy checkout must
    // never break a prod deploy (it silently did, wedging the workers stale).
    await run("pnpm", ["-r", "--filter=!@noelle/x-actuator", "--filter=!@noelle/linkedin-actuator", "--filter=!@noelle/reddit-actuator", "--filter=!@noelle/chrome-bridge-ext", "build"], { cwd: repoRoot, inherit: true });

    updateStage("rsync");
    writeDeployStamp(repoRoot, deployStampPayload(sha, hostname(), new Date().toISOString()));
    ui.step(`[deploy] rsyncing the built repo into VM "${vm}"`);
    await syncToVm(repoRoot, vm);

    updateStage("restart");
    ui.step("[deploy] restarting VM workers");
    const restart = await restartVmWorkers(vm);
    if (!restart.ok) {
      ui.warn(
        `[deploy] code shipped ${sha.slice(0, 8)} but VM restart FAILED — workers may be stale. ${restart.detail}`,
      );
      ui.info("Fix + re-run `noelle deploy` (lastSyncedSha not advanced, so it retries).");
      return 1; // do NOT advance lastSyncedSha — next run self-heals
    }

    config.autoUpdate.lastSyncedSha = sha;
    await writeVmConfig(vm, config);
    ui.ok(`[deploy] done → ${sha.slice(0, 8)} shipped + workers restarted on VM "${vm}".`);
    return 0;
  } finally {
    releaseLock(process.pid);
  }
}

/**
 * Native deploy (runtime === "native"). No VM: build the LOCAL working tree
 * (dashboard included — it serves a prod build via `next start`) and restart
 * every local pm2 app. Manual/force always builds; the auto-tick skips a rebuild
 * when local HEAD hasn't moved since the last build (lastBuiltSha), so idle
 * launchd ticks never bounce the workers. Serialized by the same deploy lock.
 */
async function runDeployNative(
  args: Args,
  opts: { auto: boolean },
  config: SelfHostConfig,
): Promise<number> {
  const force = bool(args.flags, "force");
  const repoRoot = str(args.flags, "repo") ? expandHome(str(args.flags, "repo")!) : findRepoRoot();
  const home = paths();

  // Refuse to deploy from a checkout other than the one pm2 serves. A
  // worktree-built CLI running `noelle sync` would otherwise build the
  // worktree, restart the SHARED pm2 fleet, and stamp lastBuiltSha with a
  // sha the runtime checkout never built, silently skipping the next real
  // deploy. Fail-open when no ecosystem exists yet (pre-init).
  if (existsSync(home.ecosystem)) {
    const liveRepo = ecosystemRepoRoot(readFileSync(home.ecosystem, "utf8"));
    if (liveRepo && !sameCheckout(liveRepo, repoRoot)) {
      ui.err(
        `[deploy] this checkout (${repoRoot}) is not the runtime checkout (${liveRepo}) the pm2 apps run from.`,
      );
      ui.info(
        "Run `noelle sync` / `noelle deploy` from the runtime checkout, or land the change on main and let the auto tick ship it.",
      );
      return 2;
    }
  }

  const got = acquireLock({ pid: process.pid, host: hostname(), sha: "pending", stage: "build" });
  if (!got.ok) {
    const h = got.holder;
    if (!h) { ui.err("[deploy] existing lock ownership cannot be verified; deploy skipped."); return 1; }
    if (opts.auto && !force) {
      // Say so. This used to be a bare `return 0`, so a `noelle sync` that
      // landed while the LaunchAgent tick held the lock printed NOTHING and
      // exited 0 — indistinguishable from a successful no-op deploy, which is
      // how you end up re-running it and wondering why HEAD never ships. The VM
      // path above has always logged this; the native path never did.
      const ageMin = Math.round((Date.now() - h.startedAt) / 60000);
      ui.info(
        `[deploy] another deploy in progress (pid ${h.pid}, stage ${h.stage}, ${ageMin}m) — next tick will catch it.`,
      );
      return 0; // launchd re-polls
    }
    ui.err(
      `[deploy] locked by pid ${h.pid} (stage ${h.stage}); wait for the current deploy to finish.`,
    );
    return 1;
  }

  // Failure pager: fires NOELLE_ALERT_CMD (if set) so a broken tick pages the
  // operator instead of failing silently in the launchd log. Fail-open; warn
  // when an alert was configured but did not send.
  const alert = async (msg: string): Promise<void> => {
    if ((await sendDeployAlert(home.envFile, msg)) === "failed") {
      ui.warn("[deploy] NOELLE_ALERT_CMD is configured but the alert did not send.");
    }
  };
  let sha: string | null = null;
  // Fold a failure into the backoff state; page only on a sha's FIRST failure.
  const failDeploy = async (reason: string): Promise<void> => {
    // The emergency pager (p2 siren, retry-until-ack) and the backoff state
    // exist for the UNATTENDED auto-update lane (`noelle sync`), where a failed
    // tick would otherwise vanish into the launchd log. A manual `noelle deploy`
    // — a worktree-built CLI, a hand run, or a `--force` rollback — is ATTENDED:
    // the operator sees the failure inline and the non-zero exit, so it must not
    // wake them with a siren or pollute the auto lane's per-sha backoff state.
    if (!opts.auto) return;
    if (!sha) {
      await alert(`noelle deploy failed: ${reason}`);
      return;
    }
    const next = recordDeployFailure(config.autoUpdate.lastFailure, sha);
    config.autoUpdate.lastFailure = next.state;
    saveConfig(config);
    if (next.alert) {
      await alert(`noelle deploy ${sha.slice(0, 8)}: ${reason}`);
    } else {
      ui.info(
        `[deploy] failure ${next.state.attempts}/${DEPLOY_MAX_ATTEMPTS} for ${sha.slice(0, 8)}; already paged.`,
      );
    }
  };
  // Stamp + advance + clear the failure state. Only VERIFIED deploys (or
  // deliberate no-restart cases) go through here, so `noelle deploy status`
  // never calls a failed deploy shipped.
  const markDeployed = (deployedSha: string): void => {
    writeDeployStamp(
      repoRoot,
      deployStampPayload(deployedSha, hostname(), new Date().toISOString()),
    );
    config.autoUpdate.lastBuiltSha = deployedSha;
    config.autoUpdate.lastFailure = null;
    saveConfig(config);
  };

  try {
    // Self-heal the operator JWT on every tick, BEFORE the HEAD early-exit —
    // the token ages out on a wall clock, not on commits. The 10-min cadence
    // means a 7-day re-mint window can't be slept through while the box runs.
    if (!existsSync(home.stackDownMarker) && await reloadOperatorSession({ envFile: home.envFile, config, repoRoot, ecosystem: home.ecosystem })) {
      ui.ok("[deploy] operator session refreshed");
    }

    // Pull origin only on the AUTO tick. `noelle deploy` (with or without
    // --force) means "deploy this working tree exactly as it is", which is
    // what makes a rollback stick: reset --hard <good-sha> + deploy --force
    // must not pull the bad origin sha right back.
    if (opts.auto && !force) {
      const branch = config.autoUpdate.branch;
      const ff = await nativeFetchAndFastForward(repoRoot, branch);
      if (ff.action === "fast-forwarded") {
        ui.ok(`[deploy] ${branch} fast-forwarded to origin (${ff.detail})`);
      } else if (ff.action !== "up-to-date") {
        ui.info(`[deploy] origin pull skipped (${ff.action}: ${ff.detail}); deploying local HEAD`);
      }
    }

    sha = await localHeadSha(repoRoot);

    // Self-heal BEFORE the unchanged-HEAD early exit: a crashed stack (reboot,
    // wedged Postgres, dead pm2 daemon) must come back without an operator,
    // and a crash never changes HEAD — this used to leave the stack down all
    // day while every tick reported "nothing to rebuild". A stack stopped on
    // purpose (`noelle down` writes the marker) is left alone. The bring-up is
    // the same `noelle up` the login autostart runs, which includes native
    // Postgres stale-lock recovery; failures page once per sha via the
    // deploy pager, and every later tick retries.
    if (opts.auto && !force) {
      const secrets = loadOrCreateSecrets(home);
      const postgresOk = await waitForPostgres(adminUrlFor(config, secrets), 3_000).then(
        () => true,
        () => false,
      );
      const [apiOk, appOk] = await Promise.all([
        probeHttp(`http://127.0.0.1:${config.ports.apiVm}/health`),
        probeHttp(`http://127.0.0.1:${config.ports.app}/`),
      ]);
      const decision = selfHealDecision({
        postgresOk,
        apiOk,
        appOk,
        markedDown: existsSync(home.stackDownMarker),
      });
      if (decision.heal) {
        updateStage("self-heal");
        ui.warn(`[deploy] stack is down (${decision.detail}) — running the full bring-up`);
        const upCode = await cmdUp({ _: ["up"], flags: {} });
        if (upCode !== 0) {
          await failDeploy(`self-heal bring-up failed (down: ${decision.detail})`);
          return 1;
        }
        ui.ok("[deploy] self-heal: stack restored");
      } else if (decision.detail) {
        ui.info(`[deploy] ${decision.detail}`);
      }
    }

    // Bound repeated migration failures with the same deploy failure policy.
    if (opts.auto && !force && shouldHoldDeploy(config.autoUpdate.lastFailure, sha)) {
      ui.warn(
        `[deploy] ${sha.slice(0, 8)} already failed ${config.autoUpdate.lastFailure!.attempts}x; holding until a new sha lands (noelle deploy --force to retry now).`,
      );
      return 0;
    }

    updateStage("migrate");
    ui.step("[deploy] applying pending schema migrations");
    await applyMigrations({
      adminUrl: adminUrlFor(config, loadOrCreateSecrets(home)),
      schemaDir: schemaDir(repoRoot),
      log: (message) => ui.plain(message),
    });

    // Auto tick: skip when HEAD is unchanged. Manual/force: always build the
    // working tree as-is (uncommitted edits included) so a hand-run picks them up.
    if (opts.auto && !force && sha === config.autoUpdate.lastBuiltSha) {
      ui.info(`[deploy] local HEAD unchanged (${sha.slice(0, 8)}) — nothing to rebuild.`);
      return 0;
    }

    // Docs-only merges advance the stamp without a build or restart: the
    // running build already corresponds to this sha's runtime code.
    if (opts.auto && !force && config.autoUpdate.lastBuiltSha) {
      const prev = config.autoUpdate.lastBuiltSha;
      const known = await run("git", ["-C", repoRoot, "cat-file", "-e", `${prev}^{commit}`], {
        allowFailure: true,
      });
      if (known.code === 0) {
        const diff = await run("git", ["-C", repoRoot, "diff", "--name-only", `${prev}..${sha}`], {
          allowFailure: true,
        });
        const files = diff.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        if (diff.code === 0 && isDocsOnlyDiff(files)) {
          markDeployed(sha);
          ui.ok(
            `[deploy] docs-only change → ${sha.slice(0, 8)} stamped; no build or restart needed.`,
          );
          return 0;
        }
      }
    }

    updateStage("build");
    // Install before building: a merged PR that added a workspace package or
    // dependency has no node_modules here yet (see pnpmInstallArgs) — first
    // hit by PR #472 (packages/worker-runtime → "Cannot find module 'pino'").
    // No-op when nothing changed. A thrown failure lands in the outer catch:
    // pages once per sha, lastBuiltSha stays put, next tick retries.
    ui.step("[deploy] installing workspace deps");
    await run("pnpm", pnpmInstallArgs(), { cwd: repoRoot, inherit: true });
    ui.step("[deploy] building the local checkout (dashboard + workers + api + mcp)");
    // Exclude the browser extensions (apps/*-actuator, `wxt build`): they are
    // built separately into dist-unpacked and loaded in Chrome — NOT server
    // artifacts. A missing/cleared wxt node_modules in the deploy checkout must
    // never break a prod deploy (it silently did, wedging the workers stale).
    await run("pnpm", ["-r", "--filter=!@noelle/x-actuator", "--filter=!@noelle/linkedin-actuator", "--filter=!@noelle/reddit-actuator", "--filter=!@noelle/chrome-bridge-ext", "build"], { cwd: repoRoot, inherit: true });

    // The LinkedIn actuator IS a deploy artifact now: its build refreshes
    // dist-unpacked (the Chrome load path) and the build stamp that drives the
    // extension's self-reload. Build it separately and NON-FATALLY: a wedged
    // wxt toolchain still never blocks the server fleet — the extension just
    // stays on its previous build (self-reload sees no new stamp) until fixed.
    try {
      await run("pnpm", ["--filter", "@noelle/linkedin-actuator", "build"], { cwd: repoRoot, inherit: true });
    } catch (e) {
      ui.warn(
        `[deploy] linkedin-actuator build failed; extension stays on its previous build: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    // Same deal for the X and Reddit actuators: refresh their dist-unpacked +
    // build stamp on every deploy, warn-only on failure.
    try {
      await run("pnpm", ["--filter", "@noelle/x-actuator", "build"], { cwd: repoRoot, inherit: true });
    } catch (e) {
      ui.warn(
        `[deploy] x-actuator build failed; extension stays on its previous build: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    try {
      await run("pnpm", ["--filter", "@noelle/reddit-actuator", "build"], { cwd: repoRoot, inherit: true });
    } catch (e) {
      ui.warn(
        `[deploy] reddit-actuator build failed; extension stays on its previous build: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // The Chrome Bridge extension is a deploy artifact too (same wxt toolchain
    // as the actuators): its build refreshes dist-unpacked (the Chrome load
    // path) + the build stamp that drives the ext's self-reload. Build it
    // separately and NON-FATALLY for the same reason — a wedged wxt toolchain
    // must never block the server fleet; the ext just stays on its previous
    // build (self-reload sees no new stamp) until fixed. The chrome-bridge
    // SERVER + actuator-doctor are plain tsc apps, built by the `-r` pass above.
    try {
      await run("pnpm", ["--filter", "@noelle/chrome-bridge-ext", "build"], { cwd: repoRoot, inherit: true });
    } catch (e) {
      ui.warn(
        `[deploy] chrome-bridge-ext build failed; extension stays on its previous build: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    updateStage("restart");
    // Restart active or failed apps, dashboard included — `next start` reads
    // .next only at boot, so without a restart it serves the previous bundle.
    const targets = pm2DeployRestartTargets(await pm2Status(repoRoot), repoRoot);
    if (targets.length === 0) {
      // A deliberately stopped stack (`noelle down`) is not a failure: record
      // the refreshed build, skip smoke, stay quiet. On auto ticks the
      // self-heal gate above already restored a CRASHED stack before we got
      // here, so an empty fleet at this point means the marker is present (or
      // a manual deploy against a stopped stack, which is attended).
      markDeployed(sha);
      ui.info(
        `[deploy] pm2 has no noelle apps (stack is down); build refreshed to ${sha.slice(0, 8)}, nothing to restart or smoke-check.`,
      );
      return 0;
    }
    ui.step(`[deploy] restarting ${targets.length} apps`);
    // Pass the ecosystem path so a refreshed .env actually reaches the fleet;
    // a name-based restart keeps whatever env the daemon captured at first start.
    const restart = await pm2RestartMany(
      repoRoot,
      targets,
      existsSync(home.ecosystem) ? home.ecosystem : undefined,
    );
    if (restart && restart.code !== 0) {
      const detail = (restart.stderr || restart.stdout).trim().slice(-300);
      ui.warn(`[deploy] built ${sha.slice(0, 8)} but pm2 restart FAILED. ${detail}`);
      ui.info("lastBuiltSha not advanced; the next tick retries.");
      await failDeploy("pm2 restart failed");
      return 1;
    }

    // Smoke: the dashboard and api-vm must answer HTTP after the restart. A
    // deploy that leaves either port dead must page and retry, never advance
    // the stamp as if it shipped. The app gets the same 90s `noelle up`
    // allows: a cold `next start` right after a full-fleet restart needs it.
    updateStage("smoke");
    const [apiOk, appOk] = await Promise.all([
      waitForHttp(`http://127.0.0.1:${config.ports.apiVm}/health`, 60_000),
      waitForHttp(`http://127.0.0.1:${config.ports.app}/`, 90_000),
    ]);
    if (!apiOk || !appOk) {
      const dead = [
        apiOk ? null : `api-vm :${config.ports.apiVm}`,
        appOk ? null : `dashboard :${config.ports.app}`,
      ]
        .filter(Boolean)
        .join(", ");
      ui.warn(`[deploy] smoke check FAILED after restart (${dead}).`);
      ui.info("lastBuiltSha not advanced; the next tick rebuilds and retries.");
      await failDeploy(`smoke failed (${dead})`);
      return 1;
    }

    markDeployed(sha);
    ui.ok(
      `[deploy] done → ${sha.slice(0, 8)} built + ${targets.length} apps restarted + smoke ok (native).`,
    );
    return 0;
  } catch (err) {
    // Build or git failures land here. Page (first failure of the sha only),
    // then rethrow so the exit stays non-zero and lastBuiltSha stays put.
    await failDeploy(`build failed: ${(err as Error).message.slice(0, 160)}`);
    throw err;
  } finally {
    releaseLock(process.pid);
  }
}

/** Compare two paths as the same real checkout (symlink-safe, fail-soft). */
function sameCheckout(a: string, b: string): boolean {
  const norm = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return norm(a) === norm(b);
}

// `noelle sync` — the LaunchAgent entrypoint. Keep the name; route to runDeploy.
async function cmdSync(args: Args): Promise<number> {
  return runDeploy(args, { auto: true });
}

async function cmdDeploy(args: Args): Promise<number> {
  if (!requireDarwinHost("deploy")) return 2;
  const sub = args._[1] ?? "run";
  const vm = str(args.flags, "vm") ?? "default";

  if (sub === "status") return deployStatus(vm, args);
  if (sub === "log") {
    const { logPath } = await import("./lib/autoupdate.js");
    const p = logPath();
    if (!existsSync(p)) {
      ui.info("No deploy log yet (the auto-update agent hasn't run).");
      return 0;
    }
    ui.step("Recent deploys");
    for (const line of readFileSync(p, "utf8").trim().split("\n").slice(-40)) ui.plain(`  ${line}`);
    return 0;
  }
  // default: manual kick (same locked pipeline, auto:false)
  return runDeploy(args, { auto: false });
}

async function deployStatus(vm: string, args: Args): Promise<number> {
  const repoRoot = str(args.flags, "repo") ? expandHome(str(args.flags, "repo")!) : findRepoRoot();

  // Native install: no VM. Compare local HEAD against the local build stamp.
  const hostConfig = loadConfig();
  if (isNativeRuntime(hostConfig)) {
    const head = (
      await run("git", ["-C", repoRoot, "rev-parse", "HEAD"], { allowFailure: true })
    ).stdout.trim();
    let builtSha: string | null = null;
    let builtAt = "";
    const stampPath = resolve(repoRoot, DEPLOY_STAMP_FILE);
    if (existsSync(stampPath)) {
      try {
        const s = JSON.parse(readFileSync(stampPath, "utf8"));
        builtSha = s?.sha ?? null;
        builtAt = s?.builtAt ?? "";
      } catch {
        /* no/invalid stamp — builtSha stays null */
      }
    }
    const short = (s: string) => (s.length >= 8 ? s.slice(0, 8) : s || "(unknown)");
    ui.step("Deploy status (native)");
    ui.plain(`  local HEAD    ${short(head)}`);
    ui.plain(
      `  last built    ${builtSha ? short(builtSha) : "(never built — run noelle sync)"}${builtAt ? `  (${builtAt})` : ""}`,
    );
    if (builtSha && builtSha === head) ui.ok("✓ workers built from the current HEAD.");
    else ui.warn("⚠ HEAD moved since the last build — run noelle sync to rebuild the workers.");
    return 0;
  }

  const originR = await run("git", ["-C", repoRoot, "ls-remote", "origin", "main"], {
    allowFailure: true,
  });
  const origin = originR.stdout.trim().split(/\s+/)[0] ?? "(unknown)";
  const macR = await run("git", ["-C", repoRoot, "rev-parse", "HEAD"], { allowFailure: true });
  const mac = macR.stdout.trim() || "(unknown)";

  const stampR = await limaShell(vm, `cat ~/noelle/${DEPLOY_STAMP_FILE} 2>/dev/null`);
  let vmSha: string | null = null;
  let vmBuiltAt = "";
  try {
    const s = JSON.parse(stampR.stdout.trim());
    if (s?.sha) {
      vmSha = s.sha as string;
      vmBuiltAt = s.builtAt ?? "";
    }
  } catch {
    /* no/invalid stamp — vmSha stays null */
  }

  const p = lockPath();
  const lock = existsSync(p) ? parseLock(readFileSync(p, "utf8")) : null;

  const short = (s: string) => (s.length >= 8 ? s.slice(0, 8) : s);
  ui.step(`Deploy status (VM "${vm}")`);
  ui.plain(`  origin/main   ${short(origin)}`);
  ui.plain(
    `  Mac HEAD      ${short(mac)}${mac === origin ? " ✓" : " ⚠ behind origin (fetch will ff on next deploy)"}`,
  );
  ui.plain(
    `  VM running    ${vmSha ? short(vmSha) : "(no stamp — never shipped or pre-stamp deploy)"}${vmBuiltAt ? `  (built ${vmBuiltAt})` : ""}`,
  );
  ui.plain(
    `  deploy lock   ${lock ? `HELD pid ${lock.pid} @ ${lock.host} — stage ${lock.stage}` : "free"}`,
  );

  if (lock) ui.info("⏳ a deploy is running.");
  else if (vmSha && vmSha === origin) ui.ok("✓ VM is in sync with origin/main.");
  else
    ui.warn(
      "⚠ VM is behind origin/main — a deploy is pending (or the last one failed). Check `noelle deploy log`.",
    );
  return 0;
}

async function cmdWorktrees(args: Args): Promise<number> {
  const sub = args._[1] ?? "prune";
  if (sub !== "prune") {
    ui.err(`unknown worktrees subcommand: ${sub} — try: noelle worktrees prune [--force]`);
    return 2;
  }
  const force = bool(args.flags, "force");
  const repoRoot = str(args.flags, "repo") ? expandHome(str(args.flags, "repo")!) : findRepoRoot();
  await run("git", ["-C", repoRoot, "fetch", "origin", "main"], { allowFailure: true });
  const wts = await listWorktrees(repoRoot);
  if (wts.length === 0) {
    ui.info("No .claude/worktrees/ worktrees found.");
    return 0;
  }

  const removable = wts.filter((w) => classifyWorktree(w) === "removable");
  const kept = wts.filter((w) => classifyWorktree(w) !== "removable");

  ui.step(
    force
      ? "Pruning merged + clean worktrees"
      : "Worktrees prune (dry-run — pass --force to remove)",
  );
  for (const w of removable) {
    if (force) {
      const ok = await removeWorktree(repoRoot, w.path);
      ui.plain(`  ${ok ? "removed" : "FAILED"}  ${w.branch}  ${w.path}`);
    } else {
      ui.plain(`  would remove  ${w.branch}  ${w.path}`);
    }
  }
  for (const w of kept) ui.plain(`  keep (${classifyWorktree(w)})  ${w.branch}  ${w.path}`);
  ui.ok(`${removable.length} removable, ${kept.length} kept.`);
  return 0;
}

async function cmdAutoupdate(args: Args): Promise<number> {
  if (!requireDarwinHost("autoupdate")) return 2;
  const sub = args._[1] ?? "status";
  const vm = str(args.flags, "vm") ?? "default";

  if (sub === "install") {
    // Native install: the same launcher runs `noelle sync` (which dispatches to
    // the native path), plus a post-commit hook so commits deploy immediately.
    const nativeCfg = loadConfig();
    if (isNativeRuntime(nativeCfg)) {
      const repoRoot = str(args.flags, "repo")
        ? expandHome(str(args.flags, "repo")!)
        : findRepoRoot();
      const branch = str(args.flags, "branch") ?? nativeCfg!.autoUpdate.branch;
      const intervalMinutes =
        Number(str(args.flags, "interval")) || nativeCfg!.autoUpdate.intervalMinutes;
      ui.step("Installing the auto-update LaunchAgent (native)");
      ui.info(`repo: ${repoRoot}`);
      ui.info(`tracking: ${branch} every ${intervalMinutes}min`);
      const pathDirs = await resolvePathDirs();
      const nodeBin = await resolveStableNode();
      await autoupdateInstall({ repoRoot, nodeBin, pathDirs, intervalMinutes });
      installPostCommitHook(repoRoot, {
        nodeBin,
        cliEntry: resolve(repoRoot, "apps/cli/dist/index.js"),
      });
      nativeCfg!.autoUpdate = { ...nativeCfg!.autoUpdate, enabled: true, branch, intervalMinutes };
      saveConfig(nativeCfg!);
      ui.ok(
        `Installed (${AUTOUPDATE_LABEL}). \`noelle sync\` runs every ${intervalMinutes}min; a post-commit hook fires it on each commit.`,
      );
      ui.info(`Test now:  launchctl kickstart -k gui/$(id -u)/${AUTOUPDATE_LABEL}`);
      return 0;
    }
    if (!(await limaInstalled())) {
      ui.err("limactl not found — this self-host runs inside a Lima VM.");
      return 1;
    }
    const config = await readVmConfig(vm);
    if (!config) {
      ui.err(`Could not read VM config for "${vm}"; start + init it first (\`noelle up\`).`);
      return 1;
    }
    const repoRoot = str(args.flags, "repo")
      ? expandHome(str(args.flags, "repo")!)
      : findRepoRoot();
    const branch = str(args.flags, "branch") ?? config.autoUpdate.branch;
    const intervalMinutes =
      Number(str(args.flags, "interval")) || config.autoUpdate.intervalMinutes;
    ui.step("Installing the auto-update LaunchAgent");
    ui.info(`repo (host): ${repoRoot}`);
    ui.info(`tracking: ${branch} every ${intervalMinutes}min`);
    const pathDirs = await resolvePathDirs();
    const nodeBin = await resolveStableNode();
    await autoupdateInstall({ repoRoot, nodeBin, pathDirs, intervalMinutes });

    config.autoUpdate = { ...config.autoUpdate, enabled: true, branch, intervalMinutes };
    await writeVmConfig(vm, config);
    ui.ok(
      `Installed (${AUTOUPDATE_LABEL}). The Mac FFs ${branch}, builds, and rsyncs into "${vm}" every ${intervalMinutes}min.`,
    );
    ui.info(`Test now without waiting:  launchctl kickstart -k gui/$(id -u)/${AUTOUPDATE_LABEL}`);
    return 0;
  }
  if (sub === "uninstall") {
    await autoupdateUninstall();
    const config = await readVmConfig(vm);
    if (config) {
      config.autoUpdate.enabled = false;
      await writeVmConfig(vm, config);
    }
    ui.ok("Auto-update LaunchAgent removed. The VM will no longer track the branch.");
    return 0;
  }
  // status (default)
  const st = await autoupdateStatus();
  ui.step("Auto-update (periodic Mac → VM sync)");
  ui.plain(`  loaded     ${st.loaded ? "✓ yes" : "· no"}`);
  ui.plain(`  plist      ${st.plistExists ? st.plist : "(not installed)"}`);
  if (st.lastLog) {
    ui.plain("  recent log:");
    for (const line of st.lastLog.split("\n")) ui.plain(`    ${line}`);
  }
  return 0;
}

// `noelle doctor` overloads one verb: bare `doctor` runs the read-only
// self-host preflight it always has; `doctor status|start|logs` drive the
// actuator-doctor watchdog (apps/actuator-doctor). One command name — as
// docs/chrome-bridge.md prescribes — without breaking the preflight.
async function cmdDoctor(args: Args): Promise<number> {
  const sub = args._[1];
  if (sub === "status") return doctorStatus();
  if (sub === "start") return doctorStart(args);
  if (sub === "logs") return doctorLogs(args);
  // No sub (or an unrecognized token) → the self-host preflight, unchanged.
  return doctorPreflight();
}

// Read-only self-host preflight (container runtime, ports, provider creds, WIF
// leak check) — the original `noelle doctor`, untouched.
async function doctorPreflight(): Promise<number> {
  const config = loadConfig() ?? defaultConfig();
  ui.step(`Doctor (${platform()})`);
  const runtime = await detectContainerRuntime();
  ui.plain(`  container rt   ${runtime ? `✓ ${runtime}` : "· none (native PG mode)"}`);
  ui.plain(`  pnpm           ${(await hasCommand("pnpm")) ? "✓" : "✗ required"}`);
  ui.plain(
    `  cloudflared    ${(await cloudflaredInstalled()) ? "✓ (tunnel ready)" : "· optional"}`,
  );
  if (platform() === "darwin") {
    ui.plain(
      `  tailscale      ${(await tailscaleInstalled()) ? "✓ (phone access ready)" : "· optional"}`,
    );
    ui.plain(`  limactl        ${(await limaInstalled()) ? "✓ (autostart ready)" : "· optional"}`);
    ui.plain(
      `  autostart      ${(await autostartLoaded()) ? "✓ login agent loaded" : "· not installed"}`,
    );
  }

  for (const [label, port] of [
    ["postgres", config.postgres.port],
    ["api-vm", config.ports.apiVm],
    ["dashboard", config.ports.app],
  ] as const) {
    const inUse = await portInUse(port);
    ui.plain(`  port ${port} (${label})  ${inUse ? "· in use (ok if Noelle owns it)" : "✓ free"}`);
  }

  // WIF leak check — these must be ABSENT or apps/app uses the IAM connector.
  const wif = [
    "NOELLE_GCP_PROJECT_NUMBER",
    "NOELLE_GCP_POOL_ID",
    "NOELLE_GCP_PROVIDER_ID",
    "NOELLE_GCP_SA_EMAIL",
    "NOELLE_CLOUDSQL_INSTANCE",
  ].filter((k) => process.env[k]);
  if (wif.length > 0)
    ui.warn(
      `WIF env vars present (${wif.join(", ")}) — unset them; they force the GCP DB connector.`,
    );
  else ui.ok("no WIF env vars set");

  const { missing } = collectProviderEnv(config.llmProvider, process.env);
  if (missing.length > 0)
    ui.warn(`provider "${config.llmProvider}" missing: ${missing.join(", ")}`);
  else ui.ok(`provider "${config.llmProvider}" creds present`);
  return 0;
}

/** A fetch that failed because nothing is listening (bridge/doctor is down). */
function isConnRefused(e: unknown): boolean {
  const code = (e as { cause?: { code?: string }; code?: string })?.cause?.code ?? (e as { code?: string })?.code;
  return code === "ECONNREFUSED" || (e instanceof Error && /ECONNREFUSED/.test(e.message));
}

// `noelle doctor status` — read the actuator-doctor's latest tick from
// ~/.noelle/doctor/last-report.json (a DoctorReport) and summarize it. The
// doctor writes this file each tick; absence = it hasn't run yet.
async function doctorStatus(): Promise<number> {
  const p = paths();
  const reportPath = resolve(p.doctor, "last-report.json");
  if (!existsSync(reportPath)) {
    ui.info("The actuator-doctor hasn't run yet (no ~/.noelle/doctor/last-report.json).");
    ui.info("Start it with `noelle doctor start` (or `noelle up`).");
    return 0;
  }
  let report: DoctorReport;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8")) as DoctorReport;
  } catch (e) {
    ui.err(`couldn't read the doctor report: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  ui.step("Actuator Doctor status");
  ui.plain(`  overall     ${report.healthy ? "✓ healthy" : "✗ unhealthy"}  (tick ${report.tick}, ${report.at})`);
  ui.plain(`  autofix     ${report.autofixEnabled ? "ON (LLM fixer armed)" : "off (NOELLE_DOCTOR_AUTOFIX=0)"}`);
  ui.plain("  targets:");
  const targets = report.targets ?? [];
  for (const t of targets) {
    const flags = `${t.armed ? "armed" : "off"}, ${t.inWindow ? "in-window" : "out-of-window"}`;
    ui.plain(`    ${t.healthy ? "✓" : "✗"} ${t.target}  (${flags})`);
    if (t.openIncident) {
      const inc = t.openIncident;
      ui.plain(
        `        ⚠ ${inc.signatureId ?? "unmatched"}: ${inc.summary} → ${inc.actionTaken}${inc.resolved ? " (resolved)" : ""}`,
      );
    }
  }
  const openCount = targets.filter((t) => t.openIncident).length;
  ui.plain(`  open incidents  ${openCount}`);
  const remed = Object.entries(report.remediationsThisHour ?? {});
  if (remed.length > 0)
    ui.plain(`  remediations/hr ${remed.map(([k, v]) => `${k}=${v}`).join(", ")}`);
  return report.healthy ? 0 : 1;
}

// Ensure the live ecosystem file actually contains `appName`. `noelle sync`
// never regenerates the ecosystem, so an app added to generateEcosystem() after
// the last `noelle init` is ABSENT from the live file — and `pm2 start --only
// <app>` on a file that lacks it silently starts nothing. Regenerate from config
// when the entry is missing (safe + idempotent: the generated file reads env
// LIVE from ~/.noelle/.env at pm2-load time, so a regen only adds entries, it
// never snapshots or drifts env). Returns false (with guidance) if there is no
// config to regenerate from. When the entry is already present, the file is left
// untouched.
function ensureEcosystemHasApp(repoRoot: string, p: ReturnType<typeof ensureHome>, appName: string): boolean {
  if (existsSync(p.ecosystem) && readFileSync(p.ecosystem, "utf8").includes(`"${appName}"`)) {
    return true;
  }
  const config = loadConfig();
  if (!config) {
    ui.err("No noelle config yet — run `noelle init` first.");
    return false;
  }
  writeEcosystem({ config, repoRoot, paths: p });
  ui.info(`Regenerated ${p.ecosystem} to include "${appName}".`);
  return true;
}

// `noelle doctor start` — first-launch the actuator-doctor pm2 app. `noelle
// sync` never starts NEW apps, so this (or `noelle up`) is how it comes online
// after the wiring lands. No-op if already online.
async function doctorStart(args: Args): Promise<number> {
  const repoRoot = str(args.flags, "repo") ? expandHome(str(args.flags, "repo")!) : findRepoRoot();
  const p = ensureHome();
  if (!ensureEcosystemHasApp(repoRoot, p, "actuator-doctor")) return 1;
  const already = (await pm2Status(repoRoot)).find((x) => x.name === "actuator-doctor");
  if (already?.status === "online") {
    ui.info(`actuator-doctor already online (↺${already.restarts}, ${already.memoryMb}MB).`);
    return 0;
  }
  ui.step("Starting actuator-doctor (pm2)");
  await pm2StartApp(repoRoot, p.ecosystem, "actuator-doctor");
  ui.ok("actuator-doctor started. `noelle doctor status` for its latest tick.");
  return 0;
}

// `noelle doctor logs [n]` — one-shot tail of the actuator-doctor pm2 logs.
async function doctorLogs(args: Args): Promise<number> {
  const repoRoot = findRepoRoot();
  const n = Number(args._[2]) || 80;
  await pm2LogsOnce(repoRoot, "actuator-doctor", n);
  return 0;
}

// ---------------------------------------------------------------------------
// bridge — Chrome Bridge control server (Claude's hands on Chrome). Thin
// status/start/logs over the loopback HTTP server + pm2. `noelle sync` never
// starts NEW apps, so `noelle bridge start` is the first-launch path.
// ---------------------------------------------------------------------------
async function cmdBridge(args: Args): Promise<number> {
  const repoRoot = str(args.flags, "repo") ? expandHome(str(args.flags, "repo")!) : findRepoRoot();
  const p = ensureHome();
  const sub = args._[1] ?? "status";

  if (sub === "start") {
    if (!ensureEcosystemHasApp(repoRoot, p, "chrome-bridge")) return 1;
    const already = (await pm2Status(repoRoot)).find((x) => x.name === "chrome-bridge");
    if (already?.status === "online") {
      ui.info(`chrome-bridge already online (↺${already.restarts}, ${already.memoryMb}MB).`);
      return 0;
    }
    ui.step("Starting chrome-bridge (pm2)");
    await pm2StartApp(repoRoot, p.ecosystem, "chrome-bridge");
    ui.ok("chrome-bridge started. `noelle bridge status` to check the extension link.");
    return 0;
  }

  if (sub === "logs") {
    const n = Number(args._[2]) || 80;
    await pm2LogsOnce(repoRoot, "chrome-bridge", n);
    return 0;
  }

  // status (default): hit /health (no auth) and summarize the extension link.
  const env = { ...process.env, ...readEnvFile(p.envFile) };
  const port = Number(env.NOELLE_BRIDGE_PORT) || 18792;
  const url = `http://127.0.0.1:${port}/health`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    const health = (await res.json()) as BridgeHealth;
    ui.step(`Chrome Bridge (:${port})`);
    ui.plain(
      `  server      ${health.ok ? "✓ ok" : "✗ not ok"}  (v${health.version}, up ${Math.round((health.uptime_ms ?? 0) / 1000)}s)`,
    );
    ui.plain(
      `  extension   ${health.ext_connected ? `✓ connected${health.ext_version ? " (v" + health.ext_version + ")" : ""}` : "✗ not connected — load unpacked at chrome://extensions"}`,
    );
    ui.plain(`  chrome      ${health.chrome_version ?? "(unknown)"}`);
    ui.plain(
      `  sources     ${health.sources && health.sources.length > 0 ? health.sources.join(", ") : "(none seen yet)"}`,
    );
    return health.ok ? 0 : 1;
  } catch (e) {
    if (isConnRefused(e)) {
      ui.err("bridge not running — run `noelle bridge start`");
      return 1;
    }
    ui.err(`bridge status failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// vega — X-intern lifecycle + spend cap
// ---------------------------------------------------------------------------
async function cmdVega(args: Args): Promise<number> {
  const p = ensureHome();
  const config = loadConfig() ?? defaultConfig();
  const secrets = loadOrCreateSecrets(p);
  const dbUrl = adminUrlFor(config, secrets);
  const sub = args._[1] ?? "status";

  if (sub === "enable") {
    if (str(args.flags, "budget-cents"))
      config.budgetCapCents = Number(str(args.flags, "budget-cents"));
    const v = await vegaEnable({
      dbUrl,
      orgSlug: config.orgSlug,
      budgetCapCents: config.budgetCapCents,
      log: (m) => ui.ok(m),
    });
    return v.found ? 0 : 1;
  }
  if (sub === "disable") {
    await vegaDisable({ dbUrl, orgSlug: config.orgSlug });
    ui.ok("Vega paused (status='paused'); workers idle within one poll cycle.");
    return 0;
  }
  if (sub === "style") {
    return cmdVegaStyle(args, dbUrl, config.orgSlug);
  }
  // status (default)
  const v = await vegaState({ dbUrl, orgSlug: config.orgSlug });
  if (!v.found) {
    ui.err(`No x_intern instance for org "${config.orgSlug}".`);
    return 1;
  }
  const cap =
    v.budgetCapCents == null ? "none (UNCAPPED)" : `$${(v.budgetCapCents / 100).toFixed(2)}`;
  ui.step("Vega status");
  ui.plain(`  status        ${v.status}`);
  ui.plain(`  spend cap     ${cap}`);
  ui.plain(`  discovery     ${v.flags.discovery ? "on" : "off"}`);
  ui.plain(`  classifier    ${v.flags.classifier ? "on" : "off"}`);
  ui.plain(`  drafter       ${v.flags.drafter ? "on" : "off"}`);
  ui.plain(`  send          ${v.flags.send ? "ON (posts!)" : "off"}`);
  ui.plain(`  auto-send     ${v.flags.autoSend ? "ON (posts!)" : "off"}`);
  if (v.budgetCapCents == null)
    ui.warn("No spend cap set — run `noelle vega enable` to apply one.");
  return 0;
}

// `noelle vega style <add|remove|pin|unpin|run|list>` — the Account Feeder: pick
// the X account(s) whose FORM becomes the voice of Vega's posts (pin one exact
// voice, or blend several). CONTENT still comes from the operator's own vault.
async function cmdVegaStyle(args: Args, dbUrl: string, orgSlug: string): Promise<number> {
  const sub = args._[2] ?? "list";
  const rawHandle = (args._[3] ?? "").trim();
  const shownHandle = rawHandle.replace(/^@/, "").toLowerCase();

  if (sub === "add") {
    if (!rawHandle) { ui.err("usage: noelle vega style add <handle> [--display <name>] [--note <note>]"); return 1; }
    const r = await vegaStyleAddSource({
      dbUrl, orgSlug, handle: rawHandle,
      displayName: str(args.flags, "display") ?? null,
      note: str(args.flags, "note") ?? null,
    });
    if (!r.found) { ui.err(`No x_intern (Vega) instance for org "${orgSlug}".`); return 1; }
    ui.ok(`Added X style source @${shownHandle}. Pull it with \`noelle vega style run\`.`);
    return 0;
  }
  if (sub === "remove" || sub === "disable") {
    if (!rawHandle) { ui.err("usage: noelle vega style remove <handle>"); return 1; }
    const r = await vegaStyleRemoveSource({ dbUrl, orgSlug, handle: rawHandle });
    if (!r.found) { ui.err(`No x_intern (Vega) instance for org "${orgSlug}".`); return 1; }
    ui.ok(r.removed ? `Disabled X style source @${shownHandle}.` : "No such X style source.");
    return 0;
  }
  if (sub === "pin") {
    if (!rawHandle) { ui.err("usage: noelle vega style pin <handle>"); return 1; }
    const r = await vegaStylePin({ dbUrl, orgSlug, handle: rawHandle });
    if (!r.found) { ui.err(`No x_intern (Vega) instance for org "${orgSlug}".`); return 1; }
    ui.ok(`Pinned Vega's voice to @${shownHandle}. Set NOELLE_DRAFTER_STYLE=1, then \`noelle vega style run\` to learn it.`);
    return 0;
  }
  if (sub === "unpin") {
    const r = await vegaStyleUnpin({ dbUrl, orgSlug });
    if (!r.found) { ui.err(`No x_intern (Vega) instance for org "${orgSlug}".`); return 1; }
    ui.ok("Unpinned — Vega blends the FORM of all enabled style sources.");
    return 0;
  }
  if (sub === "run") {
    const r = await vegaStyleRun({ dbUrl, orgSlug });
    if (!r.found) { ui.err(`No x_intern (Vega) instance for org "${orgSlug}".`); return 1; }
    ui.ok("Feeder run requested — the account-feeder worker pulls the sources on its next poll.");
    return 0;
  }
  // list (default)
  const s = await vegaStyleList({ dbUrl, orgSlug });
  if (!s.found) { ui.err(`No x_intern (Vega) instance for org "${orgSlug}".`); return 1; }
  ui.step("Vega style — Account Feeder (voice of our posts)");
  ui.plain(`  pinned voice    ${s.pinnedStyleHandle ? "@" + s.pinnedStyleHandle : "none (blend of all enabled sources)"}`);
  ui.plain(`  last pull       ${s.lastRunAt ?? "never"}`);
  ui.plain(`  corpus posts    ${s.stylePostCount}`);
  ui.plain(`  ultra profiles  ${s.ultraProfileCount}`);
  if (s.sources.length === 0) {
    ui.warn("No style sources yet — add one with `noelle vega style add <handle>`.");
  } else {
    ui.plain("  sources:");
    for (const src of s.sources) {
      ui.plain(
        `    · @${src.handle}${src.displayName ? " (" + src.displayName + ")" : ""} — ${src.enabled ? "enabled" : "disabled"}${src.lastPulledAt ? ", pulled " + src.lastPulledAt : ""}`,
      );
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// lyra — LinkedIn-intern (Lyra) on-demand tools. Today: `followup`, the
// connection follow-up — name someone you just connected with and Lyra scrapes
// their posts + authored comments and prints a brief (common ground, talking
// points, genuine questions, a warm follow-up DM). Draft-only, like all of Lyra.
// Thin wrapper: it execs apps/linkedin-intern/run.sh, which loads ~/.noelle/.env
// and runs the one-shot worker on this (residential) VM.
// ---------------------------------------------------------------------------
async function cmdLyra(args: Args): Promise<number> {
  const sub = args._[1];
  if (sub !== "followup") {
    ui.err(`unknown lyra subcommand: ${sub ?? "(none)"} — try: noelle lyra followup <profile-url>`);
    return 1;
  }
  // The person is positional (`noelle lyra followup <url>`) or `--person <url>`.
  const person = str(args.flags, "person") ?? args._[2];
  if (!person) {
    ui.err(
      "usage: noelle lyra followup <profile URL | /in/slug | slug> [--posts N] [--comments N] [--json]",
    );
    return 1;
  }
  const repoRoot = str(args.flags, "repo") ? expandHome(str(args.flags, "repo")!) : findRepoRoot();
  const appDir = resolve(repoRoot, "apps/linkedin-intern");
  const runSh = resolve(appDir, "run.sh");
  const passthru = ["followup", "--person", person];
  if (str(args.flags, "posts")) passthru.push("--posts", str(args.flags, "posts")!);
  if (str(args.flags, "comments")) passthru.push("--comments", str(args.flags, "comments")!);
  if (bool(args.flags, "json")) passthru.push("--json");
  // run.sh loads ~/.noelle/.env for the one-shot and streams stdout straight to
  // the terminal (inherit). allowFailure so we return the worker's exit code
  // instead of throwing on a non-zero (e.g. "no posts found").
  const r = await run(runSh, passthru, { cwd: appDir, inherit: true, allowFailure: true });
  if (r.code === 78) {
    ui.err("Lyra isn't built yet — run `noelle up --workers` (or build apps/linkedin-intern) first.");
  }
  return r.code;
}

// ---------------------------------------------------------------------------
// brand — operator questions + message styles (tailors replies + DMs)
// ---------------------------------------------------------------------------
async function cmdBrand(args: Args): Promise<number> {
  const p = ensureHome();
  const config = loadConfig() ?? defaultConfig();
  const secrets = loadOrCreateSecrets(p);
  const dbUrl = adminUrlFor(config, secrets);
  const sub = args._[1] ?? "show";

  if (sub === "init") {
    const r = initBrandFile(p);
    if (r.created) {
      ui.ok(`Scaffolded ${r.path}`);
      ui.info("Answer the questions in it (persona, product, pitch policy, reply/DM styles, Q&A),");
      ui.info("then run `noelle brand apply` (or `noelle up` re-applies it automatically).");
    } else {
      ui.info(`${r.path} already exists — edit it, then \`noelle brand apply\`.`);
    }
    return 0;
  }
  if (sub === "apply") {
    let brand;
    try {
      brand = loadBrandFile(p);
    } catch (err) {
      ui.err((err as Error).message);
      return 1;
    }
    const n = await applyBrand({ dbUrl, orgSlug: config.orgSlug, brand });
    if (n === 0) {
      ui.err(`No drafting instances for org "${config.orgSlug}" — run \`noelle init\` first.`);
      return 1;
    }
    ui.ok(
      `Brand config applied to ${n} drafting instance${n === 1 ? "" : "s"} (X / LinkedIn / Reddit).`,
    );
    if (!brandConfigHasContent(brand))
      ui.warn("Config is effectively empty — drafter will use the generic voice.");
    return 0;
  }
  // show (default)
  const brand = await showBrand({ dbUrl, orgSlug: config.orgSlug });
  if (!brand) {
    ui.err(`No x_intern instance for org "${config.orgSlug}".`);
    return 1;
  }
  ui.step("Vega brand config (live, from DB)");
  ui.plain(JSON.stringify(brand, null, 2));
  if (!brandConfigHasContent(brand))
    ui.warn("Empty — run `noelle brand init` then `noelle brand apply`.");
  return 0;
}

// ---------------------------------------------------------------------------
// rollup — aggregate llm_calls → org_spend_month (so the nav-pill / billing
// figures match live spend). Hits the app's /api/cron/sync-spend route, which
// is the canonical (and only) writer of org_spend_month. Run by the
// noelle-spend-rollup pm2 process with --watch; also runnable one-shot.
// ---------------------------------------------------------------------------
async function runRollupOnce(config: SelfHostConfig, cronSecret: string): Promise<boolean> {
  const url = `http://127.0.0.1:${config.ports.app}/api/cron/sync-spend`;
  try {
    const res = await fetch(url, {
      headers: cronSecret ? { Authorization: `Bearer ${cronSecret}` } : {},
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function cmdRollup(args: Args): Promise<number> {
  const p = ensureHome();
  const config = loadConfig() ?? defaultConfig();
  const secrets = loadOrCreateSecrets(p);
  const intervalMs = Number(str(args.flags, "interval-ms") ?? 5 * 60_000);

  if (bool(args.flags, "watch")) {
    ui.info(
      `spend-rollup watching (every ${Math.round(intervalMs / 1000)}s) → ${`:${config.ports.app}/api/cron/sync-spend`}`,
    );
    // Run forever; pm2 keeps this process online. Each tick is best-effort —
    // a transient app restart just means the next tick catches up.
    // eslint-disable-next-line no-constant-condition
    for (;;) {
      await runRollupOnce(config, secrets.cronSecret);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  const ok = await runRollupOnce(config, secrets.cronSecret);
  ui.plain(ok ? "spend rollup ok" : "spend rollup failed (is the dashboard up?)");
  return ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// http helpers
// ---------------------------------------------------------------------------
async function probeHttp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    return res.status < 500;
