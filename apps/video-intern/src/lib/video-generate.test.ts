import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetExceededError, createBudgetedBackend, ModelNotDispatchedError, unlimitedBudget, type EngineBackend, type SpendRow } from "@noelle/runtime";
import { PgOperationError } from "@noelle/runtime/bounded-pg-session";
import { createBackendJsonFn, createIdeator, createScripter, createVertexJsonFn } from "./video-generate.js";
import { createVideoModelOperation } from "./video-gemini.js";

function fakeBackend(impl: EngineBackend["call"]): EngineBackend {
  return { call: impl };
}

describe("createBackendJsonFn", () => {
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });
  it("parses JSON from the backend reply", async () => {
    const json = createBackendJsonFn(
      fakeBackend(async () => ({ text: '{"keep":["a","b"]}', usage: { input_tokens: 1, output_tokens: 1 } })),
      "claude-test",
    );
    await expect(json("sys", "user")).resolves.toEqual({ keep: ["a", "b"] });
  });

  it("extracts JSON from a fenced code block", async () => {
    const json = createBackendJsonFn(
      fakeBackend(async () => ({ text: "```json\n{\"ideas\":[]}\n```", usage: { input_tokens: 1, output_tokens: 1 } })),
      "claude-test",
    );
    await expect(json("sys", "user")).resolves.toEqual({ ideas: [] });
  });

  it("returns null when the backend throws (fail-open)", async () => {
    const json = createBackendJsonFn(
      fakeBackend(async () => {
        throw new Error("bedrock 500");
      }),
      "claude-test",
    );
    await expect(json("sys", "user")).resolves.toBeNull();
  });

  it("propagates canonical denied admission without dispatching the underlying backend", async () => {
    const call = vi.fn<EngineBackend["call"]>(async () => ({ text: '{}', usage: { input_tokens: 1, output_tokens: 1 } }));
    const backend = createBudgetedBackend({ call }, { engine: "bedrock",
      context: { orgId: "fixture-org", instanceId: "fixture-instance", agentRole: "video_intern", worker: "ideator", bucket: "drafter" },
      budget: { estimateCents: () => 1, adapters: {
        fetchSpend: async () => ({ bucket: 0, org: 0, instance: 0 }),
        fetchCaps: async () => ({ bucket: 100, org: 100, instance: 0 }),
      } }, recorder: { record: async () => {} } });
    await expect(createBackendJsonFn(backend, "claude-sonnet-4-6")("system", "user")).rejects.toBeInstanceOf(BudgetExceededError);
    expect(call).not.toHaveBeenCalled();
  });

  it("propagates an admission database failure and clears its timer", async () => {
    vi.useFakeTimers();
    const error = new PgOperationError("database");
    const json = createBackendJsonFn(fakeBackend(async () => { throw error; }), "saved");
    await expect(json("system", "user")).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns null on timeout instead of hanging", async () => {
    vi.useFakeTimers();
    const json = createBackendJsonFn(
      fakeBackend(() => new Promise(() => {})), // never resolves
      "claude-test",
      { timeoutMs: 50 },
    );
    const p = json("sys", "user");
    await vi.advanceTimersByTimeAsync(60);
    await expect(p).resolves.toBeNull();
    vi.useRealTimers();
  });

  it("returns null on unparseable text", async () => {
    const json = createBackendJsonFn(
      fakeBackend(async () => ({ text: "no json here at all", usage: { input_tokens: 1, output_tokens: 1 } })),
      "claude-test",
    );
    await expect(json("sys", "user")).resolves.toBeNull();
  });
  it.each([undefined, 50, 1_800_000])("forwards its %s budget to the owned backend", async timeoutMs => {
    let received: Parameters<EngineBackend["call"]>[0] | undefined;
    const json = createBackendJsonFn(fakeBackend(async args => {
      received = args; return { text: '{"saved":true}', usage: { input_tokens: 1, output_tokens: 1 } };
    }), "saved", timeoutMs === undefined ? undefined : { timeoutMs });
    expect(await json("system", "user")).toEqual({ saved: true });
    expect(received?.timeoutMs).toBe(timeoutMs ?? 90_000);
  });
  it("clears its guard timer after a successful response", async () => {
    vi.useFakeTimers();
    const json = createBackendJsonFn(fakeBackend(async () => ({ text: '{}', usage: { input_tokens: 1, output_tokens: 1 } })), "saved");
    expect(await json("system", "user")).toEqual({});
    expect(vi.getTimerCount()).toBe(0);
  });
  it("clears its guard timer after a backend rejection", async () => {
    vi.useFakeTimers();
    const json = createBackendJsonFn(fakeBackend(async () => { throw new Error("failed"); }), "saved");
    expect(await json("system", "user")).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects a receipt after its monotonic deadline before the overdue timer fires", async () => {
    vi.useFakeTimers(); let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const json = createBackendJsonFn(fakeBackend(async () => {
      clock = 60; return { text: '{}', usage: { input_tokens: 1, output_tokens: 1 } };
    }), "saved", { timeoutMs: 50 });
    expect(await json("system", "user")).toBeNull();
  });
  it.each([0, -1, 0.5, NaN, Infinity, 1_800_001, Number.MAX_SAFE_INTEGER])("rejects invalid budget %s before backend dispatch", async timeoutMs => {
    vi.useFakeTimers();
    const call = vi.fn(async () => ({ text: '{}', usage: { input_tokens: 1, output_tokens: 1 } }));
    const json = createBackendJsonFn(fakeBackend(call), "saved", { timeoutMs });
    expect(await json("system", "user")).toBeNull(); expect(call).not.toHaveBeenCalled();
  });
  function metering(rows: SpendRow[], admit = vi.fn(async () => ({ attemptId: "a" }))) {
    return { engine: "bedrock" as const, context: { orgId: "org", instanceId: "instance", agentRole: "video_intern" as const, worker: "scripter", bucket: "drafter" },
      budget: { ...unlimitedBudget, adapters: { ...unlimitedBudget.adapters, reserveAttempt: admit } },
      recorder: { record: async (row: SpendRow) => { rows.push(row); } } };
  }
  it("admits money, acknowledges the marker, dispatches and records in that order", async () => {
    const order: string[] = []; const rows: SpendRow[] = [];
    const scope = metering(rows, vi.fn(async () => { order.push("admission"); return { attemptId: "a" }; }));
    scope.recorder.record = async row => { order.push("receipt"); rows.push(row); };
    const operation = createVideoModelOperation(async () => { order.push("marker"); return "dispatch"; });
    const json = createBackendJsonFn(fakeBackend(async () => {
      order.push("provider"); return { text: '{}', usage: { input_tokens: 0, output_tokens: 0 } };
    }), "claude-sonnet-4-6", { metering: scope });
    expect(await json("system", "prompt", operation)).toEqual({});
    expect(order).toEqual(["admission", "marker", "provider", "receipt"]);
    expect(operation.acknowledgement).toBe("dispatch");
    expect(rows[0]).toMatchObject({ status: "ok", cents: 0, costBasis: "token_estimate" });
  });
  it("records an affirmative deadline refusal before any marker or provider call", async () => {
    let clock = 0; vi.spyOn(performance, "now").mockImplementation(() => clock);
    const rows: SpendRow[] = []; const admit = vi.fn(async () => { clock = 20; return { attemptId: "a" }; });
    const marker = vi.fn(async () => "dispatch" as const); const operation = createVideoModelOperation(marker);
    const call = vi.fn<EngineBackend["call"]>(async () => ({ text: '{}', usage: { input_tokens: 0, output_tokens: 0 } }));
    const json = createBackendJsonFn({ call }, "claude-sonnet-4-6", { timeoutMs: 10, metering: metering(rows, admit) });
    await expect(json("system", "prompt", operation)).rejects.toBeInstanceOf(ModelNotDispatchedError);
    expect(marker).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled();
    expect(operation).toMatchObject({ acknowledgement: "not_dispatched", markerAttempted: false });
    expect(rows).toEqual([expect.objectContaining({ status: "error", costBasis: "not_dispatched", cents: 0,
      inputTokens: 0, outputTokens: 0, latencyMs: null })]);
  });
  it("keeps a thrown nominal marker refusal unknown instead of releasing its accounting hold", async () => {
    const rows: SpendRow[] = []; const operation = createVideoModelOperation(async () => { throw new ModelNotDispatchedError(); });
    const call = vi.fn<EngineBackend["call"]>(async () => ({ text: '{}', usage: { input_tokens: 0, output_tokens: 0 } }));
    const json = createBackendJsonFn({ call }, "claude-sonnet-4-6", { metering: metering(rows) });
    await expect(json("system", "prompt", operation)).rejects.toBeInstanceOf(ModelNotDispatchedError);
    expect(call).not.toHaveBeenCalled(); expect(operation).toMatchObject({ acknowledgement: "unknown", markerAttempted: true });
    expect(rows).toEqual([expect.objectContaining({ status: "error", costBasis: "unknown", cents: 0 })]);
  });
  it("retains an acknowledged marker when its response arrives after the original deadline", async () => {
    let clock = 0; vi.spyOn(performance, "now").mockImplementation(() => clock);
    const rows: SpendRow[] = []; const operation = createVideoModelOperation(async () => { clock = 20; return "dispatch"; });
    const call = vi.fn<EngineBackend["call"]>(async () => ({ text: '{}', usage: { input_tokens: 0, output_tokens: 0 } }));
    const json = createBackendJsonFn({ call }, "claude-sonnet-4-6", { timeoutMs: 10, metering: metering(rows) });
    expect(await json("system", "prompt", operation)).toBeNull(); expect(call).not.toHaveBeenCalled();
    expect(operation).toMatchObject({ acknowledgement: "dispatch", markerAttempted: true });
    expect(rows).toEqual([expect.objectContaining({ status: "error", costBasis: "failure_estimate" })]);
  });
  it("does not treat a provider nominal error as a marker refusal", async () => {
    const rows: SpendRow[] = []; const operation = createVideoModelOperation(async () => "dispatch");
    const call = vi.fn<EngineBackend["call"]>(async () => { throw new ModelNotDispatchedError(); });
    const json = createBackendJsonFn({ call }, "claude-sonnet-4-6", { metering: metering(rows) });
    await expect(json("system", "prompt", operation)).rejects.toBeInstanceOf(ModelNotDispatchedError);
    expect(call).toHaveBeenCalledOnce(); expect(operation.acknowledgement).toBe("dispatch");
    expect(rows[0]).toMatchObject({ costBasis: "failure_estimate" });
  });
  it("requires exclusive canonical metering and preserves an unrelated existing hook", async () => {
    const rows: SpendRow[] = []; const call = vi.fn<EngineBackend["call"]>(async () => ({ text: '{}', usage: { input_tokens: 0, output_tokens: 0 } }));
    const marker = vi.fn(async () => "dispatch" as const); const operation = createVideoModelOperation(marker);
    expect(await createBackendJsonFn({ call }, "saved")("system", "prompt", operation)).toBeNull();
    const existing = vi.fn(async () => "dispatch" as const); const scope = { ...metering(rows), beforeDispatch: existing };
    const json = createBackendJsonFn({ call }, "claude-sonnet-4-6", { metering: scope });
    expect(await json("system", "prompt", operation)).toBeNull();
    expect(marker).not.toHaveBeenCalled(); expect(existing).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled();
    expect(await json("system", "prompt")).toEqual({}); expect(existing).toHaveBeenCalledOnce();
  });
  it("refuses reuse before a second reservation or dispatch", async () => {
    const rows: SpendRow[] = []; const scope = metering(rows); const operation = createVideoModelOperation(async () => "dispatch");
    const call = vi.fn<EngineBackend["call"]>(async () => ({ text: '{}', usage: { input_tokens: 0, output_tokens: 0 } }));
    const json = createBackendJsonFn({ call }, "claude-sonnet-4-6", { metering: scope });
    expect(await json("system", "prompt", operation)).toEqual({});
    expect(await json("system", "prompt", operation)).toBeNull();
    expect(scope.budget.adapters.reserveAttempt).toHaveBeenCalledOnce(); expect(call).toHaveBeenCalledOnce(); expect(rows).toHaveLength(1);
  });
  it("records known usage before malformed generated JSON is discarded", async () => {
    const rows: SpendRow[] = []; const opts = { timeoutMs: 1000, metering: metering(rows) };
    const json = createBackendJsonFn(fakeBackend(async () => ({ text: 'malformed', usage: { input_tokens: 1, output_tokens: 2, cost_usd: 0.03 } })), "claude-sonnet-4-6", opts);
    expect(await json("system", "prompt")).toBeNull();
    expect(rows).toEqual([expect.objectContaining({ status: "ok", costBasis: "provider_reported", cents: 3, attemptId: "a" })]);
  });
  it("does not dispatch after admission consumes the original deadline", async () => {
    let clock = 0; vi.spyOn(performance, "now").mockImplementation(() => clock);
    const rows: SpendRow[] = []; const admit = vi.fn(async () => { clock = 20; return { attemptId: "a" }; });
    const call = vi.fn<EngineBackend["call"]>(async () => ({ text: '{}', usage: { input_tokens: 0, output_tokens: 0 } }));
    expect(await createBackendJsonFn({ call }, "claude-sonnet-4-6", { timeoutMs: 10, metering: metering(rows, admit) })("system", "prompt")).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });
  it("reduces the provider deadline by time spent on admission", async () => {
    let clock = 0; vi.spyOn(performance, "now").mockImplementation(() => clock);
    const rows: SpendRow[] = []; const admit = vi.fn(async () => { clock = 5; return { attemptId: "a" }; });
    const call = vi.fn<EngineBackend["call"]>(async () => ({ text: '{}', usage: { input_tokens: 0, output_tokens: 0 } }));
    expect(await createBackendJsonFn({ call }, "claude-sonnet-4-6", { timeoutMs: 20, metering: metering(rows, admit) })("system", "prompt")).toEqual({});
    expect(call.mock.calls[0]?.[0]).toMatchObject({ timeoutMs: 15 }); expect(rows).toHaveLength(1);
  });
  it("awaits an admitted receipt before returning an expired output outcome", async () => {
    vi.useFakeTimers(); let release!: () => void; let recording = false; let settled = false;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const rows: SpendRow[] = []; const scope = metering(rows);
    scope.recorder.record = async row => { recording = true; await blocked; rows.push(row); };
    const call = vi.fn<EngineBackend["call"]>(async () => ({ text: '{}', usage: { input_tokens: 1, output_tokens: 1 } }));
    const pending = createBackendJsonFn({ call }, "claude-sonnet-4-6", { timeoutMs: 10, metering: scope })("system", "prompt")
      .then(value => { settled = true; return value; });
    try {
      await vi.advanceTimersByTimeAsync(20);
      expect(recording).toBe(true); expect(settled).toBe(false);
    } finally { release(); await pending; }
    expect(await pending).toBeNull(); expect(call).toHaveBeenCalledOnce(); expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "ok", costBasis: "token_estimate", attemptId: "a" });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("createVertexJsonFn request compatibility", () => {
  it("keeps key precedence, combined prompt and configured temperature", async () => {
    let request: RequestInit | undefined; let url = "";
    const auth = { getAccessToken: vi.fn(async () => "unused") };
    const json = createVertexJsonFn({ project: "", apiKey: "fixture", authClient: auth, temperature: 0.37,
      fetchImpl: async (input, init) => {
        url = String(input); request = init;
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '```json\n{"saved":true}\n```' }] } }] }));
      } });
    expect(await json("system", "user")).toEqual({ saved: true });
    expect(auth.getAccessToken).not.toHaveBeenCalled();
    expect(url).toContain("/models/gemini-2.5-flash:generateContent?key=fixture");
    expect(JSON.parse(String(request?.body))).toEqual({ contents: [{ role: "user", parts: [{ text: "system\n\nuser" }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.37 } });
  });
  it("keeps separate Vertex system instructions, model and default temperature", async () => {
    let request: RequestInit | undefined; let url = "";
    const json = createVertexJsonFn({ project: "project", location: "region", model: "saved-model",
      authClient: { getAccessToken: async () => "saved-token" }, fetchImpl: async (input, init) => {
        url = String(input); request = init;
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Before {"saved":true} after' }] } }] }));
      } });
    expect(await json("system", "user")).toEqual({ saved: true });
    expect(url).toContain("region-aiplatform.googleapis.com/v1/projects/project/locations/region/publishers/google/models/saved-model");
    expect(new Headers(request?.headers).get("authorization")).toBe("Bearer saved-token");
    expect(JSON.parse(String(request?.body))).toEqual({ systemInstruction: { parts: [{ text: "system" }] },
      contents: [{ role: "user", parts: [{ text: "user" }] }], generationConfig: { responseMimeType: "application/json", temperature: 0.5 } });
  });
});

