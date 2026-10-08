import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { SelfHostConfig } from "../config.js";
import { operatorJwtNeedsRemint, mintOperatorJwt } from "./identity.js";
import { readEnvFile, upsertEnvKey } from "./env-writer.js";
import { pm2RestartMany } from "./process-manager.js";
import { SERVICES } from "./service-manifest.js";
import { writePrivateFile } from "./private-file.js";

interface OperatorSessionArgs {
  envFile: string;
  config: SelfHostConfig;
  fallbackSecret?: string;
}

/** Keep the token signed by the configured local secret for this operator. */
export async function ensureOperatorJwtFresh(args: OperatorSessionArgs): Promise<boolean> {
  const env = readEnvFile(args.envFile);
  if (env.NOELLE_AUTH_MODE !== "local") return false;
  const secret = env.NOELLE_SUPABASE_JWT_SECRET || args.fallbackSecret;
  if (!secret) throw new Error("Local operator signing secret is missing");
  if (!env.NOELLE_SUPABASE_JWT_SECRET) upsertEnvKey(args.envFile, "NOELLE_SUPABASE_JWT_SECRET", secret);
  for (const [key, value] of Object.entries({ NOELLE_LOCAL_OPERATOR_SUB: args.config.operator.sub,
    NOELLE_LOCAL_OPERATOR_EMAIL: args.config.operator.email, NOELLE_LOCAL_OPERATOR_NAME: args.config.operator.name })) {
    if (env[key] !== value) upsertEnvKey(args.envFile, key, value);
  }
  if (!await operatorJwtNeedsRemint({ secret, ...args.config.operator,
    jwt: env.NOELLE_LOCAL_OPERATOR_JWT, withinSeconds: 7 * 24 * 3600 })) return false;
  upsertEnvKey(args.envFile, "NOELLE_LOCAL_OPERATOR_JWT", await mintOperatorJwt({ secret, ...args.config.operator }));
  return true;
}

/** A digest records successful delivery without storing the token or secret. */
function fingerprint(args: OperatorSessionArgs): string | null {
  const env = readEnvFile(args.envFile);
  if (env.NOELLE_AUTH_MODE !== "local") return null;
  return createHash("sha256").update(JSON.stringify([
    env.NOELLE_SUPABASE_JWT_SECRET, env.NOELLE_LOCAL_OPERATOR_JWT,
    env.NOELLE_LOCAL_OPERATOR_SUB, env.NOELLE_LOCAL_OPERATOR_EMAIL, env.NOELLE_LOCAL_OPERATOR_NAME,
  ])).digest("hex");
}

export async function reloadOperatorSession(args: OperatorSessionArgs & {
  repoRoot: string;
  ecosystem: string;
  force?: boolean;
}): Promise<boolean> {
  await ensureOperatorJwtFresh(args);
  const next = fingerprint(args);
  if (!next) return false;
  const receipt = resolve(dirname(args.envFile), ".operator-session-applied");
  const applied = existsSync(receipt) ? readFileSync(receipt, "utf8").trim() : null;
  if (!args.force && applied === next) return false;
  const result = await pm2RestartMany(args.repoRoot, [SERVICES.api, SERVICES.app], args.ecosystem);
  if (!result || result.code !== 0) throw new Error("Operator session restart failed");
  writePrivateFile(receipt, next + "\n");
  return true;
}
