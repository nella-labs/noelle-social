import { execFileSync } from "node:child_process";

function exitedDarwinGroup(pid: number): boolean {
  try {
    const states = execFileSync("/bin/ps", ["-g", String(pid), "-o", "stat="], {
      encoding: "utf8", timeout: 1000, maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim().split(/\s+/).filter(Boolean);
    return states.length > 0 && states.every(state => state.startsWith("Z"));
  } catch (error) {
    const result = error as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return result.status === 1 && result.stdout?.length === 0 && result.stderr?.length === 0;
  }
}

/** Stop an owned POSIX group; exited Darwin zombies cannot receive another signal. */
export function killProcessGroup(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid < 2 || pid > 2_147_483_647) {
    throw new RangeError("Process group must be a positive child PID");
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return;
    // Darwin excludes zombies from killpg; an existing zombie-only group yields EPERM.
    if (process.platform === "darwin" && code === "EPERM" && exitedDarwinGroup(pid)) return;
    throw error;
  }
}
