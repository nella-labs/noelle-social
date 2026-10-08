import { describe, it, expect } from "vitest";
import { estimateCallCents, getPrice, KNOWN_PRICES } from "./llmPrices.js";

describe("KNOWN_PRICES", () => {
  it("covers every engine/model pair callAgentModel might dispatch", () => {
    // If the engine matrix changes, this test fails first.
    expect(KNOWN_PRICES["bedrock/claude-haiku-4-5"]).toEqual({
      input_per_mtok_cents: 110,
      output_per_mtok_cents: 550,
    });
    expect(KNOWN_PRICES["bedrock/claude-sonnet-4-6"]).toEqual({
      input_per_mtok_cents: 330,
      output_per_mtok_cents: 1650,
    });
    expect(KNOWN_PRICES["bedrock/claude-opus-4-6"]).toEqual({
      input_per_mtok_cents: 550,
      output_per_mtok_cents: 2750,
    });
    expect(KNOWN_PRICES["vertex/claude-sonnet-4-6"]).toEqual({
      input_per_mtok_cents: 300,
      output_per_mtok_cents: 1500,
    });
    expect(KNOWN_PRICES["vertex/gemini-2-flash"]).toEqual({
      input_per_mtok_cents: 15,
      output_per_mtok_cents: 60,
    });
  });
});

describe("getPrice", () => {
  it("returns the price for a known engine/model", () => {
    expect(getPrice("bedrock", "claude-sonnet-4-6")).toEqual({
      input_per_mtok_cents: 330,
      output_per_mtok_cents: 1650,
    });
  });

  it("returns null for an unknown engine/model", () => {
    expect(getPrice("bedrock", "claude-haiku-9-9")).toBeNull();
  });
});

describe("estimateCallCents", () => {
  it("estimates a sonnet call from token counts", () => {
    // 1000 input tokens × 330/MTok = 0.33¢ → rounds to 1¢ (Math.ceil).
    // 500 output tokens × 1650/MTok = 0.825¢ → rounds to 1¢.
    // Sum = 2¢.
    const cents = estimateCallCents({
      engine: "bedrock",
      model: "claude-sonnet-4-6",
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(cents).toBe(2);
  });

  it("estimates a 1M-token sonnet input + 256k output (a realistic worst-case)", () => {
    // 1_000_000 × 330/MTok = 330¢. 256_000 × 1650/MTok = 422.4¢. Sum rounds to 753¢.
    const cents = estimateCallCents({
      engine: "bedrock",
      model: "claude-sonnet-4-6",
      inputTokens: 1_000_000,
      outputTokens: 256_000,
    });
    expect(cents).toBe(753);
  });

  it("returns 0 when both token counts are 0", () => {
    expect(
      estimateCallCents({
        engine: "bedrock",
        model: "claude-sonnet-4-6",
        inputTokens: 0,
        outputTokens: 0,
      }),
    ).toBe(0);
  });

  it("uses 1 cent floor when total is between 0 and 1 cents", () => {
    // 1 input token, 1 output token of sonnet = ~0.0018¢ → ceils to 1.
    expect(
      estimateCallCents({
        engine: "bedrock",
        model: "claude-sonnet-4-6",
        inputTokens: 1,
        outputTokens: 1,
      }),
    ).toBe(1);
  });

  it("throws on unknown engine/model so a routing typo can't bypass billing", () => {
    expect(() =>
      estimateCallCents({
        engine: "bedrock",
        model: "claude-haiku-9-9",
        inputTokens: 100,
        outputTokens: 100,
      }),
    ).toThrow(/unknown price.*bedrock\/claude-haiku-9-9/);
  });
});

describe("claude-cli (local subscription) pricing", () => {
  it("carries quota-equivalent prices, not zero", () => {
    // A subscription call is prepaid, not free. Pricing these rows at 0/0 made
    // estimateCallCents return 0, noelle_get_spend read $0.00, and the budget
    // cap never see the calls that burned about half a 20x Max week in 3 days.
    // The values mirror the paid `claude/*` rows: the same tokens, the same
    // list price, which is the basis the CLI's own total_cost_usd uses.
    for (const tier of ["haiku-4-5", "sonnet-4-6", "opus-4-6"] as const) {
      expect(KNOWN_PRICES[`claude-cli/claude-${tier}`]).toEqual(
        KNOWN_PRICES[`claude/claude-${tier}`],
      );
    }
  });

  it("estimateCallCents scales with token count so the cap pre-flight is meaningful", () => {
    const small = estimateCallCents({
      engine: "claude-cli",
      model: "claude-opus-4-6",
      inputTokens: 1_000,
      outputTokens: 500,
    });
    const large = estimateCallCents({
      engine: "claude-cli",
      model: "claude-opus-4-6",
      inputTokens: 50_000,
      outputTokens: 20_000,
    });
    expect(small).toBeGreaterThan(0);
    expect(large).toBeGreaterThan(small);
  });
});
