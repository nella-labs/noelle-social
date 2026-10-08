import { describe, expect, it } from "vitest";
import {
  createVertexBackend,
  VertexAuthError,
  VertexError,
} from "./vertexBackend.js";

const authStub = { getAccessToken: async () => "fake-token" };
const noTokenAuth = { getAccessToken: async () => null };
const failingAuth = {
  getAccessToken: async () => {
    throw new Error("ADC unavailable");
  },
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("createVertexBackend", () => {
  it("posts to v1 generateContent with Bearer + systemInstruction + contents", async () => {
    let capturedUrl = "";
    let capturedAuth: string | null = null;
    let capturedBody: unknown = null;
    const be = createVertexBackend({
      authClient: authStub,
      project: "noelle-agents",
      location: "us-central1",
      fetchImpl: async (url, init) => {
        capturedUrl = String(url);
        const headers = new Headers(init?.headers as HeadersInit);
        capturedAuth = headers.get("authorization");
        capturedBody = JSON.parse(String(init?.body ?? "null"));
        return jsonResponse({
          candidates: [{ content: { parts: [{ text: "hi from vertex" }] } }],
          usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5 },
        });
      },
    });

    const res = await be.call({
      system: "you are a writer",
      prompt: "draft a tweet",
      model: "gemini-2-5-pro",
    });

    expect(res).toEqual({
      text: "hi from vertex",
      usage: { input_tokens: 12, output_tokens: 5 },
    });
    expect(capturedAuth).toBe("Bearer fake-token");
    expect(capturedUrl).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/noelle-agents/locations/us-central1/publishers/google/models/gemini-2.5-pro:generateContent",
    );
    expect(capturedBody).toEqual({
      systemInstruction: { parts: [{ text: "you are a writer" }] },
      contents: [{ role: "user", parts: [{ text: "draft a tweet" }] }],
      generationConfig: { maxOutputTokens: 4096 },
    });
  });

  it("maps dashed catalog handles to Vertex dotted model names", async () => {
    const urls: string[] = [];
    const be = createVertexBackend({
      authClient: authStub,
      fetchImpl: async (url) => {
        urls.push(String(url));
        return jsonResponse({
          candidates: [{ content: { parts: [{ text: "ok" }] } }],
        });
      },
    });
    for (const handle of ["gemini-2-5-pro", "gemini-2-5-flash", "gemini-2-flash"]) {
      await be.call({ system: "", prompt: "", model: handle });
    }
    expect(urls[0]).toContain("/models/gemini-2.5-pro:generateContent");
    expect(urls[1]).toContain("/models/gemini-2.5-flash:generateContent");
    expect(urls[2]).toContain("/models/gemini-2.0-flash:generateContent");
  });

  it("falls back to noelle-agents when no project is configured", async () => {
    delete process.env["GOOGLE_CLOUD_PROJECT"];
    delete process.env["GCP_PROJECT"];
    let capturedUrl = "";
    const be = createVertexBackend({
      authClient: authStub,
      fetchImpl: async (url) => {
        capturedUrl = String(url);
        return jsonResponse({
          candidates: [{ content: { parts: [{ text: "ok" }] } }],
        });
      },
    });
    await be.call({ system: "", prompt: "", model: "gemini-2-5-pro" });
    expect(capturedUrl).toContain("/projects/noelle-agents/");
  });

  it("throws VertexAuthError on 401, 403, missing token, and ADC failure", async () => {
    const be401 = createVertexBackend({
      authClient: authStub,
      fetchImpl: async () => new Response("nope", { status: 401 }),
    });
    await expect(
      be401.call({ system: "", prompt: "", model: "gemini-2-5-pro" }),
    ).rejects.toBeInstanceOf(VertexAuthError);

    const be403 = createVertexBackend({
      authClient: authStub,
      fetchImpl: async () => new Response("nope", { status: 403 }),
    });
    await expect(
      be403.call({ system: "", prompt: "", model: "gemini-2-5-pro" }),
    ).rejects.toBeInstanceOf(VertexAuthError);

    const beNoToken = createVertexBackend({
      authClient: noTokenAuth,
      fetchImpl: async () => jsonResponse({}),
    });
    await expect(
      beNoToken.call({ system: "", prompt: "", model: "gemini-2-5-pro" }),
    ).rejects.toBeInstanceOf(VertexAuthError);

    const beAuthThrow = createVertexBackend({
      authClient: failingAuth,
      fetchImpl: async () => jsonResponse({}),
    });
    await expect(
      beAuthThrow.call({ system: "", prompt: "", model: "gemini-2-5-pro" }),
    ).rejects.toBeInstanceOf(VertexAuthError);
  });

  it("throws VertexError (not VertexAuthError) on non-auth 5xx", async () => {
    const be = createVertexBackend({
      authClient: authStub,
      fetchImpl: async () => new Response("server boom", { status: 500 }),
    });
    await expect(
      be.call({ system: "", prompt: "", model: "gemini-2-5-pro" }),
    ).rejects.toMatchObject({ status: 500, name: "VertexError" });
  });

  it("mock mode short-circuits the network and never touches auth", async () => {
    const be = createVertexBackend({ mock: true });
    const res = await be.call({
      system: "ignored",
      prompt: "hello world",
      model: "gemini-2-5-pro",
    });
    expect(res.text).toContain("[vertex-mock]");
    expect(res.text).toContain("hello world");
  });

  it("honors GOOGLE_CLOUD_PROJECT env when no constructor project is given", async () => {
    process.env["GOOGLE_CLOUD_PROJECT"] = "some-other-project";
    let capturedUrl = "";
    const be = createVertexBackend({
      authClient: authStub,
      fetchImpl: async (url) => {
        capturedUrl = String(url);
        return jsonResponse({
          candidates: [{ content: { parts: [{ text: "ok" }] } }],
        });
      },
    });
    await be.call({ system: "", prompt: "", model: "gemini-2-5-pro" });
    expect(capturedUrl).toContain("/projects/some-other-project/");
    delete process.env["GOOGLE_CLOUD_PROJECT"];
  });
});
