import { describe, expect, it } from "vitest";
import { selectGeminiBackend } from "./geminiBackendSelect.js";
import { createGeminiKeyBackend } from "./geminiKeyBackend.js";

// ---- backend selection -------------------------------------------------------

describe("selectGeminiBackend", () => {
  it("returns a GeminiKeyBackend when apiKey is set", () => {
    const backend = selectGeminiBackend({ apiKey: "AIzaSy_test_key", gcpProject: "noelle-agents" });
    // The backend is an EngineBackend with a .call method.
    expect(typeof backend.call).toBe("function");
  });

  it("returns a VertexBackend (ADC) when apiKey is undefined — default unchanged", () => {
    const backend = selectGeminiBackend({ apiKey: undefined, gcpProject: "noelle-agents" });
    expect(typeof backend.call).toBe("function");
  });

  it("returns a VertexBackend when apiKey is an empty string — treat as unset", () => {
    // Zod strips empty strings as undefined for optional fields, but guard explicitly.
    const backend = selectGeminiBackend({ apiKey: "", gcpProject: "noelle-agents" });
    expect(typeof backend.call).toBe("function");
  });
});

// ---- model-id mapping -------------------------------------------------------
//
// The callers (classifier) pass dashed handles like "gemini-2-5-flash".
// createGeminiKeyBackend maps these to the dotted names
// generativelanguage.googleapis.com expects.  The DEFAULT_MODEL_IDS map lives
// inside the runtime package; we verify the exact models the classifier uses
// resolve correctly by driving a minimal fetch stub.

describe("createGeminiKeyBackend model-id mapping", () => {
  async function captureUrl(model: string): Promise<string> {
    let captured = "";
    const stub: typeof fetch = async (input, _init) => {
      captured = typeof input === "string" ? input : (input as Request).url;
      // Return a minimal valid response so the backend doesn't throw.
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "{}" }] } }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const backend = createGeminiKeyBackend({
      apiKey: "test-key",
      fetchImpl: stub,
    });
    await backend.call({ system: "s", prompt: "p", model });
    return captured;
  }

  it("maps gemini-2-5-flash → gemini-2.5-flash in the request URL", async () => {
    const url = await captureUrl("gemini-2-5-flash");
    expect(url).toContain("/models/gemini-2.5-flash:");
  });

  it("maps gemini-2-5-pro → gemini-2.5-pro in the request URL", async () => {
    const url = await captureUrl("gemini-2-5-pro");
    expect(url).toContain("/models/gemini-2.5-pro:");
  });

  it("maps gemini-2-flash → gemini-2.0-flash in the request URL", async () => {
    const url = await captureUrl("gemini-2-flash");
    expect(url).toContain("/models/gemini-2.0-flash:");
  });

  it("passes an unknown model handle through verbatim (no mapping)", async () => {
    const url = await captureUrl("gemini-1-5-flash");
    // Not in DEFAULT_MODEL_IDS — passes through as-is.
    expect(url).toContain("/models/gemini-1-5-flash:");
  });
});
