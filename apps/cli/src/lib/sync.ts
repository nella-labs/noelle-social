import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { run } from "./platform.js";
import { shell as limaShell } from "./lima.js";

/**
 * Mac → VM code sync (host-side). The VM has no GitHub auth and only 4GB RAM —
 * too little for `next build` (it OOM-kills). So the Mac (authed + roomy) is the
 * gateway: it fast-forwards the tracked branch, BUILDS here, then rsyncs the repo
 * INCLUDING the build output (.next, dist) into the VM over the Lima SSH. The VM
 * never builds — it just `next start`s the shipped artifacts.
 */

/** Files synced INCLUDING build output; node_modules/.git/worktrees stay VM-local. */
export const RSYNC_EXCLUDES = [
  ".git",
  "node_modules",
  ".claude/worktrees",
  "pgdata",
  "*.log",
] as const;

export function limaSshConfig(vm: string): string {
  return resolve(homedir(), ".lima", vm, "ssh.config");
}
export function limaHost(vm: string): string {
  return `lima-${vm}`;
}

/** rsync args (pure — unit-tested). `src` should end with `/` to copy contents. */
export function rsyncArgs(sshConfig: string, src: string, dest: string): string[] {
  const excludes = RSYNC_EXCLUDES.flatMap((e) => ["--exclude", e]);
  return ["-az", "--delete", "-e", `ssh -F ${sshConfig}`, ...excludes, src, dest];
}

/**
 * pnpm install args for the pre-build install step (pure — unit-tested).
 *
 * Every deploy installs before building: a merged PR that adds a workspace
 * package or dependency otherwise breaks the deploy tick with "Cannot find
 * module" until someone hand-installs in the main checkout (first hit by
 * PR #472, which added packages/worker-runtime). When nothing changed the
 * install is a ~0.5s no-op.
 *
 * `--prefer-offline` keeps the step network-tolerant (the store already has
 * everything on a routine deploy). Deliberately NOT `--frozen-lockfile`: the
 * deploy loop must be robust, not strict — a manual `noelle deploy` ships the
 * working tree as-is, mid-edit lockfile included, and a strict install would
 * turn that into a deploy failure.
 */
export function pnpmInstallArgs(): string[] {
  return ["install", "--prefer-offline"];
}

/** Fast-forward the Mac checkout to origin/<branch>; return the resulting sha. */
export async function macFastForward(repoRoot: string, branch: string): Promise<string> {
  await run("git", ["-C", repoRoot, "fetch", "origin", branch], { inherit: true });
  const cur = (
    await run("git", ["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"], { allowFailure: true })
  ).stdout.trim();
  if (cur !== branch) await run("git", ["-C", repoRoot, "checkout", branch], { inherit: true });
  await run("git", ["-C", repoRoot, "merge", "--ff-only", `origin/${branch}`], { inherit: true });
  return (await run("git", ["-C", repoRoot, "rev-parse", "HEAD"])).stdout.trim();
}

/** rsync the built repo into the VM's ~/noelle. */
export async function syncToVm(repoRoot: string, vm: string): Promise<void> {
  const src = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
  const dest = `${limaHost(vm)}:noelle/`;
  await run("rsync", rsyncArgs(limaSshConfig(vm), src, dest), { inherit: true });
}

/** The stamp file that ships to the VM so its running SHA is knowable. */
export const DEPLOY_STAMP_FILE = ".noelle-deployed";

export interface DeployStamp {
  sha: string;
  builtAt: string;
  builtBy: string;
}

/** Pure — the payload written into the repo root before rsync. */
export function deployStampPayload(sha: string, host: string, nowIso: string): DeployStamp {
  return { sha, builtAt: nowIso, builtBy: host };
}

/**
 * Write `.noelle-deployed` at the repo root. It is NOT in RSYNC_EXCLUDES, so it
 * rsyncs into the VM — the VM's `git HEAD` is a stale artifact (never pulled),
 * so this file is the only trustworthy record of what code is actually running.
 */
export function writeDeployStamp(repoRoot: string, stamp: DeployStamp): void {
  const path = repoRoot.endsWith("/")
    ? `${repoRoot}${DEPLOY_STAMP_FILE}`
    : `${repoRoot}/${DEPLOY_STAMP_FILE}`;
  writeFileSync(path, JSON.stringify(stamp, null, 2) + "\n", { mode: 0o644 });
}

/**
 * The VM-side restart command. Runs in the VM login shell (`bash -lc`). Uses the
 * SAME pm2 resolution the workers were STARTED with (`pnpm --filter @noelle/cli
 * exec pm2`) so it talks to the correct daemon — the PATH `pm2` on the VM is a
 * different version bound to an empty daemon (see docs/runbook.md). `restart
 * <ecosystem>` reloads code for every noelle-* app; env is unchanged by a code
 * deploy so a plain restart (not delete+start) is correct.
 */
