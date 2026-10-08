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

  const codex = opts.deps.engines["codex-cli"];
  if (
    !codex ||
    !codexFailoverEnabled() ||
    !(await codexPotHasRoom(opts.deps, opts.args.orgId))
  ) {
    return null;
  }

  const target: EngineHandle = { engine: "codex-cli", model: "gpt-5" };
  opts.log("claude unavailable, failing over to codex", {
    primary: opts.source,
    fallback: target,
    error: errMsg(opts.error),
  });
  try {
    return await invoke({
      engine: target,
      args: opts.args,
      deps: opts.deps,
      recorder: opts.recorder,
      outcome: "fallback",
      skipCapPreflight: true,
    });
  } catch (codexErr) {
    if (codexErr instanceof PgOperationError) throw codexErr;
    opts.log("codex failover failed", {
      primary: opts.source,
      fallback: target,
      error: errMsg(codexErr),
    });
    return null;
  }
}

/** Meter a direct backend through the same admission and settlement owner as routed calls. */
export function createBudgetedBackend(backend: EngineBackend, options: {
  engine: EngineKey;
  context: Pick<CallAgentModelArgs, "orgId" | "instanceId" | "agentRole" | "worker" | "bucket">;
  budget: BudgetDeps;
  recorder: SpendRecorder;
  /** A bounded acknowledgement after admission; the callback must not invoke a provider. */
  beforeDispatch?: () => Promise<"dispatch" | "not_dispatched">;
}): EngineBackend {
  return {
    async call(call) {
      const engine = { engine: options.engine, model: call.model } as EngineHandle;
      const result = await invoke({ engine, args: { ...options.context, system: call.system,
        prompt: call.prompt, routing: { primary: engine } },
        deps: { engines: { [options.engine]: backend }, budget: options.budget },
        recorder: options.recorder, outcome: "ok", callOverride: call,
        ...(options.beforeDispatch ? { beforeDispatch: options.beforeDispatch } : {}) });
      return { text: result.text, usage: result.usage };
    },
  };
}

