import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { BudgetExceededError, CLAUDE_CLI_MODEL } from "@noelle/runtime";
import type { Sql } from "postgres";
import { createTextJsonFn } from "./text-backend.js";
import type { Env } from "../env.js";

const state = vi.hoisted(() => ({ call: vi.fn(), admit: vi.fn(), record: vi.fn(), construct: vi.fn() }));
vi.mock("@noelle/runtime", async original => ({ ...await original<Record<string, unknown>>(),
  createClaudeCliBackend: () => { state.construct(); return { call: state.call }; },
  createBedrockBackend: () => { state.construct(); return { call: state.call }; },
}));
vi.mock("@noelle/runtime/pg-budget-adapters", async original => ({ ...await original<Record<string, unknown>>(),
  createPgBudgetAdapters: () => ({ reserveAttempt: state.admit }),
}));
vi.mock("@noelle/runtime/pg-spend-recorder", () => ({ createPgSpendRecorder: () => ({ record: state.record }) }));
const resources = { sql: {} as Sql, worker: "briefer" };
beforeEach(() => {
  state.call.mockReset().mockResolvedValue({ text: '{"saved":true}', usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0 } });
  state.admit.mockReset().mockImplementation(async args => ({ attemptId: args.instanceId }));
  state.record.mockReset().mockResolvedValue(undefined); state.construct.mockReset();
  vi.stubEnv("AWS_ACCESS_KEY_ID", "inert"); vi.stubEnv("AWS_SECRET_ACCESS_KEY", "inert");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// Only the fields createTextJsonFn actually reads. The full Env is a large Zod
// infer; building it here would couple this test to unrelated schema churn.
function env(over: Partial<Env> = {}): Env {
  return { NOELLE_VIDEO_TEXT_MODEL: "claude-sonnet-4-6", ...over } as Env;
}

describe("createTextJsonFn", () => {
  // Regression guard for the drift this seam already had once: the stamp used
  // to re-derive `NOELLE_CLAUDE_CLI_MODEL ?? "<literal>"` independently of the
  // backend, so a model bump in claudeCliBackend left Nova stamping the old
  // one. Assert the stamp IS the backend's constant, not a copy of it.
  it("stamps the claude-cli backend's own model constant", () => {
    const caller = createTextJsonFn(env({ NOELLE_CLAUDE_CLI: "1" }), resources);
    expect(caller.engine).toBe("claude");
    expect(caller.model).toBe(CLAUDE_CLI_MODEL);
  });

  it("does not route to claude-cli when the flag is unset", () => {
    expect(createTextJsonFn(env(), resources).engine).not.toBe("claude");
  });
  it("binds exact instance and worker attribution without rebuilding its provider resource", async () => {
    const factory = createTextJsonFn(env(), resources);
    await factory.forInstance({ id: "a", org_id: "org-a" })("system-a", "prompt-a");
    await factory.forInstance({ id: "b", org_id: "org-b" })("system-b", "prompt-b");
    expect(state.construct).toHaveBeenCalledOnce();
    expect(state.admit.mock.calls.map(([args]) => [args.orgId, args.instanceId, args.worker, args.engine])).toEqual([
      ["org-a", "a", "briefer", "bedrock"], ["org-b", "b", "briefer", "bedrock"],
    ]);
    expect(state.record.mock.calls.map(([row]) => [row.instanceId, row.attemptId, row.costBasis, row.cents])).toEqual([
      ["a", "a", "provider_reported", 0], ["b", "b", "provider_reported", 0],
    ]);
  });
  it("propagates denied admission before its raw provider", async () => {
    state.admit.mockRejectedValue(new BudgetExceededError({ layer: "instance", spent_cents: 0, cap_cents: 0, estimated_cents: 1 }));
    await expect(createTextJsonFn(env(), resources).forInstance({ id: "a", org_id: "org-a" })("system", "prompt"))
      .rejects.toBeInstanceOf(BudgetExceededError);
    expect(state.call).not.toHaveBeenCalled(); expect(state.record).toHaveBeenCalledOnce();
    expect(state.record.mock.calls[0]?.[0]).toMatchObject({ status: "budget_exceeded", worker: "briefer", instanceId: "a" });
  });
  it("keeps configured Claude provenance while accounting under the actual CLI engine", async () => {
    const factory = createTextJsonFn(env({ NOELLE_CLAUDE_CLI: "1" }), resources);
    expect(factory.engine).toBe("claude");
    await factory.forInstance({ id: "a", org_id: "org-a" })("system", "prompt");
    expect(state.record.mock.calls[0]?.[0]).toMatchObject({ engine: "claude-cli", model: CLAUDE_CLI_MODEL });
  });
  it("keeps overlapping cached-provider calls bound to their captured instance", async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    state.call.mockImplementation(async args => {
      if (args.prompt === "a") await blocked;
      return { text: '{"saved":true}', usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0 } };
    });
    const factory = createTextJsonFn(env(), resources);
    const identity = { id: "a", org_id: "org-a" }; const a = factory.forInstance(identity);
    identity.id = "changed"; identity.org_id = "changed";
    const pending = a("system", "a");
    try { expect(await factory.forInstance({ id: "b", org_id: "org-b" })("system", "b")).toEqual({ saved: true }); }
    finally { release(); await pending; }
    expect(state.construct).toHaveBeenCalledOnce();
    expect(state.record.mock.calls.map(([row]) => [row.instanceId, row.orgId, row.attemptId])).toEqual([
      ["b", "org-b", "b"], ["a", "org-a", "a"],
    ]);
  });
  it("meters its actual Gemini factory before malformed generated JSON is discarded", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", ""); vi.stubEnv("AWS_SECRET_ACCESS_KEY", "");
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "malformed JSON" }] } }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 },
    })));
    vi.stubGlobal("fetch", fetchImpl);
    const factory = createTextJsonFn(env({ NOELLE_GEMINI_API_KEY: "inert" }), resources);
    expect(factory.model).toBe("gemini-2.5-flash");
    expect(await factory.forInstance({ id: "a", org_id: "org-a" })("system", "prompt")).toBeNull();
    expect(fetchImpl).toHaveBeenCalledOnce(); expect(state.record).toHaveBeenCalledOnce();
    expect(state.record.mock.calls[0]?.[0]).toMatchObject({ engine: "vertex", model: "gemini-2-5-flash",
      worker: "briefer", instanceId: "a", inputTokens: 2, outputTokens: 1, costBasis: "token_estimate", status: "ok" });
  });
  it("keeps an ordinary provider failure local and records one failed attempt without replay", async () => {
    state.call.mockRejectedValue(new Error("inert provider failure"));
    const json = createTextJsonFn(env(), resources).forInstance({ id: "a", org_id: "org-a" });
    expect(await json("system", "prompt")).toBeNull();
    expect(state.call).toHaveBeenCalledOnce(); expect(state.record).toHaveBeenCalledOnce();
    expect(state.record.mock.calls[0]?.[0]).toMatchObject({ status: "error", costBasis: "failure_estimate", attemptId: "a" });
  });
});
