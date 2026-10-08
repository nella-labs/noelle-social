import { pngImageBytes } from "../imageBytes.fixture.js";
import { describe, expect, it, vi } from "vitest";
import { BudgetExceededError, type CapAdapters } from "../budgetBucket.js";
import { PgOperationError } from "../boundedPgSession.js";
import { type SpendRow } from "../spendRecorder.js";
import { captionImages, createBedrockCaptionFn, createGeminiCaptionFn, createVertexCaptionFn } from "./visionCaption.js";

const context = { orgId: "org", instanceId: "instance", agentRole: "x_intern" as const,
  worker: "drafter", bucket: "vision_caption" };
const exceeded = new BudgetExceededError({ layer: "instance", spent_cents: 1, cap_cents: 1, estimated_cents: 1 });

function setup(kind: "key" | "vertex" | "bedrock", error?: Error, missingUsage = false) {
  const rows: SpendRow[] = [];
  const reserveAttempt = vi.fn(async () => { if (error) throw error; return { attemptId: "attempt" }; });
  const adapters: CapAdapters = { reserveAttempt,
    fetchSpend: async () => ({ bucket: 0, org: 0, instance: 0 }),
    fetchCaps: async () => ({ bucket: 100, org: 100, instance: 100 }) };
  const metering = { context, budget: { adapters }, recorder: { record: async (row: SpendRow) => { rows.push(row); } } };
  const paid = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "caption" }] } }],
    ...(!missingUsage ? { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 } } : {}) })));
  const fetchImpl: typeof fetch = async (input) => String(input).startsWith("https://image.test")
    ? new Response(pngImageBytes(), { headers: { "content-type": "image/png" } }) : paid();
  const create = vi.fn(async () => ({ content: [{ type: "text", text: "caption" }],
    ...(!missingUsage ? { usage: { input_tokens: 100, output_tokens: 20 } } : {}) }));
  const captionFn = kind === "key" ? createGeminiCaptionFn({ apiKey: "test", fetchImpl, ...{ metering } })
    : kind === "vertex" ? createVertexCaptionFn({ project: "test", fetchImpl,
      authClient: { getAccessToken: async () => "test" }, ...{ metering } })
    : createBedrockCaptionFn({ fetchImpl, clientImpl: { create }, ...{ metering } });
  return { captionFn, rows, reserveAttempt, paid: kind === "bedrock" ? create : paid };
}

describe.each(["key", "vertex", "bedrock"] as const)("%s caption metering", (kind) => {
  it("admits before paid dispatch and records coherent confirmed usage", async () => {
    const s = setup(kind);
    expect(await s.captionFn(["https://image.test/a.jpg"], {})).toBe("caption");
    expect(s.reserveAttempt).toHaveBeenCalledTimes(1);
    expect(s.reserveAttempt.mock.invocationCallOrder[0]).toBeLessThan(s.paid.mock.invocationCallOrder[0]!);
    expect(s.rows).toEqual([expect.objectContaining({ ...context, attemptId: "attempt", inputTokens: 100,
      outputTokens: 20, costBasis: "token_estimate", status: "ok" })]);
  });

  it("propagates rejected admission through optional image context without paid dispatch", async () => {
    const s = setup(kind, exceeded);
    await expect(captionImages({ imageUrls: ["https://image.test/a.jpg"], captionFn: s.captionFn })).rejects.toBe(exceeded);
    expect(s.paid).not.toHaveBeenCalled();
    expect(s.rows).toEqual([expect.objectContaining({ status: "budget_exceeded", costBasis: "not_dispatched" })]);
  });

  it("retains missing successful usage as an unknown attempt receipt", async () => {
    const s = setup(kind, undefined, true);
    expect(await s.captionFn(["https://image.test/a.jpg"], {})).toBe("caption");
    expect(s.rows).toEqual([expect.objectContaining({ attemptId: "attempt", status: "ok", cents: 0, costBasis: "unknown" })]);
  });

  it("propagates admission database failure without pretending the provider failed", async () => {
    const error = new PgOperationError("database");
    const s = setup(kind, error);
    await expect(captionImages({ imageUrls: ["https://image.test/a.jpg"], captionFn: s.captionFn })).rejects.toBe(error);
    expect(s.paid).not.toHaveBeenCalled();
    expect(s.rows).toEqual([]);
  });
});
