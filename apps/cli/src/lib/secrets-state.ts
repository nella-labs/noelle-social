import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { Paths } from "../config.js";
import { writePrivateFile } from "./private-file.js";
import { generateSecret } from "./identity.js";

/**
 * Durable runtime secrets for the self-host box, persisted to
 * NOELLE_HOME/secrets.json (0600). Persisting them makes `noelle init`
 * idempotent: the operator JWT secret (so the minted token stays valid) and
 * the Postgres passwords (so an existing Docker container keeps authenticating)
 * survive re-runs. Missing fields are filled in and re-saved.
 */
export interface SecretsState {
  jwtSecret: string;
  gateCookieSecret: string;
  hmacSecret: string;
  rootPassword: string;
  appPassword: string;
  /** Authenticates the local spend-rollup → /api/cron/sync-spend call. */
  cronSecret: string;
}

function secretsFile(paths: Paths): string {
  return resolve(paths.home, "secrets.json");
}

export function loadOrCreateSecrets(paths: Paths): SecretsState {
  const file = secretsFile(paths);
  let existing: Partial<SecretsState> = {};
  if (existsSync(file)) {
    existing = parseSecrets(readFileSync(file, "utf8"));
  }
  const state: SecretsState = {
    jwtSecret: existing.jwtSecret || generateSecret(48),
    gateCookieSecret: existing.gateCookieSecret || generateSecret(32),
    hmacSecret: existing.hmacSecret || generateSecret(32),
    rootPassword: existing.rootPassword || pgPassword(),
    appPassword: existing.appPassword || pgPassword(),
    cronSecret: existing.cronSecret || generateSecret(24),
  };
  saveSecrets(file, state);
  return state;
}

/** Alphanumeric password (no URL-special chars) safe in a connection string. */
function pgPassword(): string {
  return randomBytes(24).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 28);
}

function saveSecrets(file: string, state: SecretsState): void {
  writePrivateFile(file, JSON.stringify(state, null, 2));
}

/** A corrupt file must never rotate credentials for an existing deployment. */
function parseSecrets(body: string): Partial<SecretsState> {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { throw new Error("Invalid local secrets state: unreadable JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid local secrets state: expected an object");
  }
  const fields = ["jwtSecret", "gateCookieSecret", "hmacSecret", "rootPassword", "appPassword", "cronSecret"] as const;
  for (const field of fields) {
    if (!Object.hasOwn(parsed, field)) continue;
    const value = (parsed as Record<string, unknown>)[field];
    if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid local secrets state: ${field}`);
  }
  return parsed as Partial<SecretsState>;
}
