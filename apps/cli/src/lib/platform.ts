import { spawn } from "node:child_process";
import { constants } from "node:os";

/** Detected host OS family. */
export type Platform = "darwin" | "linux" | "win32" | "unknown";

export function platform(): Platform {
  const p = process.platform;
  if (p === "darwin" || p === "linux" || p === "win32") return p;
  return "unknown";
}

export interface RunResult {
  code: number;
  signal?: NodeJS.Signals;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Stream child output to this process's stdio instead of capturing. */
  inherit?: boolean;
  /** Treat a non-zero exit as success (don't throw); default false. */
  allowFailure?: boolean;
  /** Kill the child (SIGKILL) after this many ms; the run fails with code 124. */
  timeoutMs?: number;
}

/**
 * Run a command, returning {code, stdout, stderr}. Promise rejects on a
 * non-zero exit unless `allowFailure` is set. Never uses a shell — args are
 * passed as an array, so there's no quoting/injection surface.
 */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: opts.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : null;
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      if (opts.allowFailure) res({ code: 127, stdout, stderr: String(err) });
      else rej(err);
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      // A killed-on-timeout child closes with code null; report 124 so the
      // caller sees a failure, never a fake success.
      const exit = timedOut ? 124 : (code ?? (signal ? 128 + constants.signals[signal] : 1));
      const result: RunResult = {
        code: exit,
        ...(signal ? { signal } : {}),
        stdout,
        stderr: timedOut ? stderr || `timed out after ${opts.timeoutMs}ms` : stderr,
      };
      if (exit === 0 || opts.allowFailure) res(result);
      // Provisioning arguments and command output can contain credentials.
      else rej(new Error(`${cmd} exited ${exit}`));
    });
  });
}

/** Is an executable resolvable on PATH? */
export async function hasCommand(cmd: string): Promise<boolean> {
  const probe = platform() === "win32" ? "where" : "which";
  const r = await run(probe, [cmd], { allowFailure: true });
  return r.code === 0;
}

/** A docker-CLI-compatible container runtime. */
export type ContainerRuntime = "docker" | "nerdctl";

/**
 * Detect a usable container runtime: Docker (Docker Desktop / engine) or
 * nerdctl (containerd — the default in Lima/Rancher Desktop). Both share the
 * `run/start/stop/rm/inspect -p -v` surface the CLI uses. Returns null when
 * neither has a reachable daemon.
 */
export async function detectContainerRuntime(): Promise<ContainerRuntime | null> {
  for (const rt of ["docker", "nerdctl"] as const) {
    if (!(await hasCommand(rt))) continue;
    const r = await run(rt, ["info"], { allowFailure: true });
    if (r.code === 0) return rt;
  }
  return null;
}

/** Is any container runtime (docker or nerdctl) available? */
export async function hasContainerRuntime(): Promise<boolean> {
  return (await detectContainerRuntime()) !== null;
}

/** Is a TCP port already bound on localhost? Best-effort, never throws. */
export async function portInUse(port: number): Promise<boolean> {
  const net = await import("node:net");
  return new Promise((resolveBool) => {
    const srv = net.createServer();
    srv.once("error", () => resolveBool(true));
    srv.once("listening", () => srv.close(() => resolveBool(false)));
    srv.listen(port, "127.0.0.1");
  });
}