async function invoke(opts: {
  engine: EngineHandle;
  args: CallAgentModelArgs;
  deps: CallAgentModelDeps;
  recorder: SpendRecorder;
  outcome: "ok" | "fallback";
  /**
   * Skip the cap pre-flight for this call. Set ONLY on the codex failover: the
   * cap that sent us here measures the Claude pot, so re-checking it would
   * refuse the very call meant to route around it. Codex spend is excluded from
   * that cap (see CAP_EXEMPT_ENGINES_*) and is bounded today by ChatGPT's own
   * account limits rather than by Noelle.
   */
  skipCapPreflight?: boolean;
  callOverride?: Parameters<EngineBackend["call"]>[0];
  beforeDispatch?: () => Promise<"dispatch" | "not_dispatched">;
}): Promise<CallAgentModelResult> {
  const backend = opts.deps.engines[opts.engine.engine];
  if (!backend) throw new EngineNotImplementedError(opts.engine.engine);


  const call: Parameters<EngineBackend["call"]>[0] = opts.callOverride ?? {
    system: opts.args.system,
    prompt: opts.args.prompt,
    model: opts.engine.model,
  };
  if (!opts.callOverride && opts.args.tools) call.tools = opts.args.tools;
  if (!opts.callOverride && opts.engine.engine === "codex-cli" && opts.args.codexReasoningEffort) {
    call.reasoningEffort = opts.args.codexReasoningEffort;
  }
  // Prompt caching (default OFF). Both env reads happen ONLY here at the impure
  // boundary; the decision helpers stay pure. When a flag is off the field is
  // NOT set, so the request object is byte-identical to today.
  //
  //  - PREFIX split (NOELLE_PROMPT_CACHE_ENABLED): forward the caller-computed
  //    prefix length so a caching-capable backend caches the stable prefix.
  //  - WHOLE-system (NOELLE_PROMPT_CACHE_SYSTEM): cache the entire system block
  //    for byte-stable drafter buckets.
  // If both were on, the prefix split takes precedence in the backend (it is a
  // strict superset — it caches a prefix and leaves the rest uncached).
  if (
    !opts.callOverride && process.env.NOELLE_PROMPT_CACHE_ENABLED === "1" &&
    typeof opts.args.systemCachePrefixLen === "number"
  ) {
    call.systemCachePrefixLen = opts.args.systemCachePrefixLen;
  }
  if (!opts.callOverride && shouldCacheSystem(opts.args.bucket, process.env.NOELLE_PROMPT_CACHE_SYSTEM)) {
    call.cacheSystem = true;
  }
  const deadline = bucketTimeoutMs(opts.args.bucket);
  if (!opts.callOverride && deadline !== undefined) call.timeoutMs = deadline;

  const preflightCents = opts.deps.budget.estimateCents
    ? opts.deps.budget.estimateCents({ engine: opts.engine, system: call.system, prompt: call.prompt })
    : estimatePreflightCents(opts.engine, call.system, call.prompt);
  let attemptId: string | undefined;
  try {
    const reserve = opts.deps.budget.adapters.reserveAttempt;
    if (reserve) {
      const admission = await reserve({
        orgId: opts.args.orgId, instanceId: opts.args.instanceId, agentRole: opts.args.agentRole,
        worker: opts.args.worker, bucket: opts.args.bucket, engine: opts.engine.engine,
        model: opts.engine.model, estimatedCents: preflightCents,
        ...(opts.engine.engine === "codex-cli" ? { engineCapCents: Math.floor(codexCapCents()) } : {}),
      });
      attemptId = admission.attemptId;
    } else if (!opts.skipCapPreflight) {
      await assertWithinCap({ bucket: opts.args.bucket, orgId: opts.args.orgId,
        instanceId: opts.args.instanceId, estimatedCents: preflightCents }, opts.deps.budget.adapters);
    }
  } catch (error) {
    if (error instanceof BudgetExceededError) {
      await safeRecord(opts.recorder, {
        orgId: opts.args.orgId, instanceId: opts.args.instanceId, agentRole: opts.args.agentRole,
        worker: opts.args.worker, engine: opts.engine.engine, model: opts.engine.model,
        bucket: opts.args.bucket, inputTokens: 0, outputTokens: 0, cents: 0,
        latencyMs: null, status: "budget_exceeded", costBasis: "not_dispatched", startedAt: new Date(),
      });
    }
    throw error;
  }

  const startedAt = new Date();
  if (opts.beforeDispatch) {
    let decision: "dispatch" | "not_dispatched" | undefined;
    let acknowledgementError: unknown;
    try {
      decision = await opts.beforeDispatch();
      if (decision !== "dispatch" && decision !== "not_dispatched") {
        throw new Error("Invalid model dispatch acknowledgement");
      }
    } catch (error) {
      acknowledgementError = error;
    }
    if (decision !== "dispatch") {
      const confirmed = decision === "not_dispatched";
      await safeRecord(opts.recorder, {
        orgId: opts.args.orgId, instanceId: opts.args.instanceId, agentRole: opts.args.agentRole,
        worker: opts.args.worker, engine: opts.engine.engine, model: opts.engine.model,
        bucket: opts.args.bucket, inputTokens: 0, outputTokens: 0, cents: 0, latencyMs: null,
        status: "error", costBasis: confirmed ? "not_dispatched" : "unknown", startedAt,
        ...(attemptId ? { attemptId } : {}),
      });
      if (confirmed) throw new ModelNotDispatchedError();
      throw acknowledgementError;
    }
  }
  const t0 = Date.now();
  try {
    const { text, usage: reportedUsage } = await backend.call(call);
    const latencyMs = Date.now() - t0;
    const accounting = completedCallAccounting(opts.engine, reportedUsage);
    const usage: TokenUsage = { input_tokens: accounting.inputTokens, output_tokens: accounting.outputTokens,
      ...(!accounting.tokenUsageReported ? { token_usage_reported: false } : {}),
      ...(accounting.costBasis === "provider_reported" ? { cost_usd: reportedUsage.cost_usd } : {}) };
    await safeRecord(opts.recorder, {
      orgId: opts.args.orgId,
      instanceId: opts.args.instanceId,
      agentRole: opts.args.agentRole,
      worker: opts.args.worker,
      engine: opts.engine.engine,
      model: opts.engine.model,
      bucket: opts.args.bucket,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cents: accounting.cents,
      costBasis: accounting.costBasis,
      latencyMs,
      status: "ok",
      startedAt,
      ...(attemptId ? { attemptId } : {}),
    });
    return { text, usage, engineUsed: opts.engine, outcome: opts.outcome };
  } catch (engineErr) {
    const latencyMs = Date.now() - t0;
    const status: SpendStatus = isTimeout(engineErr) ? "timeout" : "error";
    // A dispatched failure has no confirmed usage. Its estimate remains distinct
    // from provider accounting, and the durable admission remains held.
    const failedInputTokens = Math.ceil((opts.args.system.length + opts.args.prompt.length) / 4);
    const accounting = failedCallAccounting(opts.engine, failedInputTokens);
    await safeRecord(opts.recorder, {
      orgId: opts.args.orgId,
      instanceId: opts.args.instanceId,
      agentRole: opts.args.agentRole,
      worker: opts.args.worker,
      engine: opts.engine.engine,
      model: opts.engine.model,
      bucket: opts.args.bucket,
      inputTokens: accounting.inputTokens,
      outputTokens: 0,
      cents: accounting.cents,
      costBasis: accounting.costBasis,
      latencyMs,
      status,
      startedAt,
      ...(attemptId ? { attemptId } : {}),
    });
    throw engineErr;
  }
}

