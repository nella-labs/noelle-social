/**
 * Per-(engine, model) price table. Cents per million tokens.
 *
 * Source of truth for billing. When AWS/Anthropic/Google updates a list
 * price, change the value here. The rest of the codebase reads from
 * `getPrice` / `estimateCallCents` so call-site arithmetic stays consistent.
 */

export type EngineKey = "vertex" | "bedrock" | "claude" | "claude-cli" | "codex-cli" | "openai";

export type Price = {
  input_per_mtok_cents: number;
  output_per_mtok_cents: number;
};

/**
 * Keys are "engine/model" strings. The table is intentionally exhaustive
 * for the engines/models declared in `EngineHandle` (packages/runtime/src/types.ts).
 * If a new engine handle lands without a row here, `estimateCallCents`
 * throws — that's deliberate. Adding a model with no price would let a
 * worker route to an un-billable engine silently.
 */
export const KNOWN_PRICES: Record<string, Price> = {
  "bedrock/claude-haiku-4-5": { input_per_mtok_cents: 110, output_per_mtok_cents: 550 },
  "bedrock/claude-sonnet-4-6": { input_per_mtok_cents: 330, output_per_mtok_cents: 1650 },
  "bedrock/claude-opus-4-6": { input_per_mtok_cents: 550, output_per_mtok_cents: 2750 },
  "vertex/claude-sonnet-4-6": { input_per_mtok_cents: 300, output_per_mtok_cents: 1500 },
  "vertex/gemini-2-flash": { input_per_mtok_cents: 15, output_per_mtok_cents: 60 },
  "vertex/gemini-2-5-flash": { input_per_mtok_cents: 15, output_per_mtok_cents: 60 },
  "vertex/gemini-2-5-pro": { input_per_mtok_cents: 125, output_per_mtok_cents: 500 },
  "claude/claude-haiku-4-5": { input_per_mtok_cents: 80, output_per_mtok_cents: 400 },
  "claude/claude-sonnet-4-6": { input_per_mtok_cents: 300, output_per_mtok_cents: 1500 },
  "claude/claude-opus-4-6": { input_per_mtok_cents: 1500, output_per_mtok_cents: 7500 },
  // Local Claude CLI (`claude -p`) draws on a Claude Max/Pro subscription rather
  // than a per-token invoice, so these are QUOTA-EQUIVALENT prices: what the
  // same tokens would list at, which is the basis the CLI itself uses for the
  // `total_cost_usd` it reports. They exist to make the cap pre-flight
  // meaningful — a completed call records the CLI's own figure instead.
  //
  // They used to be 0/0 on the premise that a subscription call is free. It is
  // not free, it is prepaid, and pricing it at zero meant estimateCallCents
  // returned 0, noelle_get_spend read $0.00, and the budget cap never saw the
  // 9,374 calls that burned about half a 20x Max week in three days.
  "claude-cli/claude-haiku-4-5": { input_per_mtok_cents: 80, output_per_mtok_cents: 400 },
  "claude-cli/claude-sonnet-4-6": { input_per_mtok_cents: 300, output_per_mtok_cents: 1500 },
  "claude-cli/claude-opus-4-6": { input_per_mtok_cents: 1500, output_per_mtok_cents: 7500 },
  // Local Codex CLI on a ChatGPT subscription — quota-equivalent prices, same
  // reasoning as the claude-cli rows above: prepaid is not free, and a cap that
  // cannot see spend is not a cap. GPT-5 list prices.
  "codex-cli/gpt-5-codex": { input_per_mtok_cents: 125, output_per_mtok_cents: 1000 },
  "codex-cli/gpt-5": { input_per_mtok_cents: 125, output_per_mtok_cents: 1000 },
  // OpenAI direct (gpt-5 family). List prices in cents per million tokens;
  // adjust here when OpenAI changes pricing. Operators on a self-host box can
  // override per-model via NOELLE_OPENAI_MODEL_* in the backend.
  "openai/gpt-5": { input_per_mtok_cents: 125, output_per_mtok_cents: 1000 },
  "openai/gpt-5-mini": { input_per_mtok_cents: 25, output_per_mtok_cents: 200 },
};

export function getPrice(engine: EngineKey, model: string): Price | null {
  return KNOWN_PRICES[`${engine}/${model}`] ?? null;
}

export type EstimateArgs = {
  engine: EngineKey;
  model: string;
  inputTokens: number;
  outputTokens: number;
};

/**
 * Convert input/output token counts into whole cents. We round UP (`Math.ceil`)
 * so a thousand calls that each "cost" 0.4 cents do not vanish from the
 * dashboard — over-counting by <1¢ per call is fine; under-counting is not.
 */
export function estimateCallCents(args: EstimateArgs): number {
  const price = getPrice(args.engine, args.model);
  if (!price) {
    throw new Error(
      `unknown price for ${args.engine}/${args.model}; add it to KNOWN_PRICES`,
    );
  }
  const inputCents =
    (args.inputTokens * price.input_per_mtok_cents) / 1_000_000;
  const outputCents =
    (args.outputTokens * price.output_per_mtok_cents) / 1_000_000;
  const total = inputCents + outputCents;
  if (total <= 0) return 0;
  return Math.max(1, Math.ceil(total));
}
