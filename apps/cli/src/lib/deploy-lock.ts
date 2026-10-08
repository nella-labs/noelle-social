import { resolve } from "node:path";
import { noelleHome } from "../config.js";
import { type LockInfo } from "./deploy-lock-info.js";
import { removeOwnedLock, rewriteOwnedLock, takeDeployLock, type OwnedLock } from "./deploy-lock-storage.js";
export { parseLock, pidAlive, type LockInfo } from "./deploy-lock-info.js";

let owned: { path: string; lock: OwnedLock } | null = null;

export function lockPath(): string { return resolve(noelleHome(), "deploy.lock"); }

/** Atomic claim and dead-holder recovery serialize every host deploy. */
export function acquireLock(info: Omit<LockInfo, "startedAt" | "nonce">, now = Date.now()) {
  const path = lockPath();
  const result = takeDeployLock(path, info, now);
  if (result.ok) owned = { path, lock: result.lock };
  return result;
}

export function updateStage(stage: string): void {
  if (owned) owned.lock = rewriteOwnedLock(owned.path, owned.lock, stage);
}

export function releaseLock(ourPid: number): void {
  if (!owned || owned.lock.pid !== ourPid) return;
  removeOwnedLock(owned.path, owned.lock);
  owned = null;
}
