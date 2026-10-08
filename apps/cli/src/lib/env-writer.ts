import { existsSync, readFileSync } from "node:fs";
import { writePrivateFile } from "./private-file.js";
import type { SelfHostConfig } from "../config.js";

/**
 * Compose + atomically write the shared `.env` consumed by app / api-vm /
 * workers. The composition is a pure function (`composeEnv`) so it can be unit
 * tested; `writeEnvFile` is the only side effect.
 *
 * Modeled on scripts/pull-secrets.sh: atomic temp-then-rename + 0600 perms.
 */

export interface EnvInputs {
  config: SelfHostConfig;
  /** noelle_app role connection string (sslmode=disable for local PG). */
  databaseUrl: string;
  /** HS256 secret used to mint + verify the operator JWT. */
  jwtSecret: string;
  /** HMAC secret for the verified-email gate cookie. */
  gateCookieSecret: string;
  /** HMAC secret for VM↔Hono / worker↔api-vm (>=32 chars). */
  hmacSecret: string;
  /** Authenticates the spend-rollup → /api/cron/sync-spend call. */
  cronSecret: string;
  /** The minted operator JWT (Bearer the dashboard forwards to api-vm). */
  operatorJwt: string;
  /** Build version surfaced on the System page. */
  version: string;
  /** Directory api-vm reads worker heartbeats from. */
  heartbeatDir: string;
  /**
   * Provider credentials the operator supplied, already keyed by their final
   * env-var names (plain ANTHROPIC_API_KEY/OPENAI_API_KEY/AWS_*, or the
   * NOELLE_SECRET_* names the env-backed secrets source reads).
   */
  providerEnv: Record<string, string>;
  /** Public tunnel hostname, when a Cloudflare tunnel is configured. */
  tunnelHostname?: string | null;
}

/**
 * Build the env map. CRITICAL: never emit the WIF quintuple
 * (NOELLE_GCP_PROJECT_NUMBER/_POOL_ID/_PROVIDER_ID/_SA_EMAIL/_CLOUDSQL_INSTANCE)
 * — their presence flips apps/app/src/lib/db.ts to the IAM connector path,
 * which can't authenticate on a self-host box.
 */
export function composeEnv(inputs: EnvInputs): Record<string, string> {
  const { config } = inputs;
  const env: Record<string, string> = {
    NODE_ENV: "production",

    // --- Local mode switches ---
    NOELLE_AUTH_MODE: "local",
    NOELLE_SECRETS_SOURCE: "env",

    // --- Data plane (no remote DB) ---
    NOELLE_DATABASE_URL: inputs.databaseUrl,

    // --- Service wiring ---
    NOELLE_API_BASE_URL: `http://127.0.0.1:${config.ports.apiVm}`,
    CP_BASE_URL: `http://127.0.0.1:${config.ports.apiVm}`,
    NOELLE_APP_BASE_URL: `http://127.0.0.1:${config.ports.app}`,

    // --- Auth shim ---
    NOELLE_SUPABASE_JWT_SECRET: inputs.jwtSecret,
    NOELLE_GATE_COOKIE_SECRET: inputs.gateCookieSecret,
    NOELLE_HMAC_SECRET: inputs.hmacSecret,
    CRON_SECRET: inputs.cronSecret,
    NOELLE_LOCAL_OPERATOR_SUB: config.operator.sub,
    NOELLE_LOCAL_OPERATOR_EMAIL: config.operator.email,
    NOELLE_LOCAL_OPERATOR_NAME: config.operator.name,
    NOELLE_LOCAL_OPERATOR_JWT: inputs.operatorJwt,
    NOELLE_LOCAL_ORG_SLUG: config.orgSlug,

    // Belt-and-suspenders so any stray Supabase client construction under
    // local auth never throws on missing public env.
    NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "local-noop-anon-key",

    // --- Workers (off in v1 unless explicitly enabled) ---
    NOELLE_WORKERS_ENABLED: config.workersEnabled ? "1" : "0",
    NOELLE_HEARTBEAT_DIR: inputs.heartbeatDir,

    // --- Observability ---
    NOELLE_BUILD_VERSION: inputs.version,
  };

  // Local voice-anchor vault (self-host): point the drafter at on-disk markdown.
  if (config.vaultDir) {
    env.NOELLE_NELLA_BACKEND = "local";
    env.NOELLE_VAULT_DIR = config.vaultDir;
    // Scope retrieval to the curated voice base so the drafter grounds on the
    // operator's voice, not unrelated vault docs. Unset → whole-vault index.
    if (config.voiceDirs) env.NOELLE_VOICE_DIRS = config.voiceDirs;
  }

  // Provider-presence flags the System page reads (codex/vertex have no key).
  // Selecting Codex is also an execution choice: wire the CLI backend and make
  // it the first call instead of leaving the old Claude route in front of it.
  if (config.llmProvider === "codex") {
    env.NOELLE_CODEX_ENABLED = "1";
    env.NOELLE_CODEX_CLI = "1";
    env.NOELLE_CODEX_PRIMARY = "1";
  }
  if (config.llmProvider === "vertex") env.NOELLE_VERTEX_ENABLED = "1";

  if (inputs.tunnelHostname) env.NOELLE_TUNNEL_HOSTNAME = inputs.tunnelHostname;

  // Operator-supplied provider credentials (already correctly keyed).
  Object.assign(env, inputs.providerEnv);

  // Classifier backend: a direct Gemini key is the reliable self-host path and
  // must win over stale AWS credentials. Without that key, use Bedrock when AWS
  // creds are present; otherwise leave the managed default (Vertex + ADC).
  const hasGeminiKey = Boolean(env.NOELLE_GEMINI_API_KEY);
  const hasBedrock =
    Boolean(env.AWS_ACCESS_KEY_ID) ||
    Boolean(env.NOELLE_SECRET_NOELLE_WORKER_BEDROCK_AWS_ACCESS_KEY_ID);
  if (hasGeminiKey) env.NOELLE_CLASSIFIER_BACKEND = "vertex";
  else if (hasBedrock) env.NOELLE_CLASSIFIER_BACKEND = "bedrock";

  return env;
}

