export interface LockInfo {
  pid: number;
  host: string;
  sha: string;
  stage: string;
  startedAt: number;
  nonce?: string;
}

export function parseLock(raw: string): LockInfo | null {
  try {
    const value = JSON.parse(raw);
    if (Number.isSafeInteger(value?.pid) && value.pid > 0 &&
        typeof value.host === "string" && value.host.length > 0 &&
        typeof value.sha === "string" && typeof value.stage === "string" &&
        Number.isFinite(value.startedAt) && value.startedAt >= 0 &&
        (value.nonce === undefined || typeof value.nonce === "string" && value.nonce.length > 0))
      return value as LockInfo;
    return null;
  } catch { return null; }
}

/** Permission denial still proves that a PID may be alive. */
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
