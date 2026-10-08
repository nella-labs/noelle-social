import { describe, expect, it } from "vitest";
import { createGeminiKeyBackend } from "./geminiKeyBackend.js";
import { createVertexBackend } from "./vertexBackend.js";
import { callAgentModel, unlimitedBudget } from "./callAgentModel.js";
import type { SpendRow } from "./spendRecorder.js";

const factories = {
  key: (fetchImpl: typeof fetch) => createGeminiKeyBackend({ apiKey: "test", fetchImpl }),
  vertex: (fetchImpl: typeof fetch) => createVertexBackend({ authClient: { getAccessToken: async () => "test" }, fetchImpl }),
};
const call = { system: "system", prompt: "prompt", model: "gemini-2-5-flash" };
const candidates = [{ content: { parts: [{ text: "response" }] } }];

describe.each(Object.entries(factories))("%s generation receipts", (_name, factory) => {
  it("honors the per-call deadline through a stalled response body", async () => {
    let canceled = false;
    const backend = factory(async () => new Response(new ReadableStream({ cancel() { canceled = true; } })));
    await expect(backend.call({ ...call, timeoutMs: 20 })).rejects.toThrow(/timed out/);
    expect(canceled).toBe(true);
  });

  it("preserves known rejection status even when its error body exceeds the bound", async () => {
    const backend = factory(async () => new Response("x".repeat(4 * 1024 * 1024 + 1), { status: 403 }));
    await expect(backend.call(call)).rejects.toMatchObject({ status: 403, name: _name === "key" ? "GeminiKeyAuthError" : "VertexAuthError" });
  });

  it("does not include thought parts in generated output", async () => {
    const result = await factory(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [
      { text: "internal reasoning", thought: true }, { text: "response" },
    ] } }] }))).call(call);
    expect(result.text).toBe("response");
  });

  it.each([undefined, {}, { promptTokenCount: 10 }, { promptTokenCount: -1, candidatesTokenCount: 2 },
    { promptTokenCount: "1", candidatesTokenCount: 2 }, { promptTokenCount: 1.5, candidatesTokenCount: 2 }])
    ("preserves missing or invalid token metadata as unknown: %j", async (usageMetadata) => {
      const backend = factory(async () => new Response(JSON.stringify({ candidates, usageMetadata })));
      const result = await backend.call(call);
      expect(result.text).toBe("response");
      expect(result.usage.token_usage_reported).toBe(false);
    });

  it("preserves validated zero token counts", async () => {
    const result = await factory(async () => new Response(JSON.stringify({ candidates,
      usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 } }))).call(call);
    expect(result.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
});

it("records a successful Vertex response without usage as unknown accounting", async () => {
  const rows: SpendRow[] = [];
  const vertex = factories.vertex(async () => new Response(JSON.stringify({ candidates })));
  const result = await callAgentModel({ orgId: "org", instanceId: "instance", agentRole: "x_intern", worker: "drafter",
    bucket: "drafter", ...call, routing: { primary: { engine: "vertex", model: "gemini-2-5-flash" } }, directRouting: true,
  }, { engines: { vertex }, budget: unlimitedBudget, recorder: { record: async (row) => { rows.push(row); } } });
  expect(result.text).toBe("response");
  expect(rows).toEqual([expect.objectContaining({ status: "ok", cents: 0, costBasis: "unknown" })]);
});
