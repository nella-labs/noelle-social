import { afterEach, describe, expect, it, vi } from "vitest";
import { VideoTeardownSchema } from "@noelle/contracts";
import { BudgetExceededError, ModelNotDispatchedError, unlimitedBudget, type SpendRow } from "@noelle/runtime";
import { createVideoModelOperation, videoOperationFailureReason } from "./video-gemini.js";
import { createVertexJsonFn } from "./video-generate.js";
import { createVertexVideoAnalyzer } from "./teardown-analyze.js";

const teardown = VideoTeardownSchema.parse({ hook: { text: "Saved hook", type: "question" },
  pacing: { cutsPerSec: 0.1, avgBeatSec: 1, wordsPerSec: 1 }, cta: { present: false }, sound: {}, whyItWorked: "Observed structure" });
const input = { caption: "Saved caption", transcript: "", keyframePaths: [], cutTimestamps: [],
  metrics: { views: null, likes: null, comments: null, shares: null, durationS: 1 } };
const body = (value: unknown, extra = {}) => JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }], ...extra });
const factories = [
  { name: "text JSON", value: { saved: true }, call: (fetchImpl: typeof fetch, timeoutMs = 1000, authClient?: { getAccessToken(): Promise<string> }) => {
    const opts = { project: "fixture", ...(authClient ? { authClient } : { apiKey: "fixture" }), timeoutMs, fetchImpl };
    return createVertexJsonFn(opts)("system", "user");
  } },
  { name: "multimodal teardown", value: teardown, call: (fetchImpl: typeof fetch, timeoutMs = 1000, authClient?: { getAccessToken(): Promise<string> }) => {
    const opts = { project: "fixture", ...(authClient ? { authClient } : { apiKey: "fixture" }), timeoutMs, fetchImpl };
    return createVertexVideoAnalyzer(opts).analyze(input);
  } },
];
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Video operation dispatch acknowledgements", () => {
  it("uses one failure classifier for deadline refusal, source rejection and unknown acknowledgement", async () => {
    const untouched = createVideoModelOperation(async () => "dispatch");
    expect(videoOperationFailureReason(untouched)).toBe("generation_unknown");
    expect(videoOperationFailureReason(untouched, true)).toBe("preparation_failed");
    const expired = createVideoModelOperation(async () => "dispatch"); await expired.beforeDispatch(performance.now() - 1);
    expect(videoOperationFailureReason(expired)).toBe("preparation_failed");
    const rejected = createVideoModelOperation(async () => "not_dispatched"); await rejected.beforeDispatch(performance.now() + 1000);
    expect(videoOperationFailureReason(rejected)).toBe("source_changed");
    const lost = createVideoModelOperation(async () => { throw new ModelNotDispatchedError(); });
    await lost.beforeDispatch(performance.now() + 1000).catch(() => {});
    expect(videoOperationFailureReason(lost, true)).toBe("dispatch_uncertain");
    const dispatched = createVideoModelOperation(async () => "dispatch"); await dispatched.beforeDispatch(performance.now() + 1000);
    expect(() => videoOperationFailureReason(dispatched)).toThrow("dispatch was acknowledged");
  });
  it("refuses an expired original deadline without attempting its marker", async () => {
    const marker = vi.fn(async () => "dispatch" as const); const operation = createVideoModelOperation(marker);
    expect(await operation.beforeDispatch(performance.now() - 1)).toBe("not_dispatched");
    expect(operation.acknowledgement).toBe("not_dispatched"); expect(operation.markerAttempted).toBe(false);
    expect(marker).not.toHaveBeenCalled();
  });
  it.each(["dispatch", "not_dispatched"] as const)("retains an actual returned %s marker decision", async decision => {
    const operation = createVideoModelOperation(async () => decision);
    expect(await operation.beforeDispatch(performance.now() + 1000)).toBe(decision);
    expect(operation.markerAttempted).toBe(true); expect(operation.acknowledgement).toBe(decision);
  });
  it.each([new Error("lost acknowledgement"), new ModelNotDispatchedError()])("keeps thrown %s unknown", async error => {
    const operation = createVideoModelOperation(async () => { throw error; });
    await expect(operation.beforeDispatch(performance.now() + 1000)).rejects.toBe(error);
    expect(operation.markerAttempted).toBe(true); expect(operation.acknowledgement).toBe("unknown");
  });
  it("rejects an invalid callback result without accepting a refusal", async () => {
    const operation = createVideoModelOperation(async () => "invalid" as never);
    await expect(operation.beforeDispatch(performance.now() + 1000)).rejects.toThrow();
    expect(operation.acknowledgement).toBe("unknown"); expect(operation.markerAttempted).toBe(true);
  });
  it("cannot acknowledge the same operation twice", async () => {
    const marker = vi.fn(async () => "dispatch" as const); const operation = createVideoModelOperation(marker);
    expect(await operation.beforeDispatch(performance.now() + 1000)).toBe("dispatch");
    await expect(operation.beforeDispatch(performance.now() + 1000)).rejects.toThrow();
    expect(marker).toHaveBeenCalledOnce(); expect(operation.acknowledgement).toBe("dispatch");
  });
  it("keeps overlapping operation acknowledgements isolated", async () => {
    let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
    const first = createVideoModelOperation(async () => { await pending; return "dispatch"; });
    const second = createVideoModelOperation(async () => "not_dispatched");
    const call = first.beforeDispatch(performance.now() + 1000);
    expect(await second.beforeDispatch(performance.now() + 1000)).toBe("not_dispatched");
    expect(first.acknowledgement).toBe("unknown"); release(); expect(await call).toBe("dispatch");
    expect(second.acknowledgement).toBe("not_dispatched");
  });
});

