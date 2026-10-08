import type {
  AgentTool,
  EngineHandle,
  ModelRouting,
  AgentCallContext,
  AgentRole,
} from "./types.js";
import { assertWithinCap, type CapAdapters, BudgetExceededError } from "./budgetBucket.js";
import { ClaudeCliAuthError } from "./claudeCliBackend.js";
import { estimateCallCents } from "./llmPrices.js";
import {
  noopSpendRecorder,
  type SpendRecorder,
  type SpendStatus,
} from "./spendRecorder.js";
import { shouldCacheSystem } from "./promptCache.js";
import { PgOperationError } from "./boundedPgSession.js";
import { completedCallAccounting, failedCallAccounting } from "./callCostAccounting.js";

export type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
  /** False when normalized counts do not represent validated provider metadata. */
  token_usage_reported?: boolean;
  /**
   * Provider-reported accounting amount, when available. A finite zero is
   * authoritative; absent amounts use validated usage and the known price table.
   */
  cost_usd?: number;
};

/**
 * Prior conversation turns to prepend before `prompt`, oldest first. Only the
 * talk-to-agent chat route uses this today; workers leave it undefined. Must
 * alternate user/assistant and start with `user` (Anthropic constraint) — the
 * caller is responsible for shaping it. Backends that don't implement
 * multi-turn simply ignore it.
 */
export type ChatHistoryTurn = { role: "user" | "assistant"; content: string };

export type EngineBackend = {
  call(args: {
    system: string;
    prompt: string;
    model: string;
    tools?: ReadonlyArray<AgentTool>;
    history?: ReadonlyArray<ChatHistoryTurn>;
    /**
     * Char length of the stable system PREFIX to cache (prefix-split caching,
     * NOELLE_PROMPT_CACHE_ENABLED). Only forwarded when the flag is on; only
     * honored by caching-capable backends (bedrock, anthropic) — others ignore
     * it (fail-open, byte-identical request).
     */
    systemCachePrefixLen?: number;
    /**
     * Cache the ENTIRE system block (whole-system caching,
     * NOELLE_PROMPT_CACHE_SYSTEM, for byte-stable drafter buckets). Only set
     * when the flag + bucket qualify; ignored by non-caching backends.
     */
    cacheSystem?: boolean;
    /**
     * Per-call deadline for supporting backends. Gemini HTTP backends apply it
     * through the response body; CLI backends apply it to their owned process.
     */
    timeoutMs?: number;
    /** Codex CLI reasoning level. Other backends ignore this field. */
    reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  }): Promise<{ text: string; usage: TokenUsage }>;
};

export type EngineKey = EngineHandle["engine"];

export type EngineRegistry = Partial<Record<EngineKey, EngineBackend>>;

export class EngineNotImplementedError extends Error {
  readonly engine: EngineKey;
  constructor(engine: EngineKey) {
    super(`engine "${engine}" not configured`);
    this.engine = engine;
  }
}

export class ModelNotDispatchedError extends Error {
  constructor() {
    super("Model dispatch was refused before provider execution");
    this.name = "ModelNotDispatchedError";
  }
}

export type CallAgentModelArgs = {
  bucket: string;
  routing: ModelRouting;
  orgId: string;
  instanceId: string;
  /** Which worker is making the call: "drafter" | "classifier" | "send" | … */
  worker: string;
  /** The role of the agent making the call. */
  agentRole: AgentRole;
  system: string;
  prompt: string;
  /**
   * Use the supplied routing handles directly. This bypasses process-wide
   * Codex-primary selection and the per-org/local Claude CLI rewrite while
   * preserving cap checks, spend recording, and the configured fallback.
   */
  directRouting?: boolean;
  /** Use only the local Codex subscription. Never probe Claude or paid APIs. */
  codexSubscriptionOnly?: boolean;
  /** Reasoning level for an explicit Codex subscription call. */
  codexReasoningEffort?: "low" | "medium" | "high" | "xhigh";
  tools?: ReadonlyArray<AgentTool>;
  /**
   * Char length of the stable system PREFIX the caller wants cached. Only
   * honored when NOELLE_PROMPT_CACHE_ENABLED=1 AND the backend supports caching;
   * ignored otherwise (fail-open). See packages/runtime/src/promptCache.ts.
   */
  systemCachePrefixLen?: number;
  /** Optional payload forwarded to escalation predicates as AgentCallContext.payload. */
  payload?: unknown;
};

export type CallAgentModelResult = {
  text: string;
  usage: TokenUsage;
  engineUsed: EngineHandle;
  outcome: "ok" | "fallback";
};

export type BudgetDeps = {
  adapters: CapAdapters;
  /**
   * Optional pure cents estimator for the pre-flight cap check. Receives the
   * candidate engine + payload sizes. When omitted, callAgentModel synthesizes
   * an estimate using the price table: input_tokens ≈ ceil(promptLen / 4) and
   * output_tokens ≈ 250 (≈1KB of text). Override for tighter accuracy.
   */
  estimateCents?: (args: { engine: EngineHandle; system: string; prompt: string }) => number;
};

