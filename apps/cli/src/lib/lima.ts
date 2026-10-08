import { hasCommand, run, type RunResult } from "./platform.js";
import { parseConfig, type SelfHostConfig } from "../config.js";

/**
 * Lima VM control for the host-side autostart flow.
 *
 * The self-host dashboard lives INSIDE a Lima VM; the Mac is the host. On login
 * we start the VM, bring Noelle up inside it, and expose its port over
 * Tailscale. The VM's `~/.noelle/config.json` is the source of truth, so we
 * read/write it through `limactl shell` rather than the (absent) Mac copy.
 */

export async function limaInstalled(): Promise<boolean> {
  return hasCommand("limactl");
}

/** True iff the named Lima VM reports STATUS=Running. */
export async function vmRunning(vm: string): Promise<boolean> {
  const r = await run("limactl", ["list", vm, "--format", "{{.Status}}"], { allowFailure: true });
  return r.stdout.trim().toLowerCase() === "running";
}

/** Start the VM (idempotent — `limactl start` no-ops if already running). */
export async function startVm(vm: string): Promise<void> {
  await run("limactl", ["start", vm], { inherit: true });
}

/** Run a command inside the VM's login shell, capturing output. */
export async function shell(vm: string, command: string): Promise<RunResult> {
  return run("limactl", ["shell", vm, "--", "bash", "-lc", command], { allowFailure: true });
}

/** Block until the VM answers a trivial shell command (or timeout). */
export async function waitVmReady(vm: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await shell(vm, "true");
    if (r.code === 0) return true;
    await new Promise((res) => setTimeout(res, 2000));
  }
  return false;
}

/** Read + parse the VM's ~/.noelle/config.json (the source of truth). */
export async function readVmConfig(vm: string): Promise<SelfHostConfig | null> {
  const r = await shell(vm, "cat ~/.noelle/config.json");
  if (r.code !== 0) return null;
  return parseConfig(r.stdout);
}

/**
 * Write config back to the VM's ~/.noelle/config.json. Ships the JSON as base64
 * so there's zero shell-quoting surface (the base64 alphabet can't break out of
 * the single-quoted command).
 */
export async function writeVmConfig(vm: string, config: SelfHostConfig): Promise<void> {
  const b64 = Buffer.from(JSON.stringify(config, null, 2) + "\n").toString("base64");
  const r = await shell(vm, `echo ${b64} | base64 -d > ~/.noelle/config.json`);
  if (r.code !== 0) throw new Error(`failed to write VM config: ${r.stderr || r.stdout}`);
}

/**
 * Resolve how to bring Noelle up inside the VM: `noelle up` if the CLI is on the
 * VM's PATH, else `cd <repo> && node apps/cli/dist/index.js up` with the repo
 * auto-located (the documented `~/noelle` checkout, else any pnpm-workspace.yaml
 * under the home dir). Falls back to `noelle up` if nothing is found.
 */
export async function resolveVmUpCommand(vm: string): Promise<string> {
  const onPath = await shell(vm, "command -v noelle");
  if (onPath.code === 0 && onPath.stdout.trim()) return "noelle up";

  const find = await shell(
    vm,
    'ls -d ~/noelle 2>/dev/null | head -1 || find ~ -maxdepth 3 -name pnpm-workspace.yaml -printf "%h\\n" 2>/dev/null | head -1',
  );
  const repo = find.stdout.trim().split("\n")[0]?.trim();
  if (!repo) return "noelle up";
  return `cd ${repo} && node apps/cli/dist/index.js up`;
}
