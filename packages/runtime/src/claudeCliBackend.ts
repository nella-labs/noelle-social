import { spawn as nodeSpawn } from "node:child_process";
import { tmpdir } from "node:os";
import type { EngineBackend, TokenUsage } from "./callAgentModel.js";
import type { EngineHandle } from "./types.js";
import { reportedAnthropicUsage } from "./promptCache.js";
import { CliProcessError, cliTimeoutMs, runCliProcess } from "./cliProcess.js";

/**
 * Local Claude Code CLI (`claude -p`) EngineBackend. Spawns the installed
 * `claude` binary in print mode and routes the agent call through whatever
 * the CLI is authenticated against — on a VM that is a Claude Max/Pro
 * subscription (OAuth), so the per-call marginal cost is ~$0 vs per-token
 * Bedrock. callAgentModel rewrites a `bedrock` primary handle to this engine
 * at dispatch when NOELLE_CLAUDE_CLI=1; the registry only wires it under the
 * same flag. Bedrock remains the routing fallback if the CLI fails.
 *
 * Single-shot completion semantics:
 *   - `--system-prompt` REPLACES the default Claude Code harness prompt, so
 *     output is the model's raw answer (no tool/agent scaffolding, no CLAUDE.md).
 *   - the user prompt is piped on stdin (avoids ARG_MAX on long drafter prompts).
 *   - `--strict-mcp-config` + `--tools ""` guarantee no agentic turn AND keep
 *     every tool schema out of the request body (see NO_TOOLS below).
 *   - run from os.tmpdir() so no repo CLAUDE.md is auto-discovered.
 * We never pass `--bare`: it forces ANTHROPIC_API_KEY/apiKeyHelper auth and
 * never reads OAuth, which would bypass the subscription this backend exists for.
 */

export class ClaudeCliError extends Error {
  readonly stderr: string | undefined;
  constructor(message: string, stderr?: string) {
    super(message);
    this.name = "ClaudeCliError";
    this.stderr = stderr;
  }
}

export class ClaudeCliAuthError extends ClaudeCliError {
  constructor(message: string, stderr?: string) {
    super(message, stderr);
    this.name = "ClaudeCliAuthError";
  }
}

export type ClaudeCliBackend = EngineBackend;

export type CreateClaudeCliBackendOptions = {
  /** Path to the `claude` binary. Default "claude" (env NOELLE_CLAUDE_CLI_PATH). */
  cliPath?: string;
  /** Per-call wall-clock budget. Default 180s (env NOELLE_CLAUDE_CLI_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Replace child_process.spawn (testing only). */
  spawnImpl?: typeof nodeSpawn;
};

/**
 * The model used when the caller has no tier to express — the strongest one.
 * Env-overridable for ops (e.g. to pin an older model if a new one regresses);
 * setting NOELLE_CLAUDE_CLI_MODEL pins EVERY call, tier or not.
 *
 * Exported because it is the SINGLE SOURCE OF TRUTH for "which model does an
 * untiered claude-cli call actually run". Callers that merely *label* or
 * *stamp* the model (the dashboard chat route, Nova's text seam) must import
 * this rather than re-deriving the same env-or-default expression — three
 * hand-kept copies had already drifted apart, so the recorded model no longer
 * matched the model that ran. Those callers also pass this same value back as
 * `args.model`, which is not a tier key, so resolveClaudeCliModel hands it
 * straight back and the stamp stays honest.
 *
 * The `[1m]` suffix was dropped: it selects the 1M-token context window, and
 * these prompts run ~29K tokens — nowhere near the 200K where it changes
 * anything, while the long-context beta carries premium pricing.
 * `claude-opus-5` is verified valid on the live CLI (2.1.219).
 */
export const CLAUDE_CLI_MODEL =
  process.env.NOELLE_CLAUDE_CLI_MODEL?.trim() || "claude-opus-5";

/**
 * Noelle's abstract model handles → the model the CLI should actually run.
 *
 * The backend used to ignore `args.model` entirely and force the strongest
 * model on every call, reasoning that a flat-rate subscription has no
 * per-token cost. It has a cost: the weekly usage allowance. Forcing Opus made
 * the classifier — 52% of calls and 59% of output tokens, and declared
 * `claude-haiku-4-5` in modelCatalog — the most expensive thing Noelle ran.
 * Honour the tier the caller already chose.
 *
 * Each id below is verified accepted by the live CLI (2.1.219).
 */
type ClaudeCliTier = Extract<EngineHandle, { engine: "claude-cli" }>["model"];

/** What the CLI should actually run for a declared tier. */
type CliTarget = { model: string; effort?: "low" | "medium" | "high" | "xhigh" | "max" };

