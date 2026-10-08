import { execFile } from "node:child_process";
import type { Env } from "./env.js";

// Read-mostly pm2 helpers. The doctor only ever reads (`jlist`) and restarts;
// it never starts/deletes apps. pm2 drives a SHARED daemon, so the binary is the
// CLI-bundled one in the main checkout (env.NOELLE_PM2_BIN), not a worktree copy,
// and bare `pm2` is not on PATH. Every call has a timeout and can't throw.

export interface Pm2App {
  name: string;
  status: string; // "online" | "stopped" | "errored" | "launching" | "stopping" | ...
  restart_time: number;
  pm_uptime: number;
}

interface ExecResult {
  code: number; // -1 when the process never ran (ENOENT etc.)
  stdout: string;
  stderr: string;
}

// Resolves (never rejects). code=-1 signals spawn failure.
function execFileSafe(bin: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    let settled = false;
    const done = (r: ExecResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    try {
      const child = execFile(
        bin,
        args,
        { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const code =
            err && typeof (err as { code?: unknown }).code === "number"
              ? ((err as { code: number }).code as number)
              : err
                ? 1
                : 0;
          done({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
        },
      );
      child.on("error", (err) => done({ code: -1, stdout: "", stderr: String(err) }));
    } catch (err) {
      done({ code: -1, stdout: "", stderr: String(err) });
    }
  });
}

export async function pm2List(env: Env): Promise<Pm2App[]> {
  const r = await execFileSafe(env.NOELLE_PM2_BIN, ["jlist"], 15_000);
  if (r.code !== 0 || !r.stdout.trim()) return [];
  try {
    const list = JSON.parse(r.stdout) as Array<{
      name?: string;
      pm2_env?: { status?: string; restart_time?: number; pm_uptime?: number };
    }>;
    return list.map((p) => ({
      name: p.name ?? "?",
      status: p.pm2_env?.status ?? "unknown",
      restart_time: p.pm2_env?.restart_time ?? 0,
      pm_uptime: p.pm2_env?.pm_uptime ?? 0,
    }));
  } catch {
    return [];
  }
}

export interface RestartResult {
  ok: boolean;
  detail?: string;
}

export async function restartApp(env: Env, name: string): Promise<RestartResult> {
  const r = await execFileSafe(env.NOELLE_PM2_BIN, ["restart", name, "--update-env"], 30_000);
  if (r.code === 0) return { ok: true };
  return { ok: false, detail: (r.stderr || `exit ${r.code}`).slice(0, 200) };
}