/**
 * Estimate input tokens from prompt length (≈4 chars/token, typical for
 * mixed English+code) and assume a 1KB output (≈250 tokens). The 1KB
 * assumption matches the spec: small enough that the cap rarely false-
 * positives on long-prompt calls, large enough that the cap actually
 * catches runaway loops.
 */
function estimatePreflightCents(
  engine: EngineHandle,
  system: string,
  prompt: string,
): number {
  const charCount = system.length + prompt.length;
  const inputTokens = Math.ceil(charCount / 4);
  const outputTokens = 250;
  return safeEstimateCents(engine, inputTokens, outputTokens);
}

/**
 * Buckets that need longer than the backend default. Everything absent keeps
 * the default, so a slow drafter still fails fast rather than holding a worker.
 *
 * `ideation` is the pattern-breaker: it reads up to 100 posts and emits ~12,000
 * tokens of findings. Observed over Aug 24-26 it finished in 157-175s when it
 * finished at all, and blew the 180s default 54 times out of 66 — 82% of the
 * lane. Each of those still paid for the input and the generation and kept
 * nothing. 600s gives the job room while remaining a real ceiling for a task
 * that runs once every six hours.
 */
const BUCKET_TIMEOUT_MS: Readonly<Record<string, number>> = {
  ideation: Number(process.env.NOELLE_IDEATION_TIMEOUT_MS) || 600_000,
};

export function bucketTimeoutMs(bucket: string): number | undefined {
  return BUCKET_TIMEOUT_MS[bucket];
}

/**
 * Whether a spent Claude budget should fall through to the ChatGPT
 * subscription. On by default once a codex-cli backend is wired — wiring one is
 * already an explicit act. NOELLE_CODEX_FAILOVER=0 turns it off and restores
 * "the cap stops the work".
 */
export function codexFailoverEnabled(): boolean {
  return process.env.NOELLE_CODEX_FAILOVER !== "0";
}

/**
 * The Codex pot's own ceiling, in cents. Separate from the Claude cap by
 * design: the two are different subscriptions, and one running out says nothing
 * about the other. Default $500/period, matching what the Claude side is set to.
 */
export function codexCapCents(): number {
  const raw = Number(process.env.NOELLE_CODEX_CAP_CENTS);
  return Number.isFinite(raw) && raw > 0 ? raw : 50_000;
}

/**
 * Whether the ChatGPT pot still has room this period.
 *
 * "Exempt from the Claude cap" was left meaning "unbounded", which is not a
 * thing a budget system should have — the failover would have kept spending a
 * second subscription with nothing watching it. This is the ceiling for that
 * pot, measured over the same window the Claude cap uses.
 *
 * An adapter that cannot report per-engine spend (an older one, or a test stub)
 * returns true: the failover then behaves as it did before this check existed,
 * which is the fail-OPEN direction — deliberately. The alternative is refusing
 * to fail over on a monitoring gap, i.e. going dark to protect a budget nobody
 * is actually measuring.
 */
async function codexPotHasRoom(deps: CallAgentModelDeps, orgId: string): Promise<boolean> {
  // Durable adapters check the separate pot atomically immediately before dispatch.
  if (deps.budget.adapters.reserveAttempt) return true;
  const read = deps.budget.adapters.fetchEngineSpend;
  if (!read) return true;
  try {
    const spent = await read({ engine: "codex-cli", orgId });
    return spent < codexCapCents();
  } catch {
    return true;
  }
}

function safeEstimateCents(
  engine: EngineHandle,
  inputTokens: number,
  outputTokens: number,
): number {
  try {
    return estimateCallCents({
      engine: engine.engine,
      model: engine.model,
      inputTokens,
      outputTokens,
    });
  } catch {
    return 0;
  }
}

async function safeRecord(
  recorder: SpendRecorder,
  row: import("./spendRecorder.js").SpendRow,
): Promise<void> {
  try {
    await recorder.record(row);
  } catch {
    // A durable admission remains held when receipt persistence fails.
  }
}

function isTimeout(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const msg = ("message" in err && typeof (err as { message: unknown }).message === "string"
    ? (err as { message: string }).message
    : "").toLowerCase();
  return msg.includes("timed out") || msg.includes("timeout") || msg.includes("etimedout");
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
