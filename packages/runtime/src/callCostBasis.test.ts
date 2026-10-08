import { describe, expect, it } from "vitest";
import { callAgentModel, unlimitedBudget, type EngineBackend } from "./callAgentModel.js";
import { BudgetExceededError } from "./budgetBucket.js";
import type { SpendRow } from "./spendRecorder.js";

const args = {
  orgId: "org", instanceId: "instance", agentRole: "x_intern" as const,
  worker: "drafter", bucket: "drafter", system: "system", prompt: "prompt", directRouting: true,
  routing: { primary: { engine: "bedrock" as const, model: "claude-sonnet-4-6" as const } },
};

async function recordSuccess(usage: unknown, model = args.routing.primary.model as string) {
  const rows: SpendRow[] = [];
  const response = { text: "reply", usage };
  const backend = { call: async () => response } as EngineBackend;
  const result = await callAgentModel({ ...args,
    routing: { primary: { engine: "bedrock", model } } as typeof args.routing }, {
    engines: { bedrock: backend },
    budget: { ...unlimitedBudget, adapters: { ...unlimitedBudget.adapters,
      reserveAttempt: async () => ({ attemptId: "attempt" }) } },
    recorder: { record: async (row) => { rows.push(row); } },
  });
  expect(rows).toHaveLength(1);
  return { result, row: rows[0]! };
}

describe("call accounting cost basis", () => {
  it("keeps absent provider token metadata unknown after normalization and another routed call", async () => {
    const first = await recordSuccess({ input_tokens: 0, output_tokens: 0, token_usage_reported: false });
    expect(first.row.costBasis).toBe("unknown");
    expect(first.result.usage).toMatchObject({ token_usage_reported: false });
    const second = await recordSuccess(first.result.usage);
    expect(second.row.costBasis).toBe("unknown");
  });

  it("still trusts a provider-reported zero with absent token metadata", async () => {
    const { row } = await recordSuccess({ input_tokens: 0, output_tokens: 0,
      token_usage_reported: false, cost_usd: 0 });
    expect(row).toMatchObject({ cents: 0, costBasis: "provider_reported" });
  });

  it("preserves a provider-reported finite zero despite nonzero token counts", async () => {
    const { row } = await recordSuccess({ input_tokens: 1_000_000, output_tokens: 1_000_000, cost_usd: 0 });
    expect(row).toMatchObject({ status: "ok", cents: 0, costBasis: "provider_reported", attemptId: "attempt" });
  });
  it("records a positive provider amount with whole-cent rounding", async () => {
    const { row } = await recordSuccess({ input_tokens: 1, output_tokens: 1, cost_usd: 0.0001 });
    expect(row).toMatchObject({ cents: 1, costBasis: "provider_reported" });
  });
  it("uses validated usage and the known price table when no provider amount exists", async () => {
    const { row } = await recordSuccess({ input_tokens: 1000, output_tokens: 2000 });
    expect(row).toMatchObject({ status: "ok", cents: 4, costBasis: "token_estimate" });
  });
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("does not trust an invalid provider amount %s", async (cost_usd) => {
    const { row } = await recordSuccess({ input_tokens: 1000, output_tokens: 2000, cost_usd });
    expect(row).toMatchObject({ cents: 4, costBasis: "token_estimate" });
  });
  it.each([undefined, {}, { input_tokens: -1, output_tokens: 2 },
    { input_tokens: Number.NaN, output_tokens: 2 }, { input_tokens: 1, output_tokens: Infinity },
    { input_tokens: 0.5, output_tokens: 2 }, { input_tokens: "1", output_tokens: 2 },
    { input_tokens: 2_147_483_648, output_tokens: 2 },
  ])("marks missing or invalid usage unknown without losing the successful response: %j", async (usage) => {
    const { result, row } = await recordSuccess(usage);
    expect(result.text).toBe("reply");
    expect(row).toMatchObject({ status: "ok", cents: 0, costBasis: "unknown", attemptId: "attempt" });
    expect(Number.isInteger(row.inputTokens) && row.inputTokens >= 0 && row.inputTokens <= 2_147_483_647).toBe(true);
    expect(Number.isInteger(row.outputTokens) && row.outputTokens >= 0 && row.outputTokens <= 2_147_483_647).toBe(true);
  });
  it("does not fabricate a known token charge when the model price is unavailable", async () => {
    const { row } = await recordSuccess({ input_tokens: 1000, output_tokens: 2000 }, "unknown-model");
    expect(row).toMatchObject({ cents: 0, costBasis: "unknown", status: "ok" });
  });
  it("still accepts a valid provider amount when token counts are absent", async () => {
    const { row } = await recordSuccess({ cost_usd: 0.08 });
    expect(row).toMatchObject({ cents: 8, costBasis: "provider_reported", inputTokens: 0, outputTokens: 0 });
  });
  it("labels a dispatched failure as an estimate rather than a successful charge", async () => {
    const rows: SpendRow[] = [];
    const error = new Error("transport lost");
    await expect(callAgentModel(args, { engines: { bedrock: { call: async () => { throw error; } } },
      budget: unlimitedBudget, recorder: { record: async (row) => { rows.push(row); } },
    })).rejects.toBe(error);
    expect(rows).toEqual([expect.objectContaining({ status: "error", cents: 1, costBasis: "failure_estimate" })]);
  });
  it("labels a rejected admission as not dispatched", async () => {
    const rows: SpendRow[] = [];
    const error = new BudgetExceededError({ layer: "instance", spent_cents: 10, cap_cents: 10, estimated_cents: 1 });
    await expect(callAgentModel(args, { engines: { bedrock: { call: async () => { throw new Error("must not dispatch"); } } },
      budget: { ...unlimitedBudget, adapters: { ...unlimitedBudget.adapters,
        reserveAttempt: async () => { throw error; } } },
      recorder: { record: async (row) => { rows.push(row); } },
    })).rejects.toBe(error);
    expect(rows).toEqual([expect.objectContaining({ status: "budget_exceeded", cents: 0, costBasis: "not_dispatched" })]);
  });
});
