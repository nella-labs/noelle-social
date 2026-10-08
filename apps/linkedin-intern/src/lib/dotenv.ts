// Operator env-file loader for the ON-DEMAND one-shots (e.g. `followup`).
//
// The pm2 ecosystem is what injects ~/.noelle/.env into every scheduled worker;
// a one-shot invoked directly (via run.sh, or `noelle lyra followup`) is NOT
// launched by pm2, so nothing has populated process.env. This loads that file
// itself, with the SAME quoting contract as the generator + the pm2 reader:
//   - writer: apps/cli/src/lib/env-writer.ts  serializeEnv()/quote()
//   - readers: apps/cli/src/lib/env-writer.ts readEnvFile() and
//              apps/cli/src/lib/process-manager.ts parseEnv()
// Keep this parser byte-compatible with readEnvFile(): a value wrapped in double
// quotes is unwrapped and unescaped (\" -> ", \\ -> \); everything else is bare.
// (The earlier bash loader in run.sh did NOT unquote, so a DB password with a
// space/# would connect fine under pm2 but break the one-shot — this fixes that.)
//
// Doing it in the worker (not run.sh) means one tested code path for every
// invocation, and no fragile shell escaping.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Resolve the operator env file, honouring NOELLE_HOME like the CLI does. */
export function operatorEnvFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.NOELLE_HOME && env.NOELLE_HOME.trim().length > 0 ? env.NOELLE_HOME : join(homedir(), ".noelle");
  return join(home, ".env");
}

/**
 * Parse a generated ~/.noelle/.env into a record. Mirrors readEnvFile() in
 * apps/cli/src/lib/env-writer.ts EXACTLY (line contract `^([A-Z0-9_]+)=(.*)$`;
 * strip surrounding double-quotes then unescape \" and \\). Never throws — a
 * missing/unreadable file yields an empty record.
 */
export function parseOperatorEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m || m[1] === undefined) continue;
    let v = m[2] ?? "";
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
      v = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    out[m[1]] = v;
  }
  return out;
}

/**
 * Load ~/.noelle/.env into process.env for a one-shot, WITHOUT overriding any
 * variable already set (so an explicit shell export or CLI-injected env wins).
 * Returns the number of keys applied. Call this before the first loadEnv().
 */
export function loadOperatorEnvFile(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = parseOperatorEnvFile(operatorEnvFilePath(env));
  let applied = 0;
  for (const [k, v] of Object.entries(parsed)) {
    if (env[k] === undefined) {
      env[k] = v;
      applied++;
    }
  }
  return applied;
}
