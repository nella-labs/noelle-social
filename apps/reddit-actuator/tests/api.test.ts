import { describe, it, expect, vi } from "vitest";
import { createServer } from "node:http";
import { setTimeout as nativeDelay } from "node:timers/promises";
import { ActuatorApi, readCapturedReply } from "../src/lib/api.js";
import type { ActuatorConfig } from "../src/lib/types.js";

const config: ActuatorConfig = {
  apiBaseUrl: "https://api.test",
  token: "tok",
  instanceId: "inst-1",
  caps: { likes: 0, comments: 8, dms: 0 }, // likes/dms inert on Reddit
  preferWatchlistRatio: 0,
  deepNightTaper: false,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// A reply that targets the source POST.
const postReply = {
  approval_id: "11111111-1111-1111-1111-111111111111",
  draft_id: "22222222-2222-2222-2222-222222222222",
  lead_id: "33333333-3333-3333-3333-333333333333",
  kind: "reply" as const,
  body: "great breakdown, thanks for sharing",
  target: {
    type: "post" as const,
    url: "https://www.reddit.com/r/SaaS/comments/abc123/how-we-hit-10k-mrr/",
    post_id: "abc123",
    subreddit: "SaaS",
    author: "founder_jane",
  },
};

// A reply that targets a specific COMMENT (the most-upvoted one).
const commentReply = {
  approval_id: "44444444-4444-4444-4444-444444444444",
  draft_id: "55555555-5555-5555-5555-555555555555",
  lead_id: "66666666-6666-6666-6666-666666666666",
  kind: "reply" as const,
  body: "this matches my experience too",
  target: {
    type: "comment" as const,
    url: "https://www.reddit.com/r/SaaS/comments/abc123/how-we-hit-10k-mrr/def456/",
    post_id: "abc123",
    comment_id: "def456",
    subreddit: "SaaS",
    author: "commenter_bob",
  },
};

describe("ActuatorApi (Reddit)", () => {
  it.each([
    { url: "https://www.reddit.com/r/SaaS/comments/other9/title/def456/" },
    { comment_id: "other9" },
    { subreddit: "Other" },
  ])("withholds an engine queue with contradictory target metadata %j", async change => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ replies: [
      { ...commentReply, target: { ...commentReply.target, ...change } },
    ] }));
    await expect(new ActuatorApi(config, fetchImpl).fetchQueue()).rejects.toThrow();
  });
  it("fetchQueue hits /api/actionable-reddit and adapts { replies } → { comments (post+comment targets), dms:[] }", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ replies: [postReply, commentReply] }));
    const api = new ActuatorApi(config, fetchImpl as unknown as typeof fetch);
    const out = await api.fetchQueue();
    expect(out.dms).toEqual([]); // Reddit is reply-only — never any DMs
    expect(out.comments).toEqual([
      {
        capturedReply: postReply,
        approval_id: postReply.approval_id,
        draft_id: postReply.draft_id,
        body: postReply.body,
        target: { url: postReply.target.url, type: "post", commentId: undefined },
      },
      {
        capturedReply: commentReply,
        approval_id: commentReply.approval_id,
        draft_id: commentReply.draft_id,
        body: commentReply.body,
        target: { url: commentReply.target.url, type: "comment", commentId: "def456" },
      },
    ]);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.test/api/actionable-reddit?instanceId=inst-1");
    expect(init!.headers).toMatchObject({ authorization: "Bearer tok" });
  });

  it("fetchQueue rejects a malformed reply (schema validation)", async () => {
    // A comment target missing its required comment_id must not pass through.
    const bad = { ...commentReply, target: { ...commentReply.target, comment_id: undefined } };
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ replies: [bad] }));
    const api = new ActuatorApi(config, fetchImpl as unknown as typeof fetch);
    await expect(api.fetchQueue()).rejects.toThrow();
  });

  it("markSent POSTs to the generic actuator mark-sent with sent_via=extension", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ status: "sent" }));
    const api = new ActuatorApi(config, fetchImpl as unknown as typeof fetch);
    await api.markSent("approval-9");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.test/api/actuator/mark-sent/approval-9");
    expect(JSON.parse(init!.body as string)).toEqual({ sent_via: "extension" });
  });

  it("logActivity POSTs reply/skip events to /api/reddit-activity (no vote events exist)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ inserted: 1 }));
    const api = new ActuatorApi(config, fetchImpl as unknown as typeof fetch);
    await api.logActivity("77777777-7777-7777-7777-777777777777", [
      { type: "reply", approval_id: commentReply.approval_id, comment_id: "def456", at: "2026-07-11T20:00:00.000Z" },
    ]);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.test/api/reddit-activity");
    expect(JSON.parse(init!.body as string)).toMatchObject({ session_id: "77777777-7777-7777-7777-777777777777" });
  });

  it("logActivity is a no-op with zero events (never calls fetch)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ inserted: 0 }));
    const api = new ActuatorApi(config, fetchImpl as unknown as typeof fetch);
    await api.logActivity("77777777-7777-7777-7777-777777777777", []);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("enableSend POSTs {instanceId, enabled} to the enable-send route", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true, instanceId: "inst-1", reply_send_enabled: true }));
    const api = new ActuatorApi(config, fetchImpl as unknown as typeof fetch);
    await api.enableSend("inst-1", true);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.test/api/actuator/enable-send");
    expect(init!.method).toBe("POST");
    expect(init!.headers).toMatchObject({ authorization: "Bearer tok" });
    expect(JSON.parse(init!.body as string)).toEqual({ instanceId: "inst-1", enabled: true });
  });

  it("enableSend surfaces the server-reported prior flag value (transition-aware arming)", async () => {
    // prior=false → this enable performed the OFF→ON transition (the caller may arm).
    const wasOff = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true, instanceId: "inst-1", reply_send_enabled: true, prior: false }));
    expect(await new ActuatorApi(config, wasOff as unknown as typeof fetch).enableSend("inst-1", true)).toEqual({ prior: false });
    // prior=true → the flag was ALREADY ON (the operator's standing dashboard
    // consent) — the caller must NOT arm, so run end never disarms it.
    const wasOn = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true, instanceId: "inst-1", reply_send_enabled: true, prior: true }));
    expect(await new ActuatorApi(config, wasOn as unknown as typeof fetch).enableSend("inst-1", true)).toEqual({ prior: true });
  });

  it("enableSend against an OLD server (no/invalid prior) reports prior undefined — callers never disarm on uncertainty", async () => {
    // Older api-vm: 2xx but no prior field.
    const noPrior = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true, instanceId: "inst-1", reply_send_enabled: true }));
    expect((await new ActuatorApi(config, noPrior as unknown as typeof fetch).enableSend("inst-1", true)).prior).toBeUndefined();
    // Defensive: a non-boolean prior or an unparseable body also collapse to undefined.
    const badPrior = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true, prior: "yes" }));
    expect((await new ActuatorApi(config, badPrior as unknown as typeof fetch).enableSend("inst-1", true)).prior).toBeUndefined();
    const notJson = vi.fn<typeof fetch>(async () => new Response("ok", { status: 200 }));
    expect((await new ActuatorApi(config, notJson as unknown as typeof fetch).enableSend("inst-1", true)).prior).toBeUndefined();
  });

  it("enableSend throws on non-2xx (callers decide fatal vs best-effort)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ error: "not found" }, 404));
    const api = new ActuatorApi(config, fetchImpl as unknown as typeof fetch);
    await expect(api.enableSend("inst-1", false)).rejects.toThrow();
  });

  it("throws on non-2xx", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ error: "x" }, 500));
    const api = new ActuatorApi(config, fetchImpl as unknown as typeof fetch);
    await expect(api.markSent("d")).rejects.toThrow();
  });

  it("health GETs /api/actuator/reddit-health with the bearer header and parses status", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ status: "ok" }));
    const api = new ActuatorApi(config, fetchImpl as unknown as typeof fetch);
    const out = await api.health();
    expect(out).toEqual({ status: "ok" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.test/api/actuator/reddit-health");
    expect(init!.headers).toMatchObject({ authorization: "Bearer tok" });
  });

  it("health rejects on non-2xx (drives the caller's fail-closed .catch)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ error: "down" }, 503));
    const api = new ActuatorApi(config, fetchImpl as unknown as typeof fetch);
    await expect(api.health()).rejects.toThrow();
  });

  it("default fetch is bound to the global scope (avoids 'Illegal invocation')", async () => {
    const original = globalThis.fetch;
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({}));
    globalThis.fetch = fetchImpl;
    try {
      const api = new ActuatorApi(config); // no fetchImpl → exercises the default
      await api.markSent("d");
      expect(fetchImpl.mock.contexts).toEqual([globalThis]);
    } finally {
      globalThis.fetch = original;
    }
  });
});


describe("Reddit claim transport", () => {
