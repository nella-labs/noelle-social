import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bucketTimeoutMs,
  callAgentModel,
  EngineNotImplementedError,
  unlimitedBudget,
  type CallAgentModelDeps,
  type EngineBackend,
} from "./callAgentModel.js";
import { BudgetExceededError } from "./budgetBucket.js";
import { ClaudeCliAuthError } from "./claudeCliBackend.js";
import { noopSpendRecorder } from "./spendRecorder.js";
import type { EngineHandle, ModelRouting } from "./types.js";

// Pinned to engine handles that survive the codex removal: `claude` (direct
// Anthropic) as the synthetic primary, `vertex` sonnet as the fallback,
// `bedrock` opus as the escalation target. Distinct engine keys so the
// registry mocks don't collide.
const claude: EngineHandle = { engine: "claude", model: "claude-opus-4-6" };
const sonnet: EngineHandle = { engine: "vertex", model: "claude-sonnet-4-6" };
const opus: EngineHandle = { engine: "bedrock", model: "claude-opus-4-6" };

function stubBackend(text: string): EngineBackend {
  return {
    call: vi.fn(async () => ({ text, usage: { input_tokens: 10, output_tokens: 20 } })),
  };
}

function failingBackend(err: Error): EngineBackend {
  return { call: vi.fn(async () => { throw err; }) };
}

function deps(engines: CallAgentModelDeps["engines"]): CallAgentModelDeps {
  return { engines, budget: unlimitedBudget, recorder: noopSpendRecorder };
}

const baseArgs = {
  bucket: "drafter",
  orgId: "org_1",
  instanceId: "inst_1",
  worker: "test",
  agentRole: "x_intern" as const,
  system: "you are an x intern",
  prompt: "draft a reply to: foo",
};

