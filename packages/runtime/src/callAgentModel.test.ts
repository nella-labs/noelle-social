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
      }),
    };
    const bed = stubBackend("bedrock-fallback");
    const res = await callAgentModel(
      { ...baseArgs, routing: { primary: bedrock, fallback: bedrockFallback } },
      deps({ "claude-cli": cli, bedrock: bed }),
    );
    // Fallback engine is claude-cli (rewritten from the bedrock fallback handle),
    // carrying the fallback handle's model. Bedrock is never invoked.
    expect(res.engineUsed).toEqual({ engine: "claude-cli", model: "claude-opus-4-6" });
    expect(res.text).toBe("cli-fallback");
    expect(res.outcome).toBe("fallback");
    expect(bed.call).not.toHaveBeenCalled();
  });

  it("preserves the bedrock fallback when the flag is off (paid safety net for llm_backend='aws')", async () => {
    // Flag OFF → neither handle is rewritten. A non-bedrock primary throws and
    // the bedrock FALLBACK serves on paid Bedrock — NOT claude-cli — even with a
    // claude-cli backend present. (Flag ON would rewrite the fallback; see above.)
    const directPrimary: EngineHandle = { engine: "claude", model: "claude-sonnet-4-6" };
    const failingPrimary = failingBackend(new Error("primary boom"));
    const bed = stubBackend("bedrock-fallback");
    const cli = stubBackend("cli-should-not-run");
    const res = await callAgentModel(
      { ...baseArgs, routing: { primary: directPrimary, fallback: bedrockFallback } },
      deps({ claude: failingPrimary, bedrock: bed, "claude-cli": cli }),
    );
    expect(res.engineUsed).toEqual(bedrockFallback);
    expect(res.outcome).toBe("fallback");
    expect(cli.call).not.toHaveBeenCalled();
  });

  it("does not rewrite when the flag is off", async () => {
    const bed = stubBackend("bedrock-text");
    const res = await callAgentModel(
      { ...baseArgs, routing: { primary: bedrock } },
      deps({ bedrock: bed }),
    );
    expect(res.engineUsed).toEqual(bedrock);
    expect(res.text).toBe("bedrock-text");
  });

  it("does not rewrite non-bedrock engines even when the flag is on", async () => {
    process.env.NOELLE_CLAUDE_CLI = "1";
    const direct: EngineHandle = { engine: "claude", model: "claude-sonnet-4-6" };
    const res = await callAgentModel(
      { ...baseArgs, routing: { primary: direct } },
      deps({ claude: stubBackend("claude-direct") }),
    );
    expect(res.engineUsed).toEqual(direct);
  });
});

