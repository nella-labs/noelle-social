import { describe, it, expect } from "vitest";
import { pushContent } from "./content-push.js";

const SECRET = "0123456789abcdef0123456789abcdef";
const U = "11111111-1111-1111-1111-111111111111";
const DRAFT = "00000000-0000-4000-8000-000000000002";

function fakeFetch(capture: { url?: string; body?: string }, response: unknown) {
  return (async (url: string, init: RequestInit) => {
    capture.url = url;
    capture.body = init.body as string;
    return new Response(JSON.stringify(response));
  }) as unknown as typeof fetch;
}

describe("pushContent — ideas", () => {
  it("wraps a bare ideas array with the --platform flag", async () => {
    const cap: { url?: string; body?: string } = {};
    const out = await pushContent({
      kind: "ideas",
      platform: "x",
      payload: [{ id: U, platform: "x", hook: "ship logs > standups" }],
      deps: { apiUrl: "http://h", hmacSecret: SECRET, fetchImpl: fakeFetch(cap, { idea_ids: [U] }) },
    });
    expect(out.result).toEqual({ idea_ids: [U] });
    expect(cap.url).toBe("http://h/api/post-ideas");
    expect(JSON.parse(cap.body!).platform).toBe("x");
  });

  it("--platform rewrites EVERY idea's platform (not just the wrapper)", async () => {
    const cap: { url?: string; body?: string } = {};
    await pushContent({
      kind: "ideas",
      platform: "x",
      // idea carries linkedin; the flag must coerce it to x so the batch is
      // consistent (the contract refine would otherwise reject it).
      payload: [{ id: U, platform: "linkedin", hook: "h" }],
      deps: { apiUrl: "http://h", hmacSecret: SECRET, fetchImpl: fakeFetch(cap, { idea_ids: [U] }) },
    });
    const sent = JSON.parse(cap.body!);
    expect(sent.platform).toBe("x");
    expect(sent.ideas[0].platform).toBe("x");
  });

  it("accepts a full { platform, ideas } object", async () => {
    const cap: { url?: string; body?: string } = {};
    await pushContent({
      kind: "ideas",
      payload: { platform: "linkedin", ideas: [{ id: U, platform: "linkedin", hook: "h" }] },
      deps: { apiUrl: "http://h", hmacSecret: SECRET, fetchImpl: fakeFetch(cap, { idea_ids: [U] }) },
    });
    expect(JSON.parse(cap.body!).platform).toBe("linkedin");
  });

  it("throws when a bare array has no platform", async () => {
    await expect(
      pushContent({
        kind: "ideas",
        payload: [{ id: "1", platform: "linkedin", hook: "h" }],
        deps: { apiUrl: "http://h", hmacSecret: SECRET, fetchImpl: fakeFetch({}, {}) },
      }),
    ).rejects.toThrow(/platform is required/);
  });

  it("rejects a payload that fails contract validation", async () => {
    await expect(
      pushContent({
        kind: "ideas",
        platform: "linkedin",
        payload: [{ id: "1" /* missing hook */ }],
        deps: { apiUrl: "http://h", hmacSecret: SECRET, fetchImpl: fakeFetch({}, {}) },
      }),
    ).rejects.toThrow();
  });
});

describe("pushContent — draft", () => {
  it("posts a single draft and applies the --platform override", async () => {
    const cap: { url?: string; body?: string } = {};
    const out = await pushContent({
      kind: "draft",
      platform: "reddit",
      payload: {
        ideaId: "11111111-1111-1111-1111-111111111111",
        platform: "linkedin",
        body: "the post",
        charCount: 8,
      },
      deps: { apiUrl: "http://h", hmacSecret: SECRET, fetchImpl: fakeFetch(cap, { draft_id: DRAFT, idea_id: U }) },
    });
    expect(out.result).toEqual({ draft_id: DRAFT, idea_id: U });
    expect(cap.url).toBe("http://h/api/post-drafts");
    expect(JSON.parse(cap.body!).platform).toBe("reddit"); // flag overrode payload
  });
});
