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
