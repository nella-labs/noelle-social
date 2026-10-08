import { beforeEach, describe, expect, it, vi } from "vitest";
const auth = vi.hoisted(() => ({ getAccessToken: vi.fn() }));
vi.mock("./googleCredentials.js", () => ({ defaultGoogleCredentialClient: () => auth }));
vi.mock("google-auth-library", () => ({ GoogleAuth: class { async getAccessToken() { return "legacy-token"; } } }));
import { createVertexBackend } from "./vertexBackend.js";
import { createVertexCaptionFn } from "./drafting/visionCaption.js";
beforeEach(() => { auth.getAccessToken.mockReset(); });
const generation = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "context" }] } }] }));
describe("default Google credential consumers", () => {
  it("prevents Vertex generation after owned credential failure", async () => {
    auth.getAccessToken.mockRejectedValue(new Error("Google credential token timeout"));
    let dispatches = 0;
    const backend = createVertexBackend({ fetchImpl: async () => { dispatches++; return generation(); } });
    await expect(backend.call({ system: "", prompt: "", model: "gemini-2-5-flash" })).rejects.toMatchObject({ name: "VertexAuthError" });
    expect(dispatches).toBe(0);
  });
  it("keeps a caption credential failure optional without downloading or generating", async () => {
    auth.getAccessToken.mockRejectedValue(new Error("Google credential token timeout"));
    let dispatches = 0;
    const caption = createVertexCaptionFn({ project: "fixture", fetchImpl: async () => { dispatches++; return generation(); } });
    expect(await caption(["https://images.invalid/image.png"], {})).toBe(""); expect(dispatches).toBe(0);
  });
  it("uses the owned token on successful generation and preserves explicit injection", async () => {
    auth.getAccessToken.mockResolvedValue("owned-token"); const tokens: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => { tokens.push(new Headers(init?.headers).get("authorization") ?? ""); return generation(); };
    await createVertexBackend({ fetchImpl }).call({ system: "", prompt: "", model: "gemini-2-5-flash" });
    await createVertexBackend({ fetchImpl, authClient: { getAccessToken: async () => "injected-token" } }).call({ system: "", prompt: "", model: "gemini-2-5-flash" });
    expect(tokens).toEqual(["Bearer owned-token", "Bearer injected-token"]);
  });
});
