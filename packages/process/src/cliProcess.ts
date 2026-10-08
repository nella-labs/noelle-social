import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { killProcessGroup } from "./processGroup.js";

export const MAX_CLI_OUTPUT_BYTES = 16 * 1024 * 1024;
export const MAX_CLI_TIMEOUT_MS = 1_800_000;
type Failure = "invalid_request" | "spawn_failed" | "timed_out" | "output_too_large" | "input_failed" | "cleanup_failed";
export class CliProcessError extends Error {
  constructor(readonly code: Failure, readonly stderr = "") {
    super(`CLI process ${code}`); this.name = "CliProcessError";
  }
}
export function cliTimeoutMs(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_CLI_TIMEOUT_MS) throw new CliProcessError("invalid_request");
  return value;
}

/** Read the completed final-answer file through one bounded regular-file handle. */
export function readCliAnswer(path: string): string {
  const handle = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(handle);
    if (!stat.isFile() || stat.size > MAX_CLI_OUTPUT_BYTES) throw new CliProcessError("output_too_large");
    const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_CLI_OUTPUT_BYTES + 1));
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(handle, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > stat.size) throw new CliProcessError("output_too_large");
    return buffer.subarray(0, length).toString("utf8").trim();
  } finally { closeSync(handle); }
}

/** One deadline and byte bound; rejection waits for the owned child to close. */
export function runCliProcess(options: {
  command: string; argv: string[]; prompt: string; timeoutMs: number;
  env: NodeJS.ProcessEnv; cwd: string; spawnImpl?: typeof spawn;
}): Promise<{ stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    let timeoutMs: number;
    try { timeoutMs = cliTimeoutMs(options.timeoutMs); }
    catch (error) { reject(error); return; }
    let child: ChildProcess;
    const detached = process.platform !== "win32";
    const spawnOptions: SpawnOptions = { cwd: options.cwd, env: options.env, detached, stdio: ["pipe", "pipe", "pipe"] };
    try { child = (options.spawnImpl ?? spawn)(options.command, options.argv, spawnOptions); }
    catch { reject(new CliProcessError("spawn_failed")); return; }
    let failure: Failure | undefined;
    let inputFailed = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const stop = () => {
      try {
        if (detached && child.pid) killProcessGroup(child.pid);
        else child.kill("SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          failure = "cleanup_failed";
          try { child.kill("SIGKILL"); } catch { /* The close event remains the completion barrier. */ }
        }
      }
    };
    const fail = (code: Failure) => { if (failure) return; failure = code; stop(); };
    const timer = setTimeout(() => fail("timed_out"), timeoutMs);
    timer.unref();
    const collect = (destination: Buffer[], value: Buffer | string, isStderr: boolean) => {
      if (failure) return;
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (isStderr) stderrBytes += bytes.byteLength; else stdoutBytes += bytes.byteLength;
      if (stdoutBytes + stderrBytes > MAX_CLI_OUTPUT_BYTES) { fail("output_too_large"); return; }
      destination.push(bytes);
    };
    child.stdout?.on("data", value => collect(stdout, value, false));
    child.stderr?.on("data", value => collect(stderr, value, true));
    child.on("error", () => fail("spawn_failed"));
    // A CLI can reject authentication or arguments without consuming stdin.
    // Keep that structured nonzero result; a code-zero truncated input still fails.
    child.stdin?.on("error", () => { inputFailed = true; });
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      // A successful parent can leave helper processes behind in its group.
      if (detached && child.pid) stop();
      if (inputFailed && code === 0 && !failure) failure = "input_failed";
      const errorText = Buffer.concat(stderr).toString("utf8");
      if (failure) reject(new CliProcessError(failure, errorText));
      else resolve({ code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: errorText });
    });
    try { child.stdin?.end(options.prompt); }
    catch { fail("input_failed"); }
  });
}
