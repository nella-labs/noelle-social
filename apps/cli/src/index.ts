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
