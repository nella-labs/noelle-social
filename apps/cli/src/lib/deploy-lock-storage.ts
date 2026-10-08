import { linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { parseLock, pidAlive, type LockInfo } from "./deploy-lock-info.js";

export type OwnedLock = LockInfo & { nonce: string };
export type LockAttempt = { ok: true; lock: OwnedLock } | { ok: false; holder: LockInfo | null };

function read(path: string): string | null {
  try { return readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function remove(path: string): void {
  try { unlinkSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/** Link a complete immutable payload atomically; readers never see partial JSON. */
function write(path: string, lock: OwnedLock, replace = false): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(lock), { mode: 0o600, flag: "wx" });
  try {
    if (replace) renameSync(temporary, path);
    else linkSync(temporary, path);
  } finally { remove(temporary); }
}

const fingerprint = (raw: string) => createHash("sha256").update(raw).digest("hex");

/** Dead recovery claims form an immutable chain; one live successor owns recovery. */
function claimRecovery(path: string, raw: string, owner: OwnedLock): (() => void) | null {
  let key = fingerprint(raw);
  const observed: { path: string; raw: string }[] = [];
  for (let depth = 0; depth < 32; depth++) {
    const claimPath = `${path}.reclaim-${key}`;
    const claim = { ...owner, nonce: randomUUID(), stage: "lock-recovery" };
    try {
      write(claimPath, claim);
      observed.push({ path: claimPath, raw: JSON.stringify(claim) });
      return () => {
        for (const prior of observed.reverse()) {
          if (read(prior.path) === prior.raw) remove(prior.path);
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const previous = read(claimPath);
      if (previous === null) continue;
      const holder = parseLock(previous);
      if (!holder || holder.host !== owner.host || pidAlive(holder.pid)) return null;
      observed.push({ path: claimPath, raw: previous });
      key = fingerprint(previous);
    }
  }
  return null;
}

export function takeDeployLock(path: string, info: Omit<LockInfo, "startedAt" | "nonce">, now: number): LockAttempt {
  const owner: OwnedLock = { ...info, startedAt: now, nonce: randomUUID() };
  if (owner.pid !== process.pid || !parseLock(JSON.stringify(owner))) throw new Error("Invalid deploy lock owner");
  try { write(path, owner); return { ok: true, lock: owner }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const raw = read(path);
  const holder = raw === null ? null : parseLock(raw);
  if (!raw || !holder || holder.host !== owner.host || pidAlive(holder.pid)) return { ok: false, holder };
  const finishRecovery = claimRecovery(path, raw, owner);
  if (!finishRecovery) return { ok: false, holder };
  try {
    if (read(path) === raw && !pidAlive(holder.pid)) remove(path);
    try { write(path, owner); return { ok: true, lock: owner }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const current = read(path);
    return { ok: false, holder: current === null ? null : parseLock(current) };
  } finally { finishRecovery(); }
}

export function rewriteOwnedLock(path: string, owner: OwnedLock, stage: string): OwnedLock {
  const current = read(path);
  if (current !== null && parseLock(current)?.nonce === owner.nonce) {
    const updated = { ...owner, stage };
    write(path, updated, true);
    return updated;
  }
  return owner;
}

export function removeOwnedLock(path: string, owner: OwnedLock): void {
  const current = read(path);
  if (current !== null && parseLock(current)?.nonce === owner.nonce) remove(path);
}
