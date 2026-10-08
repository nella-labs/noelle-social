import { describe, expect, it } from "vitest";
import { createOutboundClient } from "./outboundClient.js";
import { pushPostDraft, pushPostIdeas } from "./contentPush.js";
import { sendPushover, PushoverError } from "./pushoverClient.js";
import type { OutboundIn } from "@noelle/contracts";

const IDEA = "00000000-0000-4000-8000-000000000001";
const DRAFT = "00000000-0000-4000-8000-000000000002";
const base = { apiUrl: "https://example.test", hmacSecret: "test".repeat(8) };
const outbound: OutboundIn = {
  leadId: "lead", batchNumber: null, platform: "x", authorHandle: "author", authorId: "author",
  authorFollowers: 0, allowsDms: false, originalPostId: "1", originalPostText: "post",
  originalPostUrl: "https://example.test/1", postedAt: null, matchedTrigger: null,
  drafts: [{ id: "draft", kind: "reply", angle: "empathetic", body: "response", charCount: 8 }],
};
const fetchBody = (value: unknown): typeof fetch => async () => new Response(JSON.stringify(value));

describe("HTTP success receipt validation", () => {
  it.each([{}, { id: "", approval_id: "" }, { id: 12, approval_id: DRAFT }])
    ("rejects an invalid outbound receipt: %j", async (receipt) => {
      const client = createOutboundClient({ baseUrl: base.apiUrl, hmacSecret: base.hmacSecret,
        typoRate: 0, fetchImpl: fetchBody(receipt) });
      await expect(client.postOutbound(outbound)).rejects.toThrow(/receipt|response/i);
    });

  it.each([{}, { idea_ids: [12] }, { idea_ids: [] }, { idea_ids: [DRAFT] }])
    ("requires a coherent complete idea receipt: %j", async (receipt) => {
      await expect(pushPostIdeas({ ...base, platform: "x", ideas: [{ id: IDEA, platform: "x", hook: "hook" }],
        fetchImpl: fetchBody(receipt) })).rejects.toThrow(/receipt|response/i);
    });

  it.each([{}, { draft_id: "", idea_id: IDEA }, { draft_id: DRAFT, idea_id: DRAFT }])
    ("requires the requested idea in a draft receipt: %j", async (receipt) => {
      await expect(pushPostDraft({ ...base, draft: { ideaId: IDEA, platform: "x", body: "post", charCount: 4 },
        fetchImpl: fetchBody(receipt) })).rejects.toThrow(/receipt|response/i);
    });

  it.each([{}, { status: 0, request: "request" }, { status: 1 }, { status: 1, request: "" },
    { status: "1", request: "request" }, { status: 1, request: 12 }])
    ("requires Pushover acceptance and a nonempty request receipt: %j", async (receipt) => {
      await expect(sendPushover({ user: "test", token: "test", title: "title", message: "message" }, fetchBody(receipt)))
        .rejects.toBeInstanceOf(PushoverError);
    });

  it("preserves valid receipts", async () => {
    const fetchImpl = fetchBody({ draft_id: DRAFT, idea_id: IDEA });
    expect(await pushPostDraft({ ...base, draft: { ideaId: IDEA, platform: "x", body: "post", charCount: 4 }, fetchImpl }))
      .toEqual({ draft_id: DRAFT, idea_id: IDEA });
    expect(await sendPushover({ user: "test", token: "test", title: "title", message: "message" }, fetchBody({ status: 1, request: "request" })))
      .toEqual({ status: 1, request: "request" });
  });

  it("recognizes the same UUID after storage canonicalizes its case", async () => {
    const idea = "abcdefab-1111-4111-8111-abcdefabcdef";
    expect(await pushPostDraft({ ...base, draft: { ideaId: idea.toUpperCase(), platform: "x", body: "post", charCount: 4 },
      fetchImpl: fetchBody({ draft_id: DRAFT, idea_id: idea }) })).toEqual({ draft_id: DRAFT, idea_id: idea });
    expect(await pushPostIdeas({ ...base, platform: "x", ideas: [{ id: idea.toUpperCase(), platform: "x", hook: "hook" }],
      fetchImpl: fetchBody({ idea_ids: [idea] }) })).toEqual({ idea_ids: [idea] });
  });

  it.each(["outbound", "ideas", "draft", "notification"] as const)
    ("cancels a stalled %s receipt body at its request deadline", async (kind) => {
      let canceled = false;
      const fetchImpl: typeof fetch = async () => new Response(new ReadableStream({ cancel() { canceled = true; } }));
      const options = { ...base, fetchImpl, timeoutMs: 20 };
      const pending = kind === "outbound" ? createOutboundClient({ baseUrl: base.apiUrl, hmacSecret: base.hmacSecret,
        fetchImpl, timeoutMs: 20, typoRate: 0 }).postOutbound(outbound)
        : kind === "ideas" ? pushPostIdeas({ ...options, platform: "x", ideas: [{ id: IDEA, platform: "x", hook: "hook" }] })
        : kind === "draft" ? pushPostDraft({ ...options, draft: { ideaId: IDEA, platform: "x", body: "post", charCount: 4 } })
        : sendPushover({ user: "test", token: "test", title: "title", message: "message" }, fetchImpl, { timeoutMs: 20 });
      await expect(pending).rejects.toThrow(/timed out/);
      expect(canceled).toBe(true);
    });
});
