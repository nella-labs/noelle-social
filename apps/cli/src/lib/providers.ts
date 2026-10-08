import { secretIdToEnvKey } from "@noelle/secrets";
import type { LlmProvider } from "../config.js";

/**
 * Collect the env vars for the operator's chosen LLM provider from the current
 * environment. Each found key is emitted under BOTH its plain name (read by the
 * backend SDKs directly) and its NOELLE_SECRET_* name (read by the env-backed
 * secrets source the workers use) — one value, both consumers.
 */
export interface ProviderEnvResult {
  env: Record<string, string>;
  missing: string[];
}

export function collectProviderEnv(
  provider: LlmProvider,
  src: NodeJS.ProcessEnv,
): ProviderEnvResult {
  const env: Record<string, string> = {};
  const missing: string[] = [];

  const need = (envName: string, secretId: string) => {
    const v = src[envName];
    if (v && v.length > 0) {
      env[envName] = v;
      env[secretIdToEnvKey(secretId)] = v;
    } else {
      missing.push(envName);
    }
  };

  switch (provider) {
    case "anthropic":
      need("ANTHROPIC_API_KEY", "noelle-worker-anthropic-api-key");
      break;
    case "openai":
      need("OPENAI_API_KEY", "noelle-worker-openai-api-key");
      break;
    case "bedrock":
      need("AWS_ACCESS_KEY_ID", "noelle-worker-bedrock-aws-access-key-id");
      need("AWS_SECRET_ACCESS_KEY", "noelle-worker-bedrock-aws-secret-access-key");
      break;
    case "vertex":
      if (src.GOOGLE_APPLICATION_CREDENTIALS) {
        env.GOOGLE_APPLICATION_CREDENTIALS = src.GOOGLE_APPLICATION_CREDENTIALS;
      } else {
        missing.push("GOOGLE_APPLICATION_CREDENTIALS");
      }
      break;
    case "codex":
      // Codex uses ~/.codex OAuth (run `codex login`); nothing to collect here.
      break;
  }

  return { env, missing };
}

/**
 * Collect ALL worker credentials present in the environment, for baking into
 * the generated .env. Unlike collectProviderEnv (single chosen provider), this
 * passes through every provider's creds that exist plus any pre-set
 * NOELLE_SECRET_* (e.g. X cookies, gemini) and the Vertex toggles — so an
 * operator can `export` whatever they have and `noelle init` wires it.
 */
export function collectWorkerCredsEnv(src: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  const passKeyVal = (envName: string, secretId?: string) => {
    const v = src[envName];
    if (v && v.length > 0) {
      out[envName] = v;
      if (secretId) out[secretIdToEnvKey(secretId)] = v;
    }
  };
  // Direct/SDK provider creds (also mirrored to NOELLE_SECRET_* for the env source).
  passKeyVal("ANTHROPIC_API_KEY", "noelle-worker-anthropic-api-key");
  passKeyVal("OPENAI_API_KEY", "noelle-worker-openai-api-key");
  passKeyVal("AI_GATEWAY_API_KEY");
  passKeyVal("TYPESAFE_API_KEY");
  passKeyVal("AWS_ACCESS_KEY_ID", "noelle-worker-bedrock-aws-access-key-id");
  passKeyVal("AWS_SECRET_ACCESS_KEY", "noelle-worker-bedrock-aws-secret-access-key");
  passKeyVal("AWS_REGION");
  passKeyVal("GOOGLE_APPLICATION_CREDENTIALS");
  passKeyVal("NOELLE_VERTEX_ENABLED");
  // Codex authenticates from ~/.codex, but these optional runtime settings
  // still need to survive the generated .env written by `noelle init`.
  passKeyVal("NOELLE_CODEX_CLI_MODEL");
  passKeyVal("NOELLE_CODEX_CLI_PATH");
  passKeyVal("NOELLE_CODEX_CLI_TIMEOUT_MS");
  // Direct Gemini API path used by self-host classifiers and captioning. Keep
  // it across `noelle init`; otherwise regeneration silently drops the key and
  // sends classification back to the stale Bedrock/Claude route.
  passKeyVal("NOELLE_GEMINI_API_KEY");
  // Pushover alert channel — api-vm reads these directly (apps/api-vm/src/env.ts).
  // Without them the alert toggles in the dashboard silently no-op.
  passKeyVal("PUSHOVER_USER_KEY");
  passKeyVal("PUSHOVER_APP_TOKEN");
  // Pass through any pre-set NOELLE_SECRET_* (X cookies, gemini-api-key, etc.).
  for (const [k, v] of Object.entries(src)) {
    if (k.startsWith("NOELLE_SECRET_") && typeof v === "string" && v.length > 0) {
      out[k] = v;
    }
  }
  return out;
}
