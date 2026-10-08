import { describe, expect, it, vi } from "vitest";
import { callAgentModel, createBudgetedBackend, ModelNotDispatchedError, unlimitedBudget, type EngineBackend } from "./callAgentModel.js";
import { BudgetExceededError, type CapAdapters } from "./budgetBucket.js";
import { PgOperationError } from "./boundedPgSession.js";
import type { SpendRow } from "./spendRecorder.js";

const args = {
  orgId: "org", instanceId: "instance", agentRole: "x_intern" as const,
  worker: "drafter", bucket: "drafter", system: "system", prompt: "prompt", directRouting: true,
  routing: { primary: { engine: "bedrock" as const, model: "claude-sonnet-4-6" as const } },
};
const result = { text: "reply", usage: { input_tokens: 10, output_tokens: 20, cost_usd: 0.08 } };

describe("per-attempt budget admission", () => {
  function setup() {
    const rows: SpendRow[] = [];
    const reserveAttempt = vi.fn(async () => ({ attemptId: "attempt" }));
    const adapters = { ...unlimitedBudget.adapters, reserveAttempt } as CapAdapters;
    const call = vi.fn(async () => result);
    return { rows, reserveAttempt, call, deps: {
      engines: { bedrock: { call } as EngineBackend }, budget: { adapters, estimateCents: () => 8 },
      recorder: { record: async (row: SpendRow) => { rows.push(row); } },
    } };
  }
  it("admits immediately before dispatch and attaches its identity to the exact receipt", async () => {
    const s = setup();
    s.call.mockImplementation(async () => {
      expect(s.reserveAttempt).toHaveBeenCalledOnce();
      expect(s.rows).toHaveLength(0);
      return result;
    });
    await callAgentModel(args, s.deps);
    expect(s.reserveAttempt).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "org", instanceId: "instance", bucket: "drafter", engine: "bedrock", estimatedCents: 8,
    }));
    expect(s.rows).toEqual([expect.objectContaining({ attemptId: "attempt", status: "ok", cents: 8 })]);
  });
  it("blocks before dispatch on rejected admission without creating a reservation receipt", async () => {
    const s = setup();
    s.reserveAttempt.mockRejectedValue(new BudgetExceededError({ layer: "instance", spent_cents: 8, cap_cents: 10, estimated_cents: 8 }));
    await expect(callAgentModel(args, s.deps)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(s.call).not.toHaveBeenCalled();
    expect(s.rows).toEqual([expect.objectContaining({ status: "budget_exceeded", cents: 0 })]);
    expect(s.rows[0]).not.toHaveProperty("attemptId");
  });
  it("uses a distinct admission and receipt for a fallback after a dispatched failure", async () => {
    const s = setup();
    s.reserveAttempt.mockResolvedValueOnce({ attemptId: "primary" }).mockResolvedValueOnce({ attemptId: "fallback" });
    s.call.mockRejectedValue(new Error("transport lost"));
    await callAgentModel({ ...args, routing: { ...args.routing, fallback: { engine: "vertex", model: "gemini-2-5-flash" } } }, {
      ...s.deps, engines: { ...s.deps.engines, vertex: { call: async () => result } },
    });
    expect(s.reserveAttempt).toHaveBeenCalledTimes(2);
    expect(s.rows.map((row) => [row.attemptId, row.status])).toEqual([["primary", "error"], ["fallback", "ok"]]);
  });
  it("still admits the separate Codex pot even when common preflight is exempt", async () => {
    const s = setup();
    await callAgentModel({ ...args, codexSubscriptionOnly: true }, { ...s.deps, engines: { "codex-cli": { call: async () => result } } });
    expect(s.reserveAttempt).toHaveBeenCalledWith(expect.objectContaining({ engine: "codex-cli", engineCapCents: 50_000 }));
    expect(s.rows[0]?.attemptId).toBe("attempt");
  });
  it("preserves direct backend arguments and records exactly one admitted call", async () => {
    const s = setup();
    const backend = createBudgetedBackend({ call: s.call }, {
      engine: "bedrock", context: args, budget: s.deps.budget, recorder: s.deps.recorder,
    });
    const request = { model: args.routing.primary.model, system: "direct system", prompt: "direct prompt",
      history: [{ role: "user" as const, content: "earlier" }], timeoutMs: 1234, cacheSystem: false };
    const copy = structuredClone(request);
    expect(await backend.call(request)).toEqual(result);
    expect(s.call).toHaveBeenCalledWith(copy);
    expect(request).toEqual(copy);
    expect(s.rows).toHaveLength(1);
  });
  it("uses bounded admission instead of an unbounded preliminary Codex snapshot", async () => {
    const s = setup();
    const fetchEngineSpend = vi.fn(async () => new Promise<number>(() => {}));
    await callAgentModel({ ...args, codexSubscriptionOnly: true }, {
      ...s.deps, engines: { "codex-cli": { call: async () => result } },
      budget: { ...s.deps.budget, adapters: { ...s.deps.budget.adapters, fetchEngineSpend } },
    });
    expect(fetchEngineSpend).not.toHaveBeenCalled();
    expect(s.reserveAttempt).toHaveBeenCalledOnce();
  });
  it("does not treat an admission database failure as a provider failure eligible for fallback", async () => {
    const s = setup(); const error = new PgOperationError("deadline");
    s.reserveAttempt.mockRejectedValueOnce(error).mockResolvedValue({ attemptId: "forbidden_fallback" });
    const fallback = vi.fn(async () => result);
    await expect(callAgentModel({ ...args, routing: { ...args.routing,
      fallback: { engine: "vertex", model: "gemini-2-5-flash" } } }, {
      ...s.deps, engines: { ...s.deps.engines, vertex: { call: fallback } },
    })).rejects.toBe(error);
    expect(s.reserveAttempt).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
    expect(s.call).not.toHaveBeenCalled();
    expect(s.rows).toHaveLength(0);
  });
  function direct(s: ReturnType<typeof setup>, beforeDispatch: () => Promise<"dispatch" | "not_dispatched">) {
    const options = { engine: "bedrock" as const, context: args, budget: s.deps.budget,
      recorder: s.deps.recorder, beforeDispatch };
    return createBudgetedBackend({ call: s.call }, options);
  }
  it("runs the dispatch acknowledgement after admission and before the provider", async () => {
    const s = setup(); const order: string[] = [];
    s.reserveAttempt.mockImplementation(async () => { order.push("admit"); return { attemptId: "attempt" }; });
    s.call.mockImplementation(async () => { order.push("provider"); return result; });
    const backend = direct(s, async () => { order.push("acknowledge"); return "dispatch"; });
    expect(await backend.call({ system: args.system, prompt: args.prompt, model: args.routing.primary.model })).toEqual(result);
    expect(order).toEqual(["admit", "acknowledge", "provider"]);
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]).toMatchObject({ attemptId: "attempt", status: "ok", cents: 8 });
  });
  it("never acknowledges dispatch when monetary admission rejects", async () => {
    const s = setup(); const beforeDispatch = vi.fn(async () => "dispatch" as const);
    s.reserveAttempt.mockRejectedValue(new BudgetExceededError({ layer: "instance", spent_cents: 8, cap_cents: 10, estimated_cents: 8 }));
    await expect(direct(s, beforeDispatch).call({ system: args.system, prompt: args.prompt, model: args.routing.primary.model }))
      .rejects.toBeInstanceOf(BudgetExceededError);
    expect(beforeDispatch).not.toHaveBeenCalled(); expect(s.call).not.toHaveBeenCalled();
    expect(s.rows).toEqual([expect.objectContaining({ status: "budget_exceeded", costBasis: "not_dispatched" })]);
    expect(s.rows[0]).not.toHaveProperty("attemptId");
  });
  it("records confirmed refusal once with zero accounting and no provider dispatch", async () => {
    const s = setup(); const beforeDispatch = vi.fn(async () => "not_dispatched" as const);
    await expect(direct(s, beforeDispatch).call({ system: args.system, prompt: args.prompt, model: args.routing.primary.model }))
      .rejects.toMatchObject({ name: "ModelNotDispatchedError" });
    expect(beforeDispatch).toHaveBeenCalledOnce(); expect(s.call).not.toHaveBeenCalled();
    expect(s.rows).toEqual([expect.objectContaining({ attemptId: "attempt", status: "error", costBasis: "not_dispatched",
      inputTokens: 0, outputTokens: 0, cents: 0, latencyMs: null, orgId: "org", instanceId: "instance", worker: "drafter" })]);
  });
  it("keeps a thrown acknowledgement unknown and propagates its exact error", async () => {
    const s = setup(); const error = new Error("acknowledgement unavailable");
    await expect(direct(s, async () => { throw error; }).call({ system: args.system, prompt: args.prompt, model: args.routing.primary.model }))
      .rejects.toBe(error);
    expect(s.call).not.toHaveBeenCalled(); expect(s.reserveAttempt).toHaveBeenCalledOnce();
    expect(s.rows).toEqual([expect.objectContaining({ attemptId: "attempt", status: "error", costBasis: "unknown",
      inputTokens: 0, outputTokens: 0, cents: 0, latencyMs: null })]);
  });
  it("does not treat a thrown nominal refusal as a returned acknowledgement", async () => {
    const s = setup(); const error = new ModelNotDispatchedError();
    await expect(direct(s, async () => { throw error; }).call({ system: args.system, prompt: args.prompt, model: args.routing.primary.model }))
      .rejects.toBe(error);
    expect(s.call).not.toHaveBeenCalled();
    expect(s.rows).toEqual([expect.objectContaining({ attemptId: "attempt", status: "error", costBasis: "unknown", cents: 0, latencyMs: null })]);
  });
  it.each([null, undefined, "DISPATCH", {}, false])("keeps an invalid dispatch acknowledgement unknown (%j)", async (decision) => {
    const s = setup();
    const hook = (async () => decision) as () => Promise<"dispatch" | "not_dispatched">;
    await expect(direct(s, hook).call({ system: args.system, prompt: args.prompt, model: args.routing.primary.model })).rejects.toThrow();
    expect(s.call).not.toHaveBeenCalled();
    expect(s.rows).toEqual([expect.objectContaining({ attemptId: "attempt", status: "error", costBasis: "unknown", cents: 0, latencyMs: null })]);
  });
  it("does not retry dispatch or receipt storage after a confirmed refusal receipt fails", async () => {
    const s = setup(); const record = vi.fn(async () => { throw new Error("storage unavailable"); });
    s.deps.recorder.record = record;
    const beforeDispatch = vi.fn(async () => "not_dispatched" as const);
    await expect(direct(s, beforeDispatch).call({ system: args.system, prompt: args.prompt, model: args.routing.primary.model }))
      .rejects.toMatchObject({ name: "ModelNotDispatchedError" });
    expect(record).toHaveBeenCalledOnce(); expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(s.reserveAttempt).toHaveBeenCalledOnce(); expect(s.call).not.toHaveBeenCalled();
  });
});
