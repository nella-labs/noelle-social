import type { EngineKey, EngineRegistry } from "./callAgentModel.js";
import { createBedrockBackend } from "./bedrockBackend.js";
import { createAnthropicBackend } from "./anthropicBackend.js";
import { createOpenAiBackend } from "./openaiBackend.js";
import { createVertexBackend } from "./vertexBackend.js";
import {
  createClaudeCliBackend,
  type CreateClaudeCliBackendOptions,
} from "./claudeCliBackend.js";
import {
  createCodexCliBackend,
  type CreateCodexCliBackendOptions,
} from "./codexCliBackend.js";

/**
 * Assemble an EngineRegistry from whatever provider credentials are present.
 *
 * This replaces the per-worker, single-engine bootstrapping (the drafter used
 * to hardcode Bedrock). Each engine is wired best-effort: if its credentials
 * are configured it joins the registry, otherwise it is silently skipped (a
 * worker that then routes to it fails loudly with EngineNotImplementedError —
 * the signal to provision the key). Credentials come from a SecretsClient
 * (GCP Secret Manager on the managed box, or `process.env` via @noelle/secrets'
 * env source on a self-host box) with a plain-env fallback for the BYOK case.
 *
 * Engine ↔ credential:
 *   bedrock — noelle-worker-bedrock-aws-access-key-id + …-secret-access-key,
 *             or AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY
 *   claude  — noelle-worker-anthropic-api-key, or ANTHROPIC_API_KEY
 *   openai  — noelle-worker-openai-api-key, or OPENAI_API_KEY
 *   vertex  — gated on NOELLE_VERTEX_ENABLED=1 or GOOGLE_APPLICATION_CREDENTIALS
 *             (uses ADC); off by default so a no-GCP box doesn't wire a backend
 *             that can't authenticate.
 */

/** Minimal secrets surface — avoids a hard dep on @noelle/secrets. */
export type SecretGetter = { get(name: string): Promise<string> };

export type BuildEngineRegistryOptions = {
  secrets?: SecretGetter;
  /** Force an engine on/off regardless of credential detection. */
  enable?: Partial<Record<EngineKey, boolean>>;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
};

/** Read a secret by id, falling back to an env var; null if neither is set. */
async function resolveCred(
  secrets: SecretGetter | undefined,
  secretId: string,
  envVar: string,
): Promise<string | null> {
  if (secrets) {
    try {
      const v = await secrets.get(secretId);
      if (v) return v;
    } catch {
      // NOT_FOUND / unreadable → try env fallback below.
    }
  }
  const fromEnv = process.env[envVar];
  return fromEnv && fromEnv.length > 0 ? fromEnv : null;
}

export async function buildEngineRegistry(
  opts?: BuildEngineRegistryOptions,
): Promise<EngineRegistry> {
  const log = opts?.log ?? (() => {});
  const enable = opts?.enable ?? {};
  const registry: EngineRegistry = {};

  // ── Bedrock ────────────────────────────────────────────────────────────
  if (enable.bedrock !== false) {
    const accessKeyId = await resolveCred(
      opts?.secrets,
      "noelle-worker-bedrock-aws-access-key-id",
      "AWS_ACCESS_KEY_ID",
    );
    const secretAccessKey = await resolveCred(
      opts?.secrets,
      "noelle-worker-bedrock-aws-secret-access-key",
      "AWS_SECRET_ACCESS_KEY",
    );
    if ((accessKeyId && secretAccessKey) || enable.bedrock === true) {
      registry.bedrock = createBedrockBackend(
        accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : {},
      );
      log("bedrock backend wired");
    }
  }

  // ── Anthropic direct (engine "claude") ──────────────────────────────────
  if (enable.claude !== false) {
    const apiKey = await resolveCred(
      opts?.secrets,
      "noelle-worker-anthropic-api-key",
      "ANTHROPIC_API_KEY",
    );
    if (apiKey || enable.claude === true) {
      registry.claude = createAnthropicBackend(apiKey ? { apiKey } : {});
      log("anthropic (claude) backend wired");
    }
  }

  // ── OpenAI direct ───────────────────────────────────────────────────────
  if (enable.openai !== false) {
    const apiKey = await resolveCred(
      opts?.secrets,
      "noelle-worker-openai-api-key",
      "OPENAI_API_KEY",
    );
    if (apiKey || enable.openai === true) {
      registry.openai = createOpenAiBackend(apiKey ? { apiKey } : {});
      log("openai backend wired");
    }
  }

  // ── Local Claude CLI (engine "claude-cli") ──────────────────────────────
  // Opt-in per VM: NOELLE_CLAUDE_CLI=1 wires `claude -p` so callAgentModel can
  // rewrite Bedrock calls to the local Claude Max/Pro subscription. No
  // credential lookup — auth is the CLI's own OAuth login under the worker's
  // HOME. cliPath/timeout are optional env overrides.
  if (
    enable["claude-cli"] === true ||
    (enable["claude-cli"] !== false && process.env.NOELLE_CLAUDE_CLI === "1")
  ) {
    const cliOpts: CreateClaudeCliBackendOptions = {};
    if (process.env.NOELLE_CLAUDE_CLI_PATH) {
      cliOpts.cliPath = process.env.NOELLE_CLAUDE_CLI_PATH;
    }
    if (process.env.NOELLE_CLAUDE_CLI_TIMEOUT_MS) {
      cliOpts.timeoutMs = Number(process.env.NOELLE_CLAUDE_CLI_TIMEOUT_MS);
    }
    registry["claude-cli"] = createClaudeCliBackend(cliOpts);
    log("claude-cli backend wired");
  }

  // ── Local Codex CLI (engine "codex-cli") ────────────────────────────────
  // The OpenAI-side twin of the block above: `codex exec` against the
  // operator's ChatGPT subscription. Wired only on NOELLE_CODEX_CLI=1, and
  // wiring it is what enables the budget failover — when the Claude weekly
  // allowance is spent, callAgentModel continues here instead of stopping.
  // Auth is the CLI's own ChatGPT login under the worker's HOME.
  if (
    enable["codex-cli"] === true ||
    (enable["codex-cli"] !== false && process.env.NOELLE_CODEX_CLI === "1")
  ) {
    const codexOpts: CreateCodexCliBackendOptions = {};
    if (process.env.NOELLE_CODEX_CLI_PATH) {
      codexOpts.cliPath = process.env.NOELLE_CODEX_CLI_PATH;
    }
    if (process.env.NOELLE_CODEX_CLI_TIMEOUT_MS) {
      codexOpts.timeoutMs = Number(process.env.NOELLE_CODEX_CLI_TIMEOUT_MS);
    }
    registry["codex-cli"] = createCodexCliBackend(codexOpts);
    log("codex-cli backend wired");
  }

  // ── Vertex (ADC) ────────────────────────────────────────────────────────
  const vertexHinted =
    process.env.NOELLE_VERTEX_ENABLED === "1" ||
    Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  if (enable.vertex === true || (enable.vertex !== false && vertexHinted)) {
    registry.vertex = createVertexBackend();
    log("vertex backend wired");
  }

  return registry;
}
