import { homedir } from "node:os";
import { resolve } from "node:path";

export interface DaemonConfig {
  vaultDir: string;
  bucket: string;
  prefix: string;
  debounceMs: number;
  deleteGuardPct: number;
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

function num(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (Number.isNaN(n)) throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const vaultDir = env.VAULT_DIR?.trim();
  const prefix = env.NOELLE_VAULT_PREFIX?.trim();
  if (!vaultDir) throw new Error("VAULT_DIR is required");
  if (!prefix || !prefix.replace(/\//g, "")) throw new Error("NOELLE_VAULT_PREFIX is required");
  return {
    vaultDir: expandHome(vaultDir),
    bucket: env.NOELLE_VAULT_BUCKET ?? "noelle-vaults",
    prefix: prefix.endsWith("/") ? prefix : `${prefix}/`,
    debounceMs: num("VAULT_SYNC_DEBOUNCE_MS", env.VAULT_SYNC_DEBOUNCE_MS, 2000),
    deleteGuardPct: num("VAULT_SYNC_DELETE_GUARD_PCT", env.VAULT_SYNC_DELETE_GUARD_PCT, 25),
  };
}
