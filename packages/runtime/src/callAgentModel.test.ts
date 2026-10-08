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
    expect(sonnetBackend.call).not.toHaveBeenCalled();
  });

  it("unlimitedBudget passes all cap layers", async () => {
    const routing: ModelRouting = { primary: claude };
    const res = await callAgentModel(
      { ...baseArgs, routing },
      deps({ claude: stubBackend("claude-text") }),
    );
    expect(res.text).toBe("claude-text");
  });

  it("throws EngineNotImplementedError when chosen engine has no backend", async () => {
    const routing: ModelRouting = { primary: claude };
    await expect(
      callAgentModel({ ...baseArgs, routing }, deps({})),
    ).rejects.toBeInstanceOf(EngineNotImplementedError);
  });

  describe("spend recording", () => {
    function recorderSpy() {
      const calls: import("./spendRecorder.js").SpendRow[] = [];
      const recorder: import("./spendRecorder.js").SpendRecorder = {
        record: vi.fn(async (row) => {
          calls.push(row);
        }),
      };
      return { recorder, calls };
    }

    it("records a row with status='ok' when the engine succeeds", async () => {
      const { recorder, calls } = recorderSpy();
      const routing: ModelRouting = { primary: sonnet };
      await callAgentModel(
        { ...baseArgs, routing },
        {
          engines: { vertex: stubBackend("ok-text") },
          budget: unlimitedBudget,
          recorder,
        },
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        orgId: "org_1",
        instanceId: "inst_1",
        worker: "test",
        engine: "vertex",
        model: "claude-sonnet-4-6",
        bucket: "drafter",
        inputTokens: 10,
        outputTokens: 20,
        status: "ok",
      });
      expect(calls[0]!.cents).toBeGreaterThan(0);
      expect(calls[0]!.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("records a row with status='error' when the engine throws and there is no fallback", async () => {
      const { recorder, calls } = recorderSpy();
      const routing: ModelRouting = { primary: sonnet };
      await expect(
        callAgentModel(
          { ...baseArgs, routing },
          {
            engines: { vertex: failingBackend(new Error("vertex 500")) },
            budget: unlimitedBudget,
            recorder,
          },
        ),
      ).rejects.toThrow("vertex 500");
      expect(calls).toHaveLength(1);
      // A failed call is not a free call: the prompt went out and (on a
      // timeout) generation was killed mid-flight. Input is estimated from the
      // prompt so the budget cap can see it; output stays 0 because nothing
      // usable came back. This used to record zeros, which is how 54
      // pattern-breaker timeouts stayed invisible to the cap.
      expect(calls[0]).toMatchObject({
        engine: "vertex",
        model: "claude-sonnet-4-6",
        status: "error",
        outputTokens: 0,
      });
      expect(calls[0]!.inputTokens).toBeGreaterThan(0);
      expect(calls[0]!.cents).toBeGreaterThan(0);
    });

    it("records two rows when primary fails and fallback succeeds", async () => {
      const { recorder, calls } = recorderSpy();
      const routing: ModelRouting = { primary: claude, fallback: sonnet };
      const res = await callAgentModel(
        { ...baseArgs, routing },
        {
          engines: {
            claude: failingBackend(new Error("claude 500")),
            vertex: stubBackend("sonnet-text"),
          },
          budget: unlimitedBudget,
          recorder,
        },
      );
      expect(res.engineUsed).toEqual(sonnet);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({ engine: "claude", status: "error" });
      expect(calls[1]).toMatchObject({ engine: "vertex", status: "ok" });
    });

    it("records a row with status='budget_exceeded' when the cap pre-check fails", async () => {
      const { recorder, calls } = recorderSpy();
      const routing: ModelRouting = { primary: sonnet };
      const tightDeps = {
        engines: { vertex: stubBackend("never-called") },
        budget: {
          estimateCents: () => 100,
          adapters: {
            fetchSpend: vi.fn(async () => ({ bucket: 9999, org: 0, instance: 0 })),
            fetchCaps: vi.fn(async () => ({
              bucket: 10000,
              org: 999999,
              instance: 999999,
            })),
          },
        },
        recorder,
      };
      await expect(callAgentModel({ ...baseArgs, routing }, tightDeps)).rejects.toBeInstanceOf(
        BudgetExceededError,
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        engine: "vertex",
        status: "budget_exceeded",
        cents: 0,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: null,
      });
    });

    it("uses the price table when estimateCents is not provided", async () => {
      // No explicit estimateCents — the default reads from llmPrices.
      const adapters = {
        fetchSpend: vi.fn(async () => ({ bucket: 0, org: 0, instance: 0 })),
        fetchCaps: vi.fn(async () => ({
          bucket: Number.MAX_SAFE_INTEGER,
          org: Number.MAX_SAFE_INTEGER,
          instance: Number.MAX_SAFE_INTEGER,
        })),
      };
      const { recorder, calls } = recorderSpy();
      const routing: ModelRouting = { primary: sonnet };
      await callAgentModel(
        { ...baseArgs, routing },
        {
          engines: { vertex: stubBackend("ok-text") },
          // Critically: no `estimateCents` override.
          budget: { adapters },
          recorder,
        },
      );
      expect(calls).toHaveLength(1);
      // sonnet at 10 input / 20 output tokens = effectively ~0 cents
      // → ceils to 1. The point of this test is that *something*
      // happens with no manual estimator, i.e. the default path runs.
      expect(calls[0]!.cents).toBeGreaterThanOrEqual(1);
    });
  });
});

describe("NOELLE_CLAUDE_CLI rewrite (VM cost switch)", () => {
  const bedrock: EngineHandle = { engine: "bedrock", model: "claude-sonnet-4-6" };
  const bedrockFallback: EngineHandle = { engine: "bedrock", model: "claude-opus-4-6" };

  afterEach(() => {
    delete process.env.NOELLE_CLAUDE_CLI;
  });

  it("routes a bedrock primary through claude-cli when the flag is on", async () => {
    process.env.NOELLE_CLAUDE_CLI = "1";
    const cli = stubBackend("cli-text");
    const bed = stubBackend("bedrock-text");
    const res = await callAgentModel(
      { ...baseArgs, routing: { primary: bedrock } },
      deps({ "claude-cli": cli, bedrock: bed }),
    );
    expect(res.engineUsed).toEqual({ engine: "claude-cli", model: "claude-sonnet-4-6" });
    expect(res.text).toBe("cli-text");
    expect(cli.call).toHaveBeenCalledOnce();
    expect(bed.call).not.toHaveBeenCalled();
  });

  it("rewrites the bedrock fallback to claude-cli too, so a cli failure never bills AWS", async () => {
    process.env.NOELLE_CLAUDE_CLI = "1";
    // Primary claude-cli call fails once; the fallback must be a claude-cli
    // retry (NOT paid Bedrock). Second cli call succeeds.
    let calls = 0;
    const cli: EngineBackend = {
      call: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error("claude cli timed out after 1ms");
        return { text: "cli-fallback", usage: { input_tokens: 1, output_tokens: 1 } };
