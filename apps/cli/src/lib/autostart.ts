import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { noelleHome } from "../config.js";
import { run } from "./platform.js";
import { launchAgentPath, renderHostLauncher, renderHostPlist } from "./host-launch.js";

/**
 * macOS login auto-start for the self-hosted Noelle (host-side).
 *
 * A LaunchAgent (RunAtLoad) invokes a generated launcher on login; the launcher
 * runs `noelle autostart-run`, which starts the Lima VM, brings Noelle up inside
 * it, and re-exposes the dashboard over Tailscale. launchd gives jobs a minimal
 * PATH, so the launcher prepends the dirs where limactl / tailscale / node live.
 */

export const LABEL = "com.noelle.autostart";

/** Mac-side ~/.noelle/host — holds the launcher + its log (NOT the VM config). */
export function hostDir(): string {
  return resolve(noelleHome(), "host");
}
export function launcherPath(): string {
  return resolve(hostDir(), "autostart.sh");
}
export function logPath(): string {
  return resolve(hostDir(), "autostart.log");
}
export function plistPath(): string {
  return launchAgentPath(LABEL);
}

export interface LauncherInputs {
  nodeBin: string;
  cliEntry: string; // absolute path to apps/cli/dist/index.js
  pathDirs: string[]; // dirs to prepend to PATH (homebrew, node, etc.)
  home?: string;
  vm: string; // Lima VM to start (baked in — the host has no config to read first)
}

/** The login launcher script (pure — snapshot-tested). */
export function renderLauncher(i: LauncherInputs): string {
  return renderHostLauncher({ ...i, args: ["autostart-run", "--vm", i.vm] });
}

export interface PlistInputs {
  label: string;
  launcher: string;
  log: string;
}

/**
 * The LaunchAgent plist (pure — snapshot-tested). ProcessType MUST be
 * Interactive: launchd's Background type clamps the job to background QoS, and
 * every descendant inherits the clamp — including the pm2 daemon and the whole
 * runtime it spawns (dashboard + workers pinned to efficiency cores, nice 5).
 */
export function renderPlist(i: PlistInputs): string {
  return renderHostPlist({ ...i, processType: "Interactive" });
}

function guiDomain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

export interface InstallInputs {
  repoRoot: string;
  nodeBin: string;
  pathDirs: string[];
  vm: string;
}

/** Write the launcher + plist and (re)load the LaunchAgent. */
export async function install(i: InstallInputs): Promise<void> {
  mkdirSync(hostDir(), { recursive: true });
  mkdirSync(resolve(plistPath(), ".."), { recursive: true });

  const launcher = renderLauncher({
    nodeBin: i.nodeBin,
    cliEntry: resolve(i.repoRoot, "apps/cli/dist/index.js"),
    pathDirs: i.pathDirs,
    home: noelleHome(),
    vm: i.vm,
  });
  writeFileSync(launcherPath(), launcher, { mode: 0o755 });
  chmodSync(launcherPath(), 0o755);

  writeFileSync(plistPath(), renderPlist({ label: LABEL, launcher: launcherPath(), log: logPath() }), {
    mode: 0o644,
  });

  // Reload: bootout any prior instance (ignore failure), then bootstrap.
  await run("launchctl", ["bootout", `${guiDomain()}/${LABEL}`], { allowFailure: true });
  await run("launchctl", ["bootstrap", guiDomain(), plistPath()], { inherit: true });
}

/** Unload + remove the LaunchAgent (leaves the launcher/log in place). */
export async function uninstall(): Promise<void> {
  await run("launchctl", ["bootout", `${guiDomain()}/${LABEL}`], { allowFailure: true });
  if (existsSync(plistPath())) rmSync(plistPath());
}

/** Run the login job now, without waiting for a reboot. */
export async function kickstart(): Promise<void> {
  await run("launchctl", ["kickstart", "-k", `${guiDomain()}/${LABEL}`], { allowFailure: true });
}

export async function isLoaded(): Promise<boolean> {
  const r = await run("launchctl", ["print", `${guiDomain()}/${LABEL}`], { allowFailure: true });
  return r.code === 0;
}

export interface AutostartStatus {
  loaded: boolean;
  plist: string;
  plistExists: boolean;
  lastLog: string | null;
}

export async function status(): Promise<AutostartStatus> {
  const plist = plistPath();
  let lastLog: string | null = null;
  if (existsSync(logPath())) {
    const lines = readFileSync(logPath(), "utf8").trim().split("\n");
    lastLog = lines.slice(-8).join("\n") || null;
  }
  return { loaded: await isLoaded(), plist, plistExists: existsSync(plist), lastLog };
}