/**
 * Documentation header prepended to the generated `.env`. Both the ecosystem
 * parser (process-manager.ts) and readEnvFile skip any line that isn't
 * `KEY=value`, so `#` comments are inert config-wise and purely for the operator
 * reading the file. Keep it to the knobs an operator actually tunes; the full
 * list is documented in docs/self-host.md.
 */
const ENV_HEADER = `# Noelle self-host environment — generated by \`noelle\`. Do NOT hand-edit:
# change ~/.noelle/config.json and re-run \`noelle up\` (hand edits are lost on
# regen). Secrets live ONLY in this file (0600). Full reference: docs/self-host.md.
#
# Operator knobs (drafter voice + quality):
#   NOELLE_VAULT_DIR              local markdown vault the drafter grounds on
#   NOELLE_VOICE_DIRS            comma-sep vault subdirs to scope voice retrieval to
#                                (e.g. noelle-voice,content/voice-anchors,02-brand);
#                                unset = index the whole vault
#   DRAFTER_RELEVANCE_THRESHOLD  min normalized anchor score before drafting (def 6)
#   X_Q_THRESHOLD                min classifier quality 0-100 before Vega drafts (def 50)
#   LINKEDIN_Q_THRESHOLD         min classifier quality 0-100 for a LinkedIn reply (def 75)
#   NOELLE_DRAFTER_OPUS_MODEL    strongest model for high-value / watchlist drafts
#   NOELLE_CLASSIFIER_BACKEND    vertex | bedrock (Gemini key selects vertex)
`;

/** Serialize an env map to dotenv format (values quoted to be safe). */
export function serializeEnv(env: Record<string, string>): string {
  return (
    ENV_HEADER +
    Object.entries(env)
      .map(([k, v]) => { assertEnvKey(k); return `${k}=${quote(v)}`; })
      .join("\n") +
    "\n"
  );
}

function quote(v: string): string {
  // Leave bare unless the value has chars a dotenv reader would mis-parse:
  // whitespace, comment marker, quotes, backtick, backslash, or newline.
  // URLs/keys (with ?, =, /, +, @, :) stay readable and unquoted.
  if (v.length === 0) return '""';
  if (/[\s#"'`\\]/.test(v)) {
    return JSON.stringify(v);
  }
  return v;
}

function envAssignments(): RegExp {
  return /^([A-Z0-9_]+)=("(?:\\[\s\S]|[^"\\])*"|'[^']*'|[^\r\n]*)/gm;
}

/** One parser serves CLI reads and the generated process ecosystem. */
export function parseEnvText(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(envAssignments())) {
    if (m[1] === undefined) continue;
    let v = m[2] ?? "";
    if (v.startsWith('"') && v.endsWith('"')) {
      try { v = JSON.parse(v.replace(/\r/g, "\\r").replace(/\n/g, "\\n")); }
      catch { v = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\"); }
    } else if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** Embed the same compiled pure parser in the standalone CJS ecosystem. */
export function envParsingSource(): string {
  return `${envAssignments.toString()}\n${parseEnvText.toString()}`;
}

export function readEnvFile(envFilePath: string): Record<string, string> {
  return existsSync(envFilePath) ? parseEnvText(readFileSync(envFilePath, "utf8")) : {};
}

function assertEnvKey(key: string): void {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error("Invalid environment key");
}

/** Atomically write the env file with 0600 perms. */
export function writeEnvFile(envFilePath: string, env: Record<string, string>): void {
  writeEnvBody(envFilePath, serializeEnv(env));
}

/**
 * Surgically upsert ONE key in an existing .env, preserving every other line
 * (comments, operator-tuned knobs, ordering). Used by the operator-JWT
 * re-mint, where a full `writeEnvFile` recompose would clobber hand edits.
 */
export function upsertEnvKey(envFilePath: string, key: string, value: string): void {
  assertEnvKey(key);
  const line = `${key}=${quote(value)}`;
  if (!existsSync(envFilePath)) {
    writeEnvBody(envFilePath, line + "\n");
    return;
  }
  let replaced = false;
  let next = readFileSync(envFilePath, "utf8").replace(envAssignments(), (assignment, name: string) => {
    if (name !== key) return assignment;
    const replacement = replaced ? "" : line;
    replaced = true;
    return replacement;
  });
  if (!replaced) {
    if (next && !next.endsWith("\n")) next += "\n";
    next += line + "\n";
  }
  writeEnvBody(envFilePath, next);
}

function writeEnvBody(envFilePath: string, body: string): void {
  writePrivateFile(envFilePath, body);
}