describe("callAgentModel", () => {
  it("uses primary engine and returns its result", async () => {
    const routing: ModelRouting = { primary: claude };
    const res = await callAgentModel(
      { ...baseArgs, routing },
      deps({ claude: stubBackend("claude-text") }),
    );
    expect(res.text).toBe("claude-text");
    expect(res.engineUsed).toEqual(claude);
    expect(res.outcome).toBe("ok");
  });

  it("falls back when primary throws and fallback is configured", async () => {
    const routing: ModelRouting = { primary: claude, fallback: sonnet };
    const claudeBackend = failingBackend(new Error("claude 500"));
    const sonnetBackend = stubBackend("sonnet-text");
    const res = await callAgentModel(
      { ...baseArgs, routing },
      deps({ claude: claudeBackend, vertex: sonnetBackend }),
    );
    expect(res.text).toBe("sonnet-text");
    expect(res.engineUsed).toEqual(sonnet);
    expect(res.outcome).toBe("fallback");
    expect(claudeBackend.call).toHaveBeenCalledOnce();
    expect(sonnetBackend.call).toHaveBeenCalledOnce();
  });

  it("propagates error when no fallback configured", async () => {
    const routing: ModelRouting = { primary: claude };
    await expect(
      callAgentModel(
        { ...baseArgs, routing },
        deps({ claude: failingBackend(new Error("claude 500")) }),
      ),
    ).rejects.toThrow("claude 500");
  });

  it("propagates fallback error when both fail", async () => {
    const routing: ModelRouting = { primary: claude, fallback: sonnet };
    await expect(
      callAgentModel(
        { ...baseArgs, routing },
        deps({
          claude: failingBackend(new Error("claude 500")),
          vertex: failingBackend(new Error("sonnet 503")),
        }),
      ),
    ).rejects.toThrow("sonnet 503");
  });

  it("uses escalation engine when predicate returns true", async () => {
    const routing: ModelRouting = {
      primary: claude,
      fallback: sonnet,
      escalation: { engine: opus, when: () => true },
    };
    const claudeBackend = stubBackend("claude-text");
    const opusBackend = stubBackend("opus-text");
    const res = await callAgentModel(
      { ...baseArgs, routing },
      deps({ claude: claudeBackend, bedrock: opusBackend, vertex: stubBackend("sonnet") }),
    );
    expect(res.text).toBe("opus-text");
    expect(res.engineUsed).toEqual(opus);
    expect(claudeBackend.call).not.toHaveBeenCalled();
    expect(opusBackend.call).toHaveBeenCalledOnce();
  });

  it("uses primary when escalation predicate returns false", async () => {
    const routing: ModelRouting = {
      primary: claude,
      escalation: { engine: opus, when: () => false },
    };
    const res = await callAgentModel(
      { ...baseArgs, routing },
      deps({ claude: stubBackend("claude-text"), bedrock: stubBackend("opus-text") }),
    );
    expect(res.engineUsed).toEqual(claude);
  });

  it("forwards payload to escalation predicate", async () => {
    const routing: ModelRouting = {
      primary: claude,
      escalation: {
        engine: opus,
        when: (ctx) => {
          const p = ctx.payload as { score?: number };
          return (p.score ?? 0) >= 80;
        },
      },
    };
    const engines = { claude: stubBackend("claude-text"), bedrock: stubBackend("opus-text") };

    const hot = await callAgentModel({ ...baseArgs, routing, payload: { score: 99 } }, deps(engines));
    expect(hot.engineUsed).toEqual(opus);

    const cold = await callAgentModel({ ...baseArgs, routing, payload: { score: 50 } }, deps(engines));
    expect(cold.engineUsed).toEqual(claude);
  });

  it("runs pre-flight cap check and throws BudgetExceededError before any engine call", async () => {
    const routing: ModelRouting = { primary: claude, fallback: sonnet };
    const claudeBackend = stubBackend("claude-text");
    const sonnetBackend = stubBackend("sonnet-text");
    const tightDeps: CallAgentModelDeps = {
      engines: { claude: claudeBackend, vertex: sonnetBackend },
      budget: {
        estimateCents: () => 100,
        adapters: {
          fetchSpend: vi.fn(async () => ({ bucket: 9999, org: 0, instance: 0 })),
          fetchCaps: vi.fn(async () => ({ bucket: 10000, org: 999999, instance: 999999 })),
        },
      },
    };
    await expect(callAgentModel({ ...baseArgs, routing }, tightDeps)).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    expect(claudeBackend.call).not.toHaveBeenCalled();
    expect(sonnetBackend.call).not.toHaveBeenCalled();
  });

  it("trips on org cap even when bucket cap has room", async () => {
    const routing: ModelRouting = { primary: claude };
    const tightDeps: CallAgentModelDeps = {
      engines: { claude: stubBackend("claude") },
      budget: {
        estimateCents: () => 100,
        adapters: {
          fetchSpend: vi.fn(async () => ({ bucket: 0, org: 9999, instance: 0 })),
          fetchCaps: vi.fn(async () => ({ bucket: 999999, org: 10000, instance: 999999 })),
        },
      },
    };
    const err = await callAgentModel({ ...baseArgs, routing }, tightDeps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as BudgetExceededError).layer).toBe("org");
  });

  it("does not fall back to a different engine when primary trips BudgetExceededError", async () => {
    const routing: ModelRouting = { primary: claude, fallback: sonnet };
    const sonnetBackend = stubBackend("sonnet-text");
    const tightDeps: CallAgentModelDeps = {
      engines: { claude: stubBackend("claude"), vertex: sonnetBackend },
      budget: {
        estimateCents: () => 100,
        adapters: {
          fetchSpend: vi.fn(async () => ({ bucket: 9999, org: 0, instance: 0 })),
          fetchCaps: vi.fn(async () => ({ bucket: 10000, org: 999999, instance: 999999 })),
        },
      },
    };
    await expect(callAgentModel({ ...baseArgs, routing }, tightDeps)).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