export function vmRestartCommand(): string {
  return "cd ~/noelle && pnpm --filter @noelle/cli exec pm2 restart ~/.noelle/ecosystem.config.cjs --update-env";
}

/** Restart the VM's pm2 workers so they pick up freshly rsynced code. */
export async function restartVmWorkers(vm: string): Promise<{ ok: boolean; detail: string }> {
  const r = await limaShell(vm, vmRestartCommand());
  return { ok: r.code === 0, detail: (r.stderr || r.stdout).trim().slice(-500) };
}

// ---------------------------------------------------------------------------
// Native (host-run) deploy helpers. No VM: pull origin when safe, build the
// local checkout (dashboard included, since it serves a prod build), restart
// every local pm2 app.
// ---------------------------------------------------------------------------

/** Local HEAD sha of the working checkout (what a native deploy builds). */
export async function localHeadSha(repoRoot: string): Promise<string> {
  return (await run("git", ["-C", repoRoot, "rev-parse", "HEAD"])).stdout.trim();
}

/** Why the pre-build origin fast-forward did or did not happen. */
export type FfAction =
  | "fast-forwarded"
  | "up-to-date"
  | "skipped-branch"
  | "skipped-dirty"
  | "skipped-ahead"
  | "skipped-compare"
  | "merge-failed"
  | "fetch-failed";

/**
 * Dirty check for the pull gate. `-uno` matters: untracked files (vendor
 * skills, scratch scripts) never block a fast-forward merge, and the real
 * checkout always has some, so counting them would veto the pull forever.
 */
export const GIT_DIRTY_ARGS = ["status", "--porcelain", "-uno"] as const;

export interface FfOutcome {
  action: FfAction;
  detail: string;
}

/**
 * Pure fast-forward policy (unit-tested): merge origin/<branch> only when the
 * checkout is on <branch>, the tree is clean, and local has no commits origin
 * lacks. Local work always wins: any skip leaves HEAD alone and the deploy
 * continues from it, so local dev still ships.
 */
export function ffDecision(facts: {
  currentBranch: string;
  branch: string;
  dirtyFiles: number;
  aheadCount: number | null;
  behindCount: number | null;
}): FfOutcome {
  if (facts.currentBranch !== facts.branch) {
    return {
      action: "skipped-branch",
      detail: `checkout is on ${facts.currentBranch || "(detached)"}, not ${facts.branch}`,
    };
  }
  if (facts.dirtyFiles > 0) {
    return { action: "skipped-dirty", detail: `${facts.dirtyFiles} uncommitted path(s)` };
  }
  if (facts.aheadCount === null || facts.behindCount === null) {
    return { action: "skipped-compare", detail: "could not count commits vs origin" };
  }
  if (facts.aheadCount > 0) {
    return {
      action: "skipped-ahead",
      detail: `local is ${facts.aheadCount} commit(s) ahead of origin/${facts.branch}`,
    };
  }
  if (facts.behindCount === 0) return { action: "up-to-date", detail: "local matches origin" };
  return {
    action: "fast-forwarded",
    detail: `${facts.behindCount} commit(s) behind origin/${facts.branch}`,
  };
}

/**
 * Bring the local checkout up to date with origin/<branch> before a native
 * build, so a PR merged on GitHub deploys WITHOUT a hand-pull. Fetch is
 * fail-open (offline ticks still deploy local HEAD). The merge itself runs
 * only when `ffDecision` says it is safe.
 */
export async function nativeFetchAndFastForward(
  repoRoot: string,
  branch: string,
): Promise<FfOutcome> {
  const fetched = await run("git", ["-C", repoRoot, "fetch", "origin", branch], {
    allowFailure: true,
  });
  if (fetched.code !== 0) {
    return {
      action: "fetch-failed",
      detail: (fetched.stderr || fetched.stdout).trim().slice(-200) || "git fetch failed",
    };
  }
  const cur = (
    await run("git", ["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"], { allowFailure: true })
  ).stdout.trim();
  const dirty = (
    await run("git", ["-C", repoRoot, ...GIT_DIRTY_ARGS], { allowFailure: true })
  ).stdout.trim();
  const count = async (range: string): Promise<number | null> => {
    const r = await run("git", ["-C", repoRoot, "rev-list", "--count", range], {
      allowFailure: true,
    });
    if (r.code !== 0) return null;
    const n = Number(r.stdout.trim());
    return Number.isFinite(n) ? n : null;
  };
  const outcome = ffDecision({
    currentBranch: cur,
    branch,
    dirtyFiles: dirty ? dirty.split("\n").length : 0,
    aheadCount: await count(`origin/${branch}..HEAD`),
    behindCount: await count(`HEAD..origin/${branch}`),
  });
  if (outcome.action !== "fast-forwarded") return outcome;
  // allowFailure: index.lock contention from a parallel git session must not
  // abort the tick; a failed merge just means this tick deploys local HEAD.
  const merged = await run("git", ["-C", repoRoot, "merge", "--ff-only", `origin/${branch}`], {
    allowFailure: true,
  });
  if (merged.code !== 0) {
    return {
      action: "merge-failed",
      detail: (merged.stderr || merged.stdout).trim().slice(-200) || "git merge --ff-only failed",
    };
  }
  return outcome;
}

