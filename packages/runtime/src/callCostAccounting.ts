import type { EngineHandle } from "./types.js";
import { estimateCallCents, getPrice } from "./llmPrices.js";
import type { SpendCostBasis } from "./spendRecorder.js";
import type { TokenUsage } from "./callAgentModel.js";

const PG_INTEGER_MAX = 2_147_483_647;
export const isAccountingInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= PG_INTEGER_MAX;

/** Invalid or absent provider counts remain unreported, with safe numeric storage values. */
export function normalizeTokenUsage(input: unknown, output: unknown): TokenUsage {
  return { input_tokens: isAccountingInteger(input) ? input : 0,
    output_tokens: isAccountingInteger(output) ? output : 0,
    ...(!isAccountingInteger(input) || !isAccountingInteger(output) ? { token_usage_reported: false } : {}) };
}

/** Provider amounts and token estimates are accounting values, with explicit provenance. */
export function completedCallAccounting(engine: EngineHandle, reported: unknown): {
  cents: number; costBasis: SpendCostBasis; inputTokens: number; outputTokens: number; tokenUsageReported: boolean;
} {
  const usage = reported && typeof reported === "object" ? reported as Record<string, unknown> : {};
  const inputTokens = isAccountingInteger(usage.input_tokens) ? usage.input_tokens : 0;
  const outputTokens = isAccountingInteger(usage.output_tokens) ? usage.output_tokens : 0;
  const tokenUsageReported = usage.token_usage_reported !== false && isAccountingInteger(usage.input_tokens) && isAccountingInteger(usage.output_tokens);
  if (typeof usage.cost_usd === "number" && Number.isFinite(usage.cost_usd) && usage.cost_usd >= 0) {
    const cents = Math.ceil(usage.cost_usd * 100);
    if (isAccountingInteger(cents)) return { cents, costBasis: "provider_reported", inputTokens, outputTokens, tokenUsageReported };
  }
  if (tokenUsageReported && getPrice(engine.engine, engine.model)) {
    const cents = estimateCallCents({ engine: engine.engine, model: engine.model, inputTokens, outputTokens });
    if (isAccountingInteger(cents)) return { cents, costBasis: "token_estimate", inputTokens, outputTokens, tokenUsageReported };
  }
  return { cents: 0, costBasis: "unknown", inputTokens, outputTokens, tokenUsageReported };
}

/** Missing failure usage keeps the admitted estimate held, even when a prompt estimate is recorded. */
export function failedCallAccounting(engine: EngineHandle, inputTokens: number) {
  const result = completedCallAccounting(engine, { input_tokens: inputTokens, output_tokens: 0 });
  return { ...result, costBasis: result.costBasis === "token_estimate" ? "failure_estimate" as const : "unknown" as const };
}