describe("createScripter", () => {
  it("passes structure guidance into Nova's script generation prompt", async () => {
    let seenSystem = "";
    const scripter = createScripter(async (system) => {
      seenSystem = system;
      return {
        hook: "Ship the rough version",
        structure: [{ tStart: 0, tEnd: 3, purpose: "hook", line: "Ship the rough version." }],
        script: "Ship the rough version.",
        transitions: [{ at: "0", type: "cut" }],
        sounds: [{ name: "quiet beat", trending: false }],
        graphSpecs: [],
      };
    });

    await scripter.script({ hook: "ship", concept: "iterate", objective: null, profiles: [], exemplars: [] });

    expect(seenSystem).toContain("Let the content earn its ending");
    expect(seenSystem).toContain("Use specific names, numbers, references, feelings or anecdotes only when relevant and supported");
  });
});

describe("createIdeator", () => {
  it("passes structure guidance into Nova's idea generation prompt", async () => {
    let seenSystem = "";
    const ideator = createIdeator(async (system) => {
      seenSystem = system;
      return { ideas: [{ hook: "h", concept: "c", angle: "a", pillar: "p", inspirationClipIds: ["x"] }] };
    });

    await ideator.ideate({ objective: "grow", count: 1, profiles: [], clips: [] });

    expect(seenSystem).toContain("Let the content earn its ending");
    expect(seenSystem).toContain("With missing facts, omit the detail instead of inventing it");
  });

  it("validates and returns ideas from the injected json fn", async () => {
    const ideator = createIdeator(async () => ({
      ideas: [{ hook: "h", concept: "c", angle: "a", pillar: "p", inspirationClipIds: ["x"] }],
    }));
    const out = await ideator.ideate({ objective: "grow", count: 1, profiles: [], clips: [] });
    expect(out?.ideas).toHaveLength(1);
    expect(out?.ideas[0]?.hook).toBe("h");
  });

  it("returns null when the json fn yields null (fail-open)", async () => {
    const ideator = createIdeator(async () => null);
    await expect(ideator.ideate({ objective: null, count: 3, profiles: [], clips: [] })).resolves.toBeNull();
  });
});