describe.each(factories)("$name HTTP lifetime", entry => {
  it.each(["key", "adc"])("preserves a valid %s response", async kind => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(body(entry.value)));
    const auth = { getAccessToken: vi.fn(async () => "saved-token") };
    expect(await entry.call(fetchImpl, 1000, kind === "adc" ? auth : undefined)).toEqual(entry.value);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(auth.getAccessToken).toHaveBeenCalledTimes(kind === "adc" ? 1 : 0);
  });
  it("rejects responses exceeding the shared byte limit", async () => {
    expect(await entry.call(async () => new Response(body(entry.value, { padding: "x".repeat(4 * 1024 * 1024) })))).toBeNull();
  });
  it("never treats thought-only JSON as generated output", async () => {
    const response = { candidates: [{ content: { parts: [{ text: JSON.stringify(entry.value), thought: true }] } }] };
    expect(await entry.call(async () => new Response(JSON.stringify(response)))).toBeNull();
  });
  it("uses only visible generated parts", async () => {
    const response = { candidates: [{ content: { parts: [{ text: '{"private":true}', thought: true }, { text: JSON.stringify(entry.value) }] } }] };
    expect(await entry.call(async () => new Response(JSON.stringify(response)))).toEqual(entry.value);
  });
  it.each([null, { text: 42 }])("fails closed on malformed generated parts: %j", async invalid => {
    const response = { candidates: [{ content: { parts: [invalid, { text: JSON.stringify(entry.value) }] } }] };
    await expect(entry.call(async () => new Response(JSON.stringify(response)))).resolves.toBeNull();
  });
  it.each([200, 403])("cancels and awaits a stalled %s response body", async status => {
    vi.useFakeTimers(); let controller!: ReadableStreamDefaultController<Uint8Array>; let canceled = false; let settled = false;
    const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel() { canceled = true; } }), { status });
    const pending = entry.call(async () => response, 20).then(value => { settled = true; return value; });
    try {
      await vi.advanceTimersByTimeAsync(25);
      expect(settled).toBe(true); expect(canceled).toBe(true); expect(await pending).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      if (!settled) { controller.enqueue(new TextEncoder().encode(body(entry.value))); controller.close(); }
      else if (!canceled) await response.body?.cancel();
      await pending;
    }
  });
  it("awaits the owned response reader cancellation before returning", async () => {
    vi.useFakeTimers(); let release!: () => void; let cancelStarted = false; let settled = false;
    let controller!: ReadableStreamDefaultController<Uint8Array>; let result: unknown;
    const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel() {
      cancelStarted = true; return new Promise<void>(resolve => { release = resolve; });
    } }));
    const pending = entry.call(async () => response, 20).then(value => { settled = true; return value; });
    try {
      await vi.advanceTimersByTimeAsync(25); expect(cancelStarted).toBe(true); expect(settled).toBe(false);
    } finally {
      if (release) release();
      else { controller.enqueue(new TextEncoder().encode(body(entry.value))); controller.close(); }
      result = await pending;
    }
    expect(result).toBeNull();
  });
  it("returns unknown for noncancellable injected headers and closes a late body", async () => {
    vi.useFakeTimers(); let release!: (response: Response) => void; let settled = false; let canceled = false;
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise(resolve => { release = resolve; }));
    const pending = entry.call(fetchImpl, 20).then(value => { settled = true; return value; });
    try {
      await vi.advanceTimersByTimeAsync(25); expect(settled).toBe(true); expect(await pending).toBeNull();
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      release(new Response(new ReadableStream({ cancel() { canceled = true; } })));
      await vi.advanceTimersByTimeAsync(0); await pending;
    }
    expect(canceled).toBe(true);
  });
  it("returns an unknown outcome for a noncancellable injected auth client without dispatch", async () => {
    vi.useFakeTimers(); let release!: (token: string) => void; let settled = false;
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(body(entry.value)));
    const pending = entry.call(fetchImpl, 20, { getAccessToken: () => new Promise(resolve => { release = resolve; }) })
      .then(value => { settled = true; return value; });
    try {
      await vi.advanceTimersByTimeAsync(25); expect(settled).toBe(true); expect(await pending).toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally { release("saved-token"); await pending; }
  });
  it("does not dispatch after late authentication before the timer fires", async () => {
    let clock = 0; vi.spyOn(performance, "now").mockImplementation(() => clock);
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(body(entry.value)));
    expect(await entry.call(fetchImpl, 20, { getAccessToken: async () => { clock = 25; return "saved-token"; } })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects a late received body before the timer fires", async () => {
    let clock = 0; vi.spyOn(performance, "now").mockImplementation(() => clock);
    expect(await entry.call(async () => { clock = 25; return new Response(body(entry.value)); }, 20)).toBeNull();
  });
  it.each([0, -1, 0.5, NaN, Infinity, 1_800_001, Number.MAX_SAFE_INTEGER])("rejects invalid budget %s before auth or HTTP", async timeoutMs => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(body(entry.value)));
    const auth = { getAccessToken: vi.fn(async () => "saved-token") };
    expect(await entry.call(fetchImpl, timeoutMs, auth)).toBeNull();
    expect(auth.getAccessToken).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("Video Gemini per-attempt accounting", () => {
  function setup(usageMetadata?: unknown, text = '{"saved":true}') {
    const rows: SpendRow[] = []; const admit = vi.fn(async () => ({ attemptId: "gemini-attempt" }));
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata })));
    const metering = { engine: "vertex" as const, context: { orgId: "org", instanceId: "instance", agentRole: "video_intern" as const, worker: "ideator", bucket: "drafter" },
      budget: { ...unlimitedBudget, adapters: { ...unlimitedBudget.adapters, reserveAttempt: admit } }, recorder: { record: async (row: SpendRow) => { rows.push(row); } } };
    const opts = { project: "", apiKey: "inert", fetchImpl, metering };
    return { rows, admit, fetchImpl, json: createVertexJsonFn(opts) };
  }
  it("rejects monetary admission before HTTP", async () => {
    const s = setup(); s.admit.mockRejectedValue(new BudgetExceededError({ layer: "instance", spent_cents: 0, cap_cents: 0, estimated_cents: 1 }));
    await expect(s.json("system", "prompt")).rejects.toBeInstanceOf(BudgetExceededError);
    expect(s.fetchImpl).not.toHaveBeenCalled(); expect(s.rows).toHaveLength(1);
    expect(s.rows[0]).toMatchObject({ engine: "vertex", worker: "ideator", status: "budget_exceeded" });
  });
  it.each([
    { metadata: { promptTokenCount: 0, candidatesTokenCount: 0 }, basis: "token_estimate" },
    { metadata: undefined, basis: "unknown" }, { metadata: { promptTokenCount: "bad", candidatesTokenCount: 0 }, basis: "unknown" },
  ])("keeps measured zero separate from unknown usage ($basis)", async entry => {
    const s = setup(entry.metadata); expect(await s.json("system", "prompt")).toEqual({ saved: true });
    expect(s.rows).toEqual([expect.objectContaining({ status: "ok", costBasis: entry.basis, cents: 0, attemptId: "gemini-attempt" })]);
  });
  it("records received usage before discarding malformed generated JSON", async () => {
    const s = setup({ promptTokenCount: 100, candidatesTokenCount: 50 }, "malformed JSON");
    expect(await s.json("system", "prompt")).toBeNull();
    expect(s.rows).toEqual([expect.objectContaining({ status: "ok", inputTokens: 100, outputTokens: 50, costBasis: "token_estimate" })]);
  });
  it("records an ordinary HTTP failure once while keeping the existing null outcome", async () => {
    const s = setup(); s.fetchImpl.mockRejectedValue(new Error("inert network failure"));