export type CallAgentModelDeps = {
  engines: EngineRegistry;
  budget: BudgetDeps;
  /** Defaults to `noopSpendRecorder` so tests and unwired callers still work. */
  recorder?: SpendRecorder;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
  /**
   * Per-org global agent LLM backend switch. Resolves
   * noelle.organizations.llm_backend ('aws' | 'claude') for the call's org.
   * When provided, it (not the NOELLE_CLAUDE_CLI env flag) decides whether a
   * `bedrock` PRIMARY handle is rewritten to the local `claude-cli`
   * subscription: 'claude' → rewrite (iff the claude-cli backend is wired),
   * 'aws' → stay on Bedrock. When OMITTED, behavior is identical to today —
   * the env flag drives the rewrite. See makeLlmBackendResolver.
   */
  getLlmBackend?: (orgId: string) => Promise<"aws" | "claude">;
};

/**
 * Adapters + estimator that grant effectively unlimited budget. ONLY for tests
 * and local dev where cap enforcement isn't being exercised. Production
 * callers must wire real budget deps so the three-layer cap pre-flight runs
 * before every LLM call.
 */
export const unlimitedBudget: BudgetDeps = {
  estimateCents: () => 0,
  adapters: {
    fetchSpend: async () => ({ bucket: 0, org: 0, instance: 0 }),
    fetchCaps: async () => ({
      bucket: Number.MAX_SAFE_INTEGER,
      org: Number.MAX_SAFE_INTEGER,
      instance: Number.MAX_SAFE_INTEGER,
    }),
  },
};

/**
 * Route an agent call through the configured engines.
 *
 * Order:
 * 1. If NOELLE_CODEX_PRIMARY=1 and Codex is available + under its cap, use it.
 * 2. Otherwise, if routing.escalation?.when(ctx) → use escalation.engine.
 * 3. Else use routing.primary.
 * 4. If the chosen engine throws, try routing.fallback (re-checking budget).
 * 5. Otherwise propagate the error.
 */
/**
 * VM cost switch. When `enabled`, route a `bedrock` Claude handle through the
 * local `claude -p` CLI (a Claude Max/Pro subscription, ~$0/call) instead of
 * per-token AWS Bedrock. `enabled` is resolved centrally in callAgentModel from
 * EITHER the per-org noelle.organizations.llm_backend setting (when a
 * getLlmBackend resolver is wired) OR the NOELLE_CLAUDE_CLI env flag (legacy /
 * back-compat) — AND gated on the claude-cli backend actually being registered.
 * Applied to the PRIMARY handle AND the routing fallback, so a subscription org
 * (llm_backend='claude') never pays for Bedrock even when the primary CLI call
 * fails — the fallback is a $0 claude-cli retry, not paid AWS. With
 * llm_backend='aws' the rewrite is a no-op and the Bedrock fallback is preserved.
 * No-op unless `enabled` and the engine is `bedrock`; `claude`/`vertex`/`openai`
 * handles pass through.
 */
export function rewriteForClaudeCli(handle: EngineHandle, enabled: boolean): EngineHandle {
  if (enabled && handle.engine === "bedrock") {
    return { engine: "claude-cli", model: handle.model };
  }
  return handle;
}