/** Pure — is this a native (host-run) install? Tolerates null/partial config. */
export function isNativeRuntime(config: { runtime?: string } | null | undefined): boolean {
  return config?.runtime === "native";
}

// ---------------------------------------------------------------------------
// Deploy failure backoff. A sha that keeps failing must not rebuild and page
// every 10 minutes forever: page once, retry a bounded number of ticks, then
// hold until a new sha lands (or the operator forces a deploy).
// ---------------------------------------------------------------------------

export interface DeployFailureState {
  sha: string;
  attempts: number;
}

/** Auto ticks stop retrying a sha after this many consecutive failures. */
export const DEPLOY_MAX_ATTEMPTS = 3;

/**
 * Pure: fold a new failure into the state. `alert` is true only for the FIRST
 * failure of a given sha, so a broken build pages once instead of 144x/day.
 */
export function recordDeployFailure(
  prev: DeployFailureState | null | undefined,
  sha: string,
): { state: DeployFailureState; alert: boolean } {
  if (prev && prev.sha === sha) {
    return { state: { sha, attempts: prev.attempts + 1 }, alert: false };
  }
  return { state: { sha, attempts: 1 }, alert: true };
}

/** Pure: should an auto tick hold (skip) this sha after repeated failures? */
export function shouldHoldDeploy(
  prev: DeployFailureState | null | undefined,
  sha: string,
  max: number = DEPLOY_MAX_ATTEMPTS,
): boolean {
  return !!prev && prev.sha === sha && prev.attempts >= max;
}

// ---------------------------------------------------------------------------
// Stack self-heal. The auto tick used to exit early on an unchanged HEAD
// without ever looking at the stack, so a crash (reboot, wedged Postgres,
// dead pm2 daemon) stayed down until an operator noticed the page. Now every
// auto tick probes the stack first and runs the full bring-up when it is down
// — unless the operator stopped it on purpose (`noelle down` writes a marker).
// ---------------------------------------------------------------------------

export interface StackHealthFacts {
  postgresOk: boolean;
  apiOk: boolean;
  appOk: boolean;
  /** `noelle down` marker present — the stack is down on purpose. */
  markedDown: boolean;
}

export interface SelfHealDecision {
  heal: boolean;
  /** What is down (for the log/page), or why healing is skipped. */
  detail: string;
}

/** Pure (unit-tested): should this auto tick run the bring-up? */
export function selfHealDecision(f: StackHealthFacts): SelfHealDecision {
  const down = [
    !f.postgresOk && "postgres",
    !f.apiOk && "api-vm",
    !f.appOk && "dashboard",
  ].filter((x): x is string => typeof x === "string");
  if (down.length === 0) return { heal: false, detail: "" };
  if (f.markedDown) {
    return {
      heal: false,
      detail: `stack is down (${down.join(", ")}) but was stopped with \`noelle down\`; not self-healing`,
    };
  }
  return { heal: true, detail: down.join(", ") };
}

// ---------------------------------------------------------------------------
// Docs-only detection. A merge that changes nothing the runtime executes
// (docs, task notes, agent/skill definitions, any markdown) advances the
// stamp without a build or a 21-app restart.
// ---------------------------------------------------------------------------

/** Path prefixes that never require a build or restart. */
export const NO_BUILD_PREFIXES = ["docs/", "tasks/", ".agents/", ".claude/"] as const;

/**
 * Pure: does this changed-path list require no build? Empty input returns
 * false (an empty or failed diff must fall through to a full build).
 */
export function isDocsOnlyDiff(paths: string[]): boolean {
  if (paths.length === 0) return false;
  return paths.every(
    (p) => p.endsWith(".md") || NO_BUILD_PREFIXES.some((prefix) => p.startsWith(prefix)),
  );
}