/**
 * Only tiers we have EVIDENCE for are mapped; anything unmapped falls back to
 * CLAUDE_CLI_MODEL at default effort, i.e. today's behaviour.
 *
 * The cheap tier runs **Opus 5 at low effort**, not Haiku. Benchmarked over 20
 * real leads from the Aug 24-26 window, scored against the verdicts production
 * actually stored:
 *
 *   config            agrees   output tok/call   $/call
 *   opus-5 default    16/20    387               0.0305
 *   opus-5 low        15/20    160               0.0248
 *   sonnet-5          16/20    1,512             0.0249
 *   haiku-4-5         14/20    2,674             0.0156
 *
 * Haiku and Sonnet are nominally 5x and 1.67x cheaper per token, but they
 * ramble: 2,674 and 1,512 output tokens where Opus emits 387 for the same JSON
 * verdict. That burns most of the discount, and a model that will not hold the
 * output contract is one schema-miss from failOpen(). `--effort low` keeps the
 * same model and cuts output 59% instead.
 *
 * Caveat worth knowing before trusting the agreement column: re-running the
 * SAME opus-5 against its own stored verdicts reproduced only 16/20, so the
 * classifier is ~80% self-consistent and n=20 cannot separate these models on
 * quality. Every disagreement was a false negative — a lead quietly dropped,
 * never junk promoted to the drafter.
 *
 * `claude-sonnet-4-6` stays unmapped. It is the drafter's tier, and the drafter
 * writes the replies that are the actual product; nothing here measures reply
 * quality. It is also where the money now is — after the tool-schema fix the
 * drafter lane carries ~22,900 input tokens per call against the classifier's
 * 3,049, i.e. ~74% of what is left — so it deserves a measured decision of its
 * own rather than a downgrade smuggled in here.
 */
const TIER_TO_CLI_MODEL: Readonly<Partial<Record<ClaudeCliTier, CliTarget>>> = {
  "claude-haiku-4-5": { model: "claude-opus-5", effort: "low" },
  "claude-opus-4-6": { model: "claude-opus-5" },
};

/**
 * Map an abstract handle to the CLI model to run. An explicit
 * NOELLE_CLAUDE_CLI_MODEL pins everything (ops escape hatch); an unrecognised
 * handle — including an already-concrete CLI model id — falls back to
 * CLAUDE_CLI_MODEL.
 */
export function resolveClaudeCliModel(handleModel?: string): string {
  // Read the pin at CALL time, not import time. Workers call
  // loadOperatorEnvFile() inside main() — after @noelle/runtime is evaluated —
  // so a pin from ~/.noelle/.env lands in process.env only after
  // CLAUDE_CLI_MODEL is already frozen. Returning the frozen constant here
  // would ignore the operator's pin AND silently disable tier routing, sending
  // every call back to Opus: the exact regression this file exists to prevent.
  return resolveClaudeCliTarget(handleModel).model;
}

/**
 * Full dispatch target for a handle: which model, and at what effort. An
 * explicit NOELLE_CLAUDE_CLI_MODEL pins the model and drops the effort flag —
 * an operator pinning a model is working around a regression and should get
 * that model's default behaviour, not an effort level chosen for another one.
 */
export function resolveClaudeCliTarget(handleModel?: string): CliTarget {
  const pinned = process.env.NOELLE_CLAUDE_CLI_MODEL?.trim();
  if (pinned) return { model: pinned };
  const tier = handleModel as ClaudeCliTier | undefined;
  return (tier && TIER_TO_CLI_MODEL[tier]) || { model: CLAUDE_CLI_MODEL };
}

/**
 * Env keys deleted from the child's environment so the CLI can ONLY use its
 * OAuth subscription. Any of these would route to an API key / 3P provider
 * (Bedrock, Vertex, a custom base URL) that bills real money — defeating the
 * point of this backend.
 */
const SANITIZED_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
] as const;

/** stderr/stdout substrings that mean "not logged in" rather than a model error. */
const AUTH_PATTERN = /invalid api key|oauth|not logged in|log ?in|credit balance|unauthorized/i;

/**
 * Disable the built-in tool set outright. These calls are single-shot
 * completions: they never need a tool, and every tool the CLI *offers* is
 * uploaded as a JSON schema in the request body whether or not it is called.
 *
 * This replaced `--disallowed-tools "Bash Edit Write ..."`, which denies
 * EXECUTION but still ships the definitions — and whose deny-list also missed
 * `Skill` and `ToolSearch`, so the skills catalog loaded too and the model
 * sometimes burned turns reaching for them. Measured on CLI 2.1.219, identical
 * system prompt and message, model claude-opus-5:
 *
 *   --disallowed-tools .................. 17,931 input tokens
 *   --disallowed-tools + no slash cmds .. 13,715 input tokens
 *   --tools "" .......................... 1,609 input tokens
 *
 * 16,322 tokens wasted on every call, charged at the 1.25x cache-WRITE rate
 * because each `claude -p` is a cold process that re-uploads the whole prefix.
 * Over 3 days that was ~153M tokens and the bulk of a $980 quota burn.
 */
const NO_TOOLS: readonly string[] = ["--tools", "", "--disable-slash-commands"];

/** Pre-`--tools` deny-list, kept only for the old-CLI fallback below. */
const LEGACY_DISALLOWED_TOOLS =
  "Bash Edit Write Read Glob Grep WebFetch WebSearch Task NotebookEdit";

