import { describe, expect, it, vi } from "vitest";
import {
  createGeminiKeyBackend,
  GeminiKeyAuthError,
  GeminiKeyError,
} from "./geminiKeyBackend.js";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}

describe("createGeminiKeyBackend", () => {
  it("keeps the timeout active until the response body finishes", async () => {
    let canceled = false;
    let timer: ReturnType<typeof setTimeout>;
    const fetchImpl: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        timer = setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({
            candidates: [{ content: { parts: [{ text: "late" }] } }],
          })));
          controller.close();
        }, 150);
      },
      cancel() { canceled = true; clearTimeout(timer); },
    }));
    const be = createGeminiKeyBackend({ apiKey: "test", timeoutMs: 20, fetchImpl });
    await expect(be.call({ system: "s", prompt: "p", model: "gemini-2-5-flash" }))
      .rejects.toThrow(/timed out|timeout/i);
    expect(canceled).toBe(true);
  });

  it.each(["not-json", "{}", '{"candidates":[{"content":{"parts":[{"text":{}}]}}]}'])
    ("rejects an invalid success response: %s", async (body) => {
      const be = createGeminiKeyBackend({ apiKey: "test",
        fetchImpl: async () => new Response(body) });
      await expect(be.call({ system: "s", prompt: "p", model: "gemini-2-5-flash" }))
        .rejects.toBeInstanceOf(GeminiKeyError);
    });

  it("calls the AI Studio endpoint with the key and returns text + usage", async () => {
    let calledUrl = "";
    const fetchImpl = vi.fn(async (url: string) => {
      calledUrl = url;
      return jsonResponse({
        candidates: [{ content: { parts: [{ text: "hi from gemini" }] } }],
        usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7 },
      });
    });
    const be = createGeminiKeyBackend({
      apiKey: "AIzaTEST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await be.call({ system: "s", prompt: "p", model: "gemini-2-5-flash" });
    expect(out).toEqual({ text: "hi from gemini", usage: { input_tokens: 11, output_tokens: 7 } });
    // dashed handle mapped to dotted; key in querystring
    expect(calledUrl).toContain("/models/gemini-2.5-flash:generateContent");
    expect(calledUrl).toContain("key=AIzaTEST");
  });

  it("throws GeminiKeyAuthError on 401/403", async () => {
    const be401 = createGeminiKeyBackend({
      apiKey: "k",
      fetchImpl: (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch,
    });
    await expect(be401.call({ system: "s", prompt: "p", model: "gemini-2-5-flash" })).rejects.toBeInstanceOf(GeminiKeyAuthError);

    const be403 = createGeminiKeyBackend({
      apiKey: "k",
      fetchImpl: (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch,
    });
    await expect(be403.call({ system: "s", prompt: "p", model: "gemini-2-5-flash" })).rejects.toBeInstanceOf(GeminiKeyAuthError);
  });

  it("throws GeminiKeyError (not auth) on a 500", async () => {
    const be = createGeminiKeyBackend({
      apiKey: "k",
      fetchImpl: (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch,
    });
    await expect(
      be.call({ system: "s", prompt: "p", model: "gemini-2-5-flash" }),
    ).rejects.toMatchObject({ status: 500, name: "GeminiKeyError" });
  });
});
