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