/** commander's complaint when the installed CLI does not know a flag. */
const UNKNOWN_OPTION = /(?:unknown|unrecognized) option[\s:=]+['"`]?--(?:tools|disable-slash-commands)\b/i;

export function createClaudeCliBackend(
  opts?: CreateClaudeCliBackendOptions,
): ClaudeCliBackend {
  const cliPath = opts?.cliPath ?? (process.env.NOELLE_CLAUDE_CLI_PATH?.trim() || "claude");
  const configuredTimeout = process.env.NOELLE_CLAUDE_CLI_TIMEOUT_MS?.trim();
  const defaultTimeoutMs = opts?.timeoutMs ?? (configuredTimeout ? Number(configuredTimeout) : 180_000);
  const spawn = opts?.spawnImpl ?? nodeSpawn;

  const runCli = async (argv: string[], prompt: string, timeoutMs: number) => {
    const childEnv = { ...process.env };
    for (const key of SANITIZED_KEYS) delete childEnv[key];
    let output: Awaited<ReturnType<typeof runCliProcess>>;
    try {
      output = await runCliProcess({ command: cliPath, argv, prompt, timeoutMs,
        env: childEnv, cwd: tmpdir(), spawnImpl: spawn });
    } catch (error) {
      const reason = error instanceof CliProcessError ? error.code : "failed";
      const detail = reason === "timed_out" ? `timed out after ${timeoutMs}ms` : reason;
      throw new ClaudeCliError(`claude cli ${detail}`, error instanceof CliProcessError ? error.stderr : undefined);
    }
    const { stdout, stderr, code } = output;
    let json: { type?: unknown; is_error?: unknown; result?: unknown; subtype?: unknown; total_cost_usd?: unknown;
      usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number } } | null = null;
    try {
      const value: unknown = JSON.parse(stdout.trim());
      if (value !== null && typeof value === "object" && !Array.isArray(value)) json = value;
    } catch { /* Handled as an invalid completion below. */ }
    if (json?.is_error === true) {
      const detail = typeof json.result === "string" ? json.result : typeof json.subtype === "string" ? json.subtype : "unknown";
      if (AUTH_PATTERN.test(detail) || AUTH_PATTERN.test(stderr)) {
        throw new ClaudeCliAuthError(`claude cli auth failure: ${detail}`, stderr);
      }
      throw new ClaudeCliError(`claude cli result error: ${detail}`, stderr);
    }
    if (code !== 0) {
      if (AUTH_PATTERN.test(stderr)) throw new ClaudeCliAuthError(`claude cli auth failure (exit ${code ?? "null"})`, stderr);
      throw new ClaudeCliError(`claude cli exited ${code ?? "null"}`, stderr);
    }
    if (!json || json.type !== "result" || (json.is_error !== undefined && json.is_error !== false)
      || typeof json.result !== "string" || !json.result.trim()) {
      throw new ClaudeCliError("claude cli returned an invalid completion", stderr);
    }
    const usage: TokenUsage = {
      ...reportedAnthropicUsage(json.usage),
      ...(typeof json.total_cost_usd === "number" && Number.isFinite(json.total_cost_usd) && json.total_cost_usd >= 0
        ? { cost_usd: json.total_cost_usd } : {}),
    };
    return { text: json.result, usage };
  };

  return {
    async call(args) {
      const target = resolveClaudeCliTarget(args.model);
      const base = [
        "--print",
        "--output-format",
        "json",
        "--model",
        target.model,
        ...(target.effort ? ["--effort", target.effort] : []),
        "--system-prompt",
        args.system,
        "--strict-mcp-config",
      ];

      // A per-call budget wins over the backend default: one global timeout
      // cannot serve both a ~9s drafter reply and a ~160s pattern-breaker run.
      let timeoutMs: number;
      try { timeoutMs = cliTimeoutMs(args.timeoutMs ?? defaultTimeoutMs); }
      catch { throw new ClaudeCliError("claude cli invalid_request"); }
      const deadline = performance.now() + timeoutMs;
      try {
        return await runCli([...base, ...NO_TOOLS], args.prompt, timeoutMs);
      } catch (err) {
        // Nothing pins the CLI version on the VM. On a binary that predates
        // `--tools`, commander rejects the flag and EVERY call fails — and
        // because callAgentModel rewrites the routing FALLBACK through this
        // same engine for an llm_backend='claude' org, there is no unpaid
        // rescue behind it. Degrade to the old deny-list instead of losing the
        // call: expensive, but the org keeps working.
        if (err instanceof ClaudeCliError && UNKNOWN_OPTION.test(err.stderr ?? "")) {
          const remainingMs = Math.ceil(deadline - performance.now());
          if (remainingMs < 1) throw new ClaudeCliError(`claude cli timed out after ${timeoutMs}ms`);
          return await runCli([...base, "--disallowed-tools", LEGACY_DISALLOWED_TOOLS], args.prompt, remainingMs);
        }
        throw err;
      }
    },
  };
}
