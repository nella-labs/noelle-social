import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { signContentRequest, pushPostIdeas, pushPostDraft, resolveContentMedia } from "./contentPush.js";

const SECRET = "0123456789abcdef0123456789abcdef"; // ≥32 chars
const IDEA = "00000000-0000-4000-8000-000000000001";
const SECOND_IDEA = "00000000-0000-4000-8000-000000000002";
const DRAFT = "00000000-0000-4000-8000-000000000003";

describe("signContentRequest", () => {
  it("matches the api-vm hmac scheme: sha256(`${ts}.${body}`)", () => {
    const body = '{"a":1}';
    const { timestamp, signature } = signContentRequest(SECRET, body, 1000);
    expect(timestamp).toBe("1000");
    const expected = `sha256=${createHmac("sha256", SECRET).update(`1000.${body}`).digest("hex")}`;
    expect(signature).toBe(expected);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
});

describe("pushPostIdeas", () => {
  it("POSTs /api/post-ideas with signed headers and parses idea_ids", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ idea_ids: [IDEA, SECOND_IDEA] }));
    }) as unknown as typeof fetch;

    const out = await pushPostIdeas({
      apiUrl: "http://127.0.0.1:18791",
      hmacSecret: SECRET,
      platform: "linkedin",
      ideas: [{ id: IDEA, platform: "linkedin", hook: "h" }, { id: SECOND_IDEA, platform: "linkedin", hook: "second" }],
      fetchImpl,
      nowSeconds: 1000,
    });

    expect(out.idea_ids).toEqual([IDEA, SECOND_IDEA]);
    expect(calls[0]!.url).toBe("http://127.0.0.1:18791/api/post-ideas");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["x-noelle-timestamp"]).toBe("1000");
    expect(headers["x-noelle-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    // The signed body is exactly what was sent.
    const body = calls[0]!.init.body as string;
    const expectedSig = `sha256=${createHmac("sha256", SECRET).update(`1000.${body}`).digest("hex")}`;
    expect(headers["x-noelle-signature"]).toBe(expectedSig);
  });

  it("throws with status + detail on a non-ok response", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: "bad_signature" }), { status: 401 })) as typeof fetch;
    await expect(
      pushPostIdeas({
        apiUrl: "http://x",
        hmacSecret: SECRET,
        platform: "x",
        ideas: [{ id: IDEA, platform: "x", hook: "h" }],
        fetchImpl,
        nowSeconds: 1,
      }),
    ).rejects.toThrow(/401.*bad_signature/);
  });
});

describe("pushPostDraft", () => {
  it("POSTs /api/post-drafts and returns the ids", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ draft_id: DRAFT, idea_id: IDEA }))) as typeof fetch;
    const out = await pushPostDraft({
      apiUrl: "http://127.0.0.1:18791",
      hmacSecret: SECRET,
      draft: { ideaId: IDEA, platform: "x", body: "post body", charCount: 9 },
      fetchImpl,
      nowSeconds: 1,
    });
    expect(out).toEqual({ draft_id: DRAFT, idea_id: IDEA });
  });
});


describe("resolveContentMedia", () => {
  it("binds the actual org/instance and signs the exact bounded read request", async () => {
    let init!: RequestInit;
    const fetchImpl: typeof fetch = async (url, options) => {
      expect(String(url)).toBe("http://fixture.invalid/api/content-media/resolve-worker"); init = options!;
      return Response.json({ media: [{ id: DRAFT, url: "https://storage.googleapis.com/fixture/fresh" }] });
    };
    expect(await resolveContentMedia({ apiUrl: "http://fixture.invalid", hmacSecret: SECRET, nowSeconds: 1000,
      orgId: IDEA, agentInstanceId: SECOND_IDEA, ids: [DRAFT], fetchImpl })).toEqual([{ id: DRAFT, url: "https://storage.googleapis.com/fixture/fresh" }]);
    expect(JSON.parse(String(init.body))).toEqual({ orgId: IDEA, agentInstanceId: SECOND_IDEA, ids: [DRAFT] });
    expect(new Headers(init.headers).get("x-noelle-signature")).toBe(signContentRequest(SECRET, String(init.body), 1000).signature);
  });
  it("rejects a response for another media ID without retrying the read", async () => {
    let calls = 0;
    await expect(resolveContentMedia({ apiUrl: "http://fixture.invalid", hmacSecret: SECRET, orgId: IDEA,
      agentInstanceId: SECOND_IDEA, ids: [DRAFT], fetchImpl: async () => {
        calls++; return Response.json({ media: [{ id: IDEA, url: null }] });
      } })).rejects.toThrow("invalid asset receipt"); expect(calls).toBe(1);
  });
});