describe("claude-cli is capped like any other engine", () => {
  // An over-cap budget that WOULD throw BudgetExceededError for any paid engine.
  const overCapBudget: CallAgentModelDeps["budget"] = {
    estimateCents: () => 100,
    adapters: {
      fetchSpend: vi.fn(async () => ({ bucket: 9999, org: 0, instance: 0 })),
      fetchCaps: vi.fn(async () => ({ bucket: 10000, org: 999999, instance: 999999 })),
    },
  };

  it("blocks claude-cli when the bucket is over cap", async () => {
    // claude-cli used to skip the pre-flight entirely, on the premise that a
    // flat-rate subscription costs ~$0/call. It draws on a weekly allowance,
    // and the exemption is why 9,374 calls burned about half a 20x Max week
    // without the cap ever seeing them.
    const cli = stubBackend("cli-text");
    const err = await callAgentModel(
      { ...baseArgs, routing: { primary: { engine: "claude-cli", model: "claude-opus-4-6" } } },
      { engines: { "claude-cli": cli }, budget: overCapBudget, recorder: noopSpendRecorder },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(cli.call).not.toHaveBeenCalled();
  });

  it("still blocks a paid (bedrock) engine under the same over-cap condition", async () => {
    const bed = stubBackend("bedrock-text");
    const err = await callAgentModel(
      { ...baseArgs, routing: { primary: { engine: "bedrock", model: "claude-opus-4-6" } } },
      { engines: { bedrock: bed }, budget: overCapBudget, recorder: noopSpendRecorder },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(bed.call).not.toHaveBeenCalled();
  });
});

describe("per-org getLlmBackend controls the claude-cli rewrite", () => {
  const bedrock: EngineHandle = { engine: "bedrock", model: "claude-sonnet-4-6" };

  afterEach(() => {
    delete process.env.NOELLE_CLAUDE_CLI;
  });

  it("getLlmBackend='aws' keeps a bedrock primary on bedrock even when claude-cli is wired", async () => {
    const cli = stubBackend("cli-text");
    const bed = stubBackend("bedrock-text");
    const res = await callAgentModel(
      { ...baseArgs, routing: { primary: bedrock } },
      {
        ...deps({ "claude-cli": cli, bedrock: bed }),
        getLlmBackend: async () => "aws",
      },
    );
    expect(res.engineUsed).toEqual(bedrock);
    expect(res.text).toBe("bedrock-text");
    expect(bed.call).toHaveBeenCalledOnce();
    expect(cli.call).not.toHaveBeenCalled();
  });

  it("getLlmBackend='claude' rewrites a bedrock primary to claude-cli when wired", async () => {
    const cli = stubBackend("cli-text");
    const bed = stubBackend("bedrock-text");
    const res = await callAgentModel(
      { ...baseArgs, routing: { primary: bedrock } },
      {
        ...deps({ "claude-cli": cli, bedrock: bed }),
        getLlmBackend: async () => "claude",
      },
    );
    expect(res.engineUsed).toEqual({ engine: "claude-cli", model: "claude-sonnet-4-6" });
    expect(res.text).toBe("cli-text");
    expect(cli.call).toHaveBeenCalledOnce();
    expect(bed.call).not.toHaveBeenCalled();
  });

  it("getLlmBackend='claude' but claude-cli NOT wired stays on bedrock (does not throw)", async () => {
    const bed = stubBackend("bedrock-text");
    const res = await callAgentModel(
      { ...baseArgs, routing: { primary: bedrock } },
      {
        ...deps({ bedrock: bed }),
        getLlmBackend: async () => "claude",
      },
    );
    expect(res.engineUsed).toEqual(bedrock);
    expect(res.text).toBe("bedrock-text");
    expect(bed.call).toHaveBeenCalledOnce();
  });

  it("no getLlmBackend + NOELLE_CLAUDE_CLI=1 falls back to the env flag (back-compat)", async () => {
    process.env.NOELLE_CLAUDE_CLI = "1";
    const cli = stubBackend("cli-text");
    const bed = stubBackend("bedrock-text");
    const res = await callAgentModel(
      { ...baseArgs, routing: { primary: bedrock } },
      deps({ "claude-cli": cli, bedrock: bed }),
    );
    expect(res.engineUsed).toEqual({ engine: "claude-cli", model: "claude-sonnet-4-6" });
    expect(cli.call).toHaveBeenCalledOnce();
    expect(bed.call).not.toHaveBeenCalled();
  });

  it("getLlmBackend overrides the env flag: 'aws' wins even with NOELLE_CLAUDE_CLI=1", async () => {
    process.env.NOELLE_CLAUDE_CLI = "1";
    const cli = stubBackend("cli-text");
    const bed = stubBackend("bedrock-text");
    const res = await callAgentModel(
      { ...baseArgs, routing: { primary: bedrock } },
      {
        ...deps({ "claude-cli": cli, bedrock: bed }),
        getLlmBackend: async () => "aws",
      },
    );
    expect(res.engineUsed).toEqual(bedrock);
    expect(bed.call).toHaveBeenCalledOnce();
    expect(cli.call).not.toHaveBeenCalled();
  });
});

describe("per-bucket call deadlines", () => {
  it("gives ideation room and leaves every other bucket on the default", () => {
    // pattern-breaker reads up to 100 posts and emits ~12,000 tokens; observed
    // runs finished in 157-175s and blew the 180s default 82% of the time.
    expect(bucketTimeoutMs("ideation")).toBe(600_000);
    for (const b of ["classifier", "drafter-codex", "drafter-verify", "profiler-codex"]) {
      expect(bucketTimeoutMs(b)).toBeUndefined();
    }
  });

  it("passes the deadline to the backend for ideation only", async () => {
    const seen: Array<number | undefined> = [];
    const spy = (text: string) => ({
      call: vi.fn(async (args: { timeoutMs?: number }) => {
        seen.push(args.timeoutMs);
        return { text, usage: { input_tokens: 1, output_tokens: 1 } };
      }),
    });
    for (const bucket of ["ideation", "classifier"]) {
      const b = spy("ok");
      await callAgentModel(
        { ...baseArgs, bucket, routing: { primary: { engine: "bedrock", model: "claude-opus-4-6" } } },
        { engines: { bedrock: b }, budget: unlimitedBudget, recorder: noopSpendRecorder },
      );
    }
    expect(seen).toEqual([600_000, undefined]);
  });
});

describe("a failed call is not a free call", () => {
  it("records estimated input and cents for a thrown call, not zero", async () => {
    // Recording zero made 54 pattern-breaker timeouts invisible to the cap.
    const rows: Array<{ inputTokens: number; cents: number; status: string }> = [];
    const recorder = {
      record: async (r: { inputTokens: number; cents: number; status: string }) => {
        rows.push(r);
      },
    };
    const boom: EngineBackend = {
      call: vi.fn(async () => {
        throw new Error("claude cli timed out after 180000ms");
      }),
    };
    await callAgentModel(
      {
        ...baseArgs,
        system: "s".repeat(40_000),
        prompt: "p".repeat(8_000),
        routing: { primary: { engine: "bedrock", model: "claude-opus-4-6" } },
      },
      { engines: { bedrock: boom }, budget: unlimitedBudget, recorder },
    ).catch(() => {});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("timeout");
    expect(rows[0]!.inputTokens).toBe(12_000); // 48,000 chars / 4
    expect(rows[0]!.cents).toBeGreaterThan(0);
  });
});

describe("codex failover when the Claude budget is spent", () => {
  // An over-cap budget: any paid/subscription engine is refused at pre-flight.
  const overCap: CallAgentModelDeps["budget"] = {
    estimateCents: () => 100,
    adapters: {
      fetchSpend: vi.fn(async () => ({ bucket: 9999, org: 9999, instance: 9999 })),
      fetchCaps: vi.fn(async () => ({ bucket: 10000, org: 10000, instance: 10000 })),
    },
  };

  it("continues on codex-cli instead of going dark", async () => {
    // The whole point: a weekly cap should stop the CLAUDE pot, not the work,
    // when a second subscription is sitting idle.
    const codex = stubBackend("codex-text");
    const res = await callAgentModel(
      { ...baseArgs, routing: { primary: { engine: "claude-cli", model: "claude-opus-4-6" } } },
      {
        engines: { "claude-cli": stubBackend("never"), "codex-cli": codex },
        budget: overCap,
        recorder: noopSpendRecorder,
      },
    );
    expect(res.text).toBe("codex-text");
    expect(res.engineUsed).toEqual({ engine: "codex-cli", model: "gpt-5" });
    expect(res.outcome).toBe("fallback");
  });

  it("still throws when no codex backend is wired", async () => {
    // An org without a ChatGPT subscription keeps today's behaviour exactly:
    // the cap stops the work.
    const err = await callAgentModel(
      { ...baseArgs, routing: { primary: { engine: "claude-cli", model: "claude-opus-4-6" } } },
      {
        engines: { "claude-cli": stubBackend("never") },
        budget: overCap,
        recorder: noopSpendRecorder,
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
  });

  it("NOELLE_CODEX_FAILOVER=0 restores 'the cap stops the work'", async () => {
    const prev = process.env.NOELLE_CODEX_FAILOVER;
    process.env.NOELLE_CODEX_FAILOVER = "0";
    try {
      const err = await callAgentModel(
        { ...baseArgs, routing: { primary: { engine: "claude-cli", model: "claude-opus-4-6" } } },
        {
          engines: { "claude-cli": stubBackend("never"), "codex-cli": stubBackend("codex") },
          budget: overCap,
          recorder: noopSpendRecorder,
        },
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BudgetExceededError);
    } finally {
      if (prev === undefined) delete process.env.NOELLE_CODEX_FAILOVER;
      else process.env.NOELLE_CODEX_FAILOVER = prev;
    }
  });
});

describe("codex failover when Claude authentication expires", () => {
  it("continues on codex-cli instead of retrying the same broken Claude session", async () => {
    const cli = failingBackend(
      new ClaudeCliAuthError(
        "claude cli auth failure: OAuth session expired and could not be refreshed",
      ),
    );
    const codex = stubBackend("codex-text");

    const res = await callAgentModel(
      {
        ...baseArgs,
        routing: {
          primary: { engine: "bedrock", model: "claude-sonnet-4-6" },
          fallback: { engine: "bedrock", model: "claude-opus-4-6" },
        },
      },
      {
        ...deps({ "claude-cli": cli, "codex-cli": codex }),
        getLlmBackend: async () => "claude",
      },
    );

    expect(res.text).toBe("codex-text");
    expect(res.engineUsed).toEqual({ engine: "codex-cli", model: "gpt-5" });
    expect(res.outcome).toBe("fallback");
    expect(cli.call).toHaveBeenCalledOnce();
    expect(codex.call).toHaveBeenCalledOnce();
  });

  it("preserves a healthy configured fallback when Codex is unavailable", async () => {
    const cli = failingBackend(
      new ClaudeCliAuthError(
        "claude cli auth failure: OAuth session expired and could not be refreshed",
      ),
    );
    const vertex = stubBackend("vertex-text");

    const res = await callAgentModel(
      {
        ...baseArgs,
        routing: {
          primary: { engine: "bedrock", model: "claude-sonnet-4-6" },
          fallback: { engine: "vertex", model: "gemini-2-5-pro" },
        },
      },
      {
        ...deps({ "claude-cli": cli, vertex }),
        getLlmBackend: async () => "claude",
      },
    );

    expect(res.text).toBe("vertex-text");
    expect(res.engineUsed).toEqual({ engine: "vertex", model: "gemini-2-5-pro" });
    expect(res.outcome).toBe("fallback");
    expect(cli.call).toHaveBeenCalledOnce();
    expect(vertex.call).toHaveBeenCalledOnce();
  });

  it("preserves a healthy configured fallback when the Codex attempt fails", async () => {
    const cli = failingBackend(
      new ClaudeCliAuthError(
        "claude cli auth failure: OAuth session expired and could not be refreshed",
      ),
    );
    const codex = failingBackend(new Error("codex unavailable"));
    const vertex = stubBackend("vertex-text");

    const res = await callAgentModel(
      {
        ...baseArgs,
        routing: {
          primary: { engine: "bedrock", model: "claude-sonnet-4-6" },
          fallback: { engine: "vertex", model: "gemini-2-5-pro" },
        },
      },
      {
        ...deps({ "claude-cli": cli, "codex-cli": codex, vertex }),
        getLlmBackend: async () => "claude",
      },
    );

    expect(res.text).toBe("vertex-text");
    expect(res.engineUsed).toEqual({ engine: "vertex", model: "gemini-2-5-pro" });
    expect(res.outcome).toBe("fallback");
    expect(cli.call).toHaveBeenCalledOnce();
    expect(codex.call).toHaveBeenCalledOnce();
    expect(vertex.call).toHaveBeenCalledOnce();
  });

  it("uses Codex when a rewritten configured fallback cannot authenticate", async () => {
    const vertex = failingBackend(new Error("vertex unavailable"));
    const cli = failingBackend(
      new ClaudeCliAuthError(
        "claude cli auth failure: OAuth session expired and could not be refreshed",
      ),
    );
    const codex = stubBackend("codex-text");

    const res = await callAgentModel(
      {
        ...baseArgs,
        routing: {
          primary: { engine: "vertex", model: "gemini-2-5-pro" },
          fallback: { engine: "bedrock", model: "claude-sonnet-4-6" },
        },
      },
      {
        ...deps({ vertex, "claude-cli": cli, "codex-cli": codex }),
        getLlmBackend: async () => "claude",
      },
    );

    expect(res.text).toBe("codex-text");
    expect(res.engineUsed).toEqual({ engine: "codex-cli", model: "gpt-5" });
    expect(res.outcome).toBe("fallback");
    expect(vertex.call).toHaveBeenCalledOnce();
    expect(cli.call).toHaveBeenCalledOnce();
    expect(codex.call).toHaveBeenCalledOnce();
  });
});

describe("Codex primary mode", () => {
  it("keeps an explicit subscription-only call on Codex at the requested effort", async () => {
    const paid = failingBackend(new Error("paid primary must not be called"));
    const cli = failingBackend(new Error("Claude must not be called"));
    const codex = stubBackend("codex-only");

    const res = await callAgentModel(
      {
        ...baseArgs,
        codexSubscriptionOnly: true,
        codexReasoningEffort: "high",
        routing: { primary: { engine: "vertex", model: "gemini-2-5-pro" } },
      },
      deps({ vertex: paid, "claude-cli": cli, "codex-cli": codex }),
    );

    expect(res.text).toBe("codex-only");
    expect(res.engineUsed).toEqual({ engine: "codex-cli", model: "gpt-5" });
    expect(res.outcome).toBe("ok");
    expect(codex.call).toHaveBeenCalledWith(expect.objectContaining({ reasoningEffort: "high" }));
    expect(codex.call).toHaveBeenCalledOnce();
    expect(cli.call).not.toHaveBeenCalled();
    expect(paid.call).not.toHaveBeenCalled();
  });

  it("fails closed when Codex is not wired", async () => {
    const paid = failingBackend(new Error("paid primary must not be called"));
    const cli = failingBackend(new Error("Claude must not be called"));

    await expect(
      callAgentModel(
        {
          ...baseArgs,
          codexSubscriptionOnly: true,
          routing: { primary: { engine: "openai", model: "gpt-5" } },
        },
        deps({ openai: paid, "claude-cli": cli }),
      ),
    ).rejects.toThrow('engine "codex-cli" not configured');

    expect(cli.call).not.toHaveBeenCalled();
    expect(paid.call).not.toHaveBeenCalled();
  });

  it("uses Codex directly without probing the configured Claude subscription", async () => {
    const prev = process.env.NOELLE_CODEX_PRIMARY;
    process.env.NOELLE_CODEX_PRIMARY = "1";
    try {
      const cli = failingBackend(new Error("Claude must not be called"));
      const codex = stubBackend("codex-primary");

      const res = await callAgentModel(
        {
          ...baseArgs,
          routing: { primary: { engine: "bedrock", model: "claude-opus-4-6" } },
        },
        {
          ...deps({ "claude-cli": cli, "codex-cli": codex }),
          getLlmBackend: async () => "claude",
        },
      );

      expect(res.text).toBe("codex-primary");
      expect(res.engineUsed).toEqual({ engine: "codex-cli", model: "gpt-5" });
      expect(res.outcome).toBe("ok");
      expect(codex.call).toHaveBeenCalledOnce();
      expect(cli.call).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.NOELLE_CODEX_PRIMARY;
      else process.env.NOELLE_CODEX_PRIMARY = prev;
    }
  });

  it("falls back to the configured engine without probing Claude when Codex fails", async () => {
    const prev = process.env.NOELLE_CODEX_PRIMARY;
    process.env.NOELLE_CODEX_PRIMARY = "1";
    try {
      const bedrock = stubBackend("bedrock-fallback");
      const cli = failingBackend(new Error("Claude must not be called"));
      const codex = failingBackend(new Error("codex unavailable"));

      const res = await callAgentModel(
        {
          ...baseArgs,
          routing: { primary: { engine: "bedrock", model: "claude-opus-4-6" } },
        },
        {
          ...deps({ bedrock, "claude-cli": cli, "codex-cli": codex }),
          getLlmBackend: async () => "claude",
        },
      );

      expect(res.text).toBe("bedrock-fallback");
      expect(res.engineUsed).toEqual({ engine: "bedrock", model: "claude-opus-4-6" });
      expect(res.outcome).toBe("fallback");
      expect(codex.call).toHaveBeenCalledOnce();
      expect(bedrock.call).toHaveBeenCalledOnce();
      expect(cli.call).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.NOELLE_CODEX_PRIMARY;
      else process.env.NOELLE_CODEX_PRIMARY = prev;
    }
  });

  it("uses the supplied Bedrock route directly when the caller opts out of global overrides", async () => {
    const prev = process.env.NOELLE_CODEX_PRIMARY;
    process.env.NOELLE_CODEX_PRIMARY = "1";
    try {
      const bedrock: EngineBackend = {
        call: vi
          .fn()
          .mockRejectedValueOnce(new Error("sonnet unavailable"))
          .mockResolvedValueOnce({
            text: "opus-repair",
            usage: { input_tokens: 10, output_tokens: 20 },
          }),
      };
      const codex = stubBackend("codex-primary");
      const cli = stubBackend("claude-cli-primary");
      const getLlmBackend = vi.fn(async () => "claude" as const);

      const res = await callAgentModel(
        {
          ...baseArgs,
          directRouting: true,
          routing: {
            primary: { engine: "bedrock", model: "claude-sonnet-4-6" },
            fallback: { engine: "bedrock", model: "claude-opus-4-6" },
          },
        },
        {
          ...deps({ bedrock, "claude-cli": cli, "codex-cli": codex }),
          getLlmBackend,
        },
      );

      expect(res.text).toBe("opus-repair");
      expect(res.engineUsed).toEqual({ engine: "bedrock", model: "claude-opus-4-6" });
      expect(res.outcome).toBe("fallback");
      expect(bedrock.call).toHaveBeenCalledTimes(2);
      expect(vi.mocked(bedrock.call).mock.calls.map(([call]) => call.model)).toEqual([
        "claude-sonnet-4-6",
        "claude-opus-4-6",
      ]);
      expect(codex.call).not.toHaveBeenCalled();
      expect(cli.call).not.toHaveBeenCalled();
      expect(getLlmBackend).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.NOELLE_CODEX_PRIMARY;
      else process.env.NOELLE_CODEX_PRIMARY = prev;
    }
  });
});

describe("the codex pot has a ceiling of its own", () => {
  const overCap: CallAgentModelDeps["budget"] = {
    estimateCents: () => 100,
    adapters: {
      fetchSpend: vi.fn(async () => ({ bucket: 9999, org: 9999, instance: 9999 })),
      fetchCaps: vi.fn(async () => ({ bucket: 10000, org: 10000, instance: 10000 })),
    },
  };
  const withCodexSpend = (cents: number): CallAgentModelDeps["budget"] => ({
    ...overCap,
    adapters: { ...overCap.adapters, fetchEngineSpend: vi.fn(async () => cents) },
  });
  const routing = { primary: { engine: "claude-cli" as const, model: "claude-opus-4-6" as const } };

  it("fails over while the ChatGPT pot has room", async () => {
    const codex = stubBackend("codex-text");
    const res = await callAgentModel(
      { ...baseArgs, routing },
      { engines: { "claude-cli": stubBackend("x"), "codex-cli": codex },
        budget: withCodexSpend(10_000), recorder: noopSpendRecorder },
    );
    expect(res.text).toBe("codex-text");
  });

  it("stops instead of failing over once the ChatGPT pot is spent too", async () => {
    // 'Exempt from the Claude cap' was left meaning 'unbounded'. Both pots
    // spent means the work genuinely stops, which is the point of a budget.
    const err = await callAgentModel(
      { ...baseArgs, routing },
      { engines: { "claude-cli": stubBackend("x"), "codex-cli": stubBackend("codex") },
        budget: withCodexSpend(50_000), recorder: noopSpendRecorder },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