export async function callAgentModel(
  args: CallAgentModelArgs,
  deps: CallAgentModelDeps,
): Promise<CallAgentModelResult> {
  const log = deps.log ?? (() => {});
  const recorder = deps.recorder ?? noopSpendRecorder;

  const escalationCtx: AgentCallContext = {
    orgId: args.orgId,
    instanceId: args.instanceId,
    bucket: args.bucket,
    routing: args.routing,
    log,
    payload: args.payload,
  };

  if (args.codexSubscriptionOnly === true) {
    const target: EngineHandle = { engine: "codex-cli", model: "gpt-5" };
    if (!(await codexPotHasRoom(deps, args.orgId))) {
      throw new Error("Codex subscription budget exhausted");
    }
    return invoke({
      engine: target,
      args,
      deps,
      recorder,
      outcome: "ok",
      skipCapPreflight: true,
    });
  }

  // Resolve the claude-cli rewrite decision centrally, once per call:
  //   - claudeAvailable: the local subscription backend is actually wired
  //     (NOELLE_CLAUDE_CLI=1 on this box). Never rewrite to an engine we can't
  //     invoke — that would throw EngineNotImplementedError.
  //   - wantClaude: the per-org switch (getLlmBackend) when wired, else the
  //     legacy NOELLE_CLAUDE_CLI env flag (back-compat for unwired callers).
  // Applied to the primary handle here (incl. the escalation handle when
  // escalation fires) AND to the routing fallback in the catch below, so a
  // subscription org never falls through to paid Bedrock.
  const claudeAvailable = !!deps.engines["claude-cli"];
  const wantClaude = args.directRouting
    ? false
    : deps.getLlmBackend
      ? (await deps.getLlmBackend(args.orgId)) === "claude"
      : process.env.NOELLE_CLAUDE_CLI === "1";
  const codexPrimaryEnabled =
    !args.directRouting && process.env.NOELLE_CODEX_PRIMARY === "1";
  // Codex-primary replaces the local Claude subscription for this process.
  // If Codex has no room or a call fails, keep the underlying configured
  // engine available instead of probing a Claude session the operator has
  // explicitly switched away from.
  const claudeRewriteEnabled = claudeAvailable && wantClaude && !codexPrimaryEnabled;
  const primaryChoice: EngineHandle = rewriteForClaudeCli(
    args.routing.escalation && args.routing.escalation.when(escalationCtx)
      ? args.routing.escalation.engine
      : args.routing.primary,
    claudeRewriteEnabled,
  );

  // Explicit operator switch: use the ChatGPT subscription as the first call,
  // not merely after Claude's cap or login fails. Keep the configured route as
  // the availability fallback, and keep the separate Codex-pot ceiling in
  // force. This also avoids recording one known-dead Claude auth attempt for
  // every useful Codex call during an outage.
  let codexPrimaryAttempted = false;
  if (
    codexPrimaryEnabled &&
    deps.engines["codex-cli"] &&
    (await codexPotHasRoom(deps, args.orgId))
  ) {
    const codexPrimary: EngineHandle = { engine: "codex-cli", model: "gpt-5" };
    codexPrimaryAttempted = true;
    log("codex primary selected", { primary: codexPrimary, fallback: primaryChoice });
    try {
      return await invoke({
        engine: codexPrimary,
        args,
        deps,
        recorder,
        outcome: "ok",
        skipCapPreflight: true,
      });
    } catch (codexErr) {
      if (codexErr instanceof PgOperationError) throw codexErr;
      log("codex primary failed, using configured route", {
        primary: codexPrimary,
        fallback: primaryChoice,
        error: errMsg(codexErr),
      });
    }
  }

  try {
    return await invoke({
      engine: primaryChoice,
      args,
      deps,
      recorder,
      outcome: codexPrimaryAttempted ? "fallback" : "ok",
    });
  } catch (primaryErr) {
    if (primaryErr instanceof PgOperationError) throw primaryErr;
    const primaryClaudeAuthFailed = isClaudeCliAuthFailure(primaryChoice, primaryErr);
    if (
      !codexPrimaryAttempted &&
      (primaryErr instanceof BudgetExceededError || primaryClaudeAuthFailed)
    ) {
      const codexResult = await tryCodexFailover({
        source: primaryChoice,
        error: primaryErr,
        args,
        deps,
        recorder,
        log,
      });
      if (codexResult) return codexResult;

      // A spent cap must stop the paid/subscription routing fallback too. An auth
      // failure is different: a configured fallback on another engine may still
      // be healthy, so preserve it when Codex is unavailable or also fails.
      if (primaryErr instanceof BudgetExceededError) throw primaryErr;
    }

    if (!args.routing.fallback) throw primaryErr;
    const fallbackChoice = rewriteForClaudeCli(
      args.routing.fallback,
      claudeRewriteEnabled,
    );

    // Both Bedrock handles rewrite to the same local Claude session. Once that
    // session reports an auth failure, changing its model cannot make it usable.
    if (primaryClaudeAuthFailed && fallbackChoice.engine === "claude-cli") {
      throw primaryErr;
    }

    // Rewrite the FALLBACK through the same claude-cli switch as the primary.
    // Historically only the primary was rewritten and the fallback stayed
    // Bedrock, so any claude-cli failure (auth expired, binary missing, timeout)
    // silently billed AWS. When the org is on the local subscription
    // (llm_backend='claude', or the NOELLE_CLAUDE_CLI env flag) we want ZERO paid
    // Bedrock: a `bedrock` fallback becomes `claude-cli` too — a flat-rate ($0)
    // retry. With llm_backend='aws' the rewrite is a no-op and the Bedrock
    // fallback is preserved exactly as before.
    log("primary engine failed, falling back", {
      primary: primaryChoice,
      fallback: fallbackChoice,
      error: errMsg(primaryErr),
    });
    try {
      return await invoke({
        engine: fallbackChoice,
        args,
        deps,
        recorder,
        outcome: "fallback",
      });
    } catch (fallbackErr) {
      if (!codexPrimaryAttempted && isClaudeCliAuthFailure(fallbackChoice, fallbackErr)) {
        const codexResult = await tryCodexFailover({
          source: fallbackChoice,
          error: fallbackErr,
          args,
          deps,
          recorder,
          log,
        });
        if (codexResult) return codexResult;
      }
      throw fallbackErr;
    }
  }
}

function isClaudeCliAuthFailure(engine: EngineHandle, error: unknown): boolean {
  return engine.engine === "claude-cli" && error instanceof ClaudeCliAuthError;
}

async function tryCodexFailover(opts: {
  source: EngineHandle;
  error: unknown;
  args: CallAgentModelArgs;
  deps: CallAgentModelDeps;
  recorder: SpendRecorder;
  log: (msg: string, meta?: Record<string, unknown>) => void;
  /** A caller explicitly requested the local-subscription-only route. */
  force?: boolean;
}): Promise<CallAgentModelResult | null> {
  const eligible =
    opts.force === true ||
    opts.error instanceof BudgetExceededError ||
    isClaudeCliAuthFailure(opts.source, opts.error);
  if (!eligible) return null;

