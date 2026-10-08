import { describe, expect, it, vi } from "vitest";
import { createOutboundClient } from "./outboundClient.js";
import type { OutboundIn } from "@noelle/contracts";
import { createHmac } from "node:crypto";
const RECEIPT_ID = "00000000-0000-4000-8000-000000000001";

const BASE: Omit<OutboundIn, "drafts"> = {
  leadId: "L",
  batchNumber: null,
  platform: "x",
  authorHandle: "u",
  authorId: "uid",
  authorFollowers: 100,
  allowsDms: true,
  originalPostId: "1",
  originalPostText: "hi",
  originalPostUrl: "https://x.com/u/status/1",
  postedAt: "2026-05-18T00:00:00.000Z",
  matchedTrigger: null,
};

describe("outbound client", () => {
  it("signs the request with sha256=hex", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const h = new Headers(init.headers);
      expect(h.get("x-noelle-signature")).toMatch(/^sha256=[0-9a-f]{64}$/);
      expect(h.get("x-noelle-timestamp")).toMatch(/^\d+$/);
      return new Response(JSON.stringify({ id: RECEIPT_ID, approval_id: RECEIPT_ID }), { status: 200 });
    });
    const c = createOutboundClient({
      baseUrl: "https://api.trynoelle.com",
      hmacSecret: "x".repeat(32),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const res = await c.postOutbound({
      ...BASE,
      drafts: [{ id: "d1", kind: "reply", angle: "empathetic", body: "ok", charCount: 2 }],
    });
    expect(res.approval_id).toBe(RECEIPT_ID);
  });

  it("signs the saved factual context with the polished final body", async () => {
    const reviewContext = { version: 1, platform: "x", postText: "Original source", knowledgeAnchors: ["Oriole maps Atlas"] };
    let wire: OutboundIn | undefined;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      wire = JSON.parse(String(init.body));
      const headers = new Headers(init.headers);
      expect(headers.get("x-noelle-signature")).toBe(`sha256=${createHmac("sha256", "x".repeat(32))
        .update(`${headers.get("x-noelle-timestamp")}.${String(init.body)}`).digest("hex")}`);
      return Response.json({ id: RECEIPT_ID, approval_id: RECEIPT_ID });
    });
    const client = createOutboundClient({ baseUrl: "https://fixture.invalid", hmacSecret: "x".repeat(32),
      fetchImpl: fetchImpl as unknown as typeof fetch, typoRate: 0 });
    await client.postOutbound({ ...BASE, drafts: [{ id: "d1", kind: "reply", angle: "technical",
      body: "a grounded point.", charCount: 17, reviewContext }] } as OutboundIn);
    expect(wire!.drafts[0]).toMatchObject({ body: "a grounded point", reviewContext });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe("outbound client instance ownership", () => {
  const owner = { orgId: "aaaaaaaa-bbbb-4000-8ddd-eeeeeeeeeeee", agentInstanceId: "bbbbbbbb-cccc-4000-8ddd-ffffffffffff" };
  const drafts: OutboundIn["drafts"] = [{ id: "d1", kind: "reply", angle: "technical", body: "specific detail", charCount: 15 }];
  function client(typoRate = 0) {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ id: RECEIPT_ID, approval_id: RECEIPT_ID }), { status: 200 }));
    return { fetchImpl, api: createOutboundClient({ baseUrl: "https://fixture.invalid", hmacSecret: "x".repeat(32),
      fetchImpl: fetchImpl as unknown as typeof fetch, typoRate }) };
  }
  it.each(["x", "linkedin", "reddit"] as const)("binds ordinary/requested/DM %s bodies to the current instance on the wire", async platform => {
    for (const lane of ["ordinary", "requested", "dm"]) {
      const input: OutboundIn = { ...BASE, platform, drafts,
        ...(platform === "reddit" ? { originalPostId: "abc123",
          originalPostUrl: "https://www.reddit.com/r/SaaS/comments/abc123/title/" } : {}),
        ...(lane === "requested" ? { replyRequestKey: "request-1", humanReviewRequired: true } : {}),
        ...(lane === "dm" ? { postKind: "relationship_dm", drafts: [{ id: "dm1", kind: "dm", angle: null, body: "saved detail", charCount: 12 }] } : {}) };
      const { fetchImpl, api } = client();
      await api.postOutbound(input, owner);
      const wire = JSON.parse(String(fetchImpl.mock.calls[0]![1].body)) as OutboundIn;
      const init = fetchImpl.mock.calls[0]![1], headers = new Headers(init.headers);
      expect(headers.get("x-noelle-signature")).toBe(`sha256=${createHmac("sha256", "x".repeat(32))
        .update(`${headers.get("x-noelle-timestamp")}.${String(init.body)}`).digest("hex")}`);
      expect(wire.owner).toEqual(owner);
      expect(wire.replyRequestKey).toBe(input.replyRequestKey);
      expect(wire.drafts[0]!.kind).toBe(input.drafts[0]!.kind);
      expect(input.owner).toBeUndefined();
    }
  });
  it.each(["orgId", "agentInstanceId"] as const)("refuses contradictory %s before polish/signing/HTTP", async field => {
    const input: OutboundIn = { ...BASE, owner: { ...owner, [field]: "cccccccc-dddd-4000-8bbb-aaaaaaaaaaaa" },
      drafts: [{ ...drafts[0]!, body: "the rollback path is the part nobody ever rehearses honestly" }] };
    const { fetchImpl, api } = client(1), random = vi.spyOn(Math, "random");
    try {
      await expect(api.postOutbound(input, owner)).rejects.toThrow(/owner/i);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(random).not.toHaveBeenCalled();
    } finally { random.mockRestore(); }
  });
  it("preserves an explicit equivalent owner including UUID case", async () => {
    const supplied = { orgId: owner.orgId.toUpperCase(), agentInstanceId: owner.agentInstanceId.toUpperCase() };
    const input = { ...BASE, owner: supplied, drafts }, { fetchImpl, api } = client();
    await api.postOutbound(input, owner);
    const wire = JSON.parse(String(fetchImpl.mock.calls[0]![1].body)) as OutboundIn;
    expect(wire.owner).toEqual(supplied); expect(input.owner).toEqual(supplied);
  });
  it("rejects an invalid scoped owner before dispatch", async () => {
    const { fetchImpl, api } = client();
    await expect(api.postOutbound({ ...BASE, drafts }, { ...owner, orgId: "invalid" })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects an incoherent Reddit target before HTTP dispatch", async () => {
    const { fetchImpl, api } = client();
    const input: OutboundIn = { ...BASE, platform: "reddit", originalPostId: "abc123",
      originalPostUrl: "https://www.reddit.com/r/SaaS/comments/abc123/title/",
      drafts: [{ ...drafts[0]!, replyTarget: { kind: "comment", commentId: "def456",
        permalink: "https://www.reddit.com/r/SaaS/comments/other9/title/def456/" } }] };
    await expect(api.postOutbound(input, owner)).rejects.toThrow(/source thread/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("keeps the legacy no-binding method compatible with an explicit body owner", async () => {
    const { fetchImpl, api } = client();
    await api.postOutbound({ ...BASE, owner, drafts });
    expect((JSON.parse(String(fetchImpl.mock.calls[0]![1].body)) as OutboundIn).owner).toEqual(owner);
  });
});

// The human typo pass rides this client (see humanTypos.ts). These lock the
// contract the drafters depend on: replies may be mutated, DMs never are, the
// X send limit is respected, and charCount always matches what ships.
describe("outbound client — human typo pass", () => {
  const REPLY_BODY = "the rollback path is the part nobody ever rehearses honestly";
  const DM_BODY = "hey, saw you shipped the thing and wanted to say it looked clean";

  /** Post once and return the drafts exactly as they went on the wire. */
  const postAndCapture = async (
    typoRate: number,
    drafts: OutboundIn["drafts"],
    platform: OutboundIn["platform"] = "x",
  ): Promise<OutboundIn["drafts"]> => {
    let sent: OutboundIn | null = null;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as OutboundIn;
      return new Response(JSON.stringify({ id: RECEIPT_ID, approval_id: RECEIPT_ID }), { status: 200 });
    });
    const c = createOutboundClient({
      baseUrl: "https://api.trynoelle.com",
      hmacSecret: "x".repeat(32),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      typoRate,
    });
    await c.postOutbound({ ...BASE, platform, drafts });
    return sent!.drafts;
  };

  // rate 0 disables the SLIP only. The full-stop strip is a hard voice rule.
  it("leaves a period-free draft byte-identical when the slip is off", async () => {
    const drafts = await postAndCapture(0, [
      { id: "d1", kind: "reply", angle: "empathetic", body: REPLY_BODY, charCount: REPLY_BODY.length },
    ]);
    expect(drafts[0]!.body).toBe(REPLY_BODY);
    expect(drafts[0]!.charCount).toBe(REPLY_BODY.length);
  });

  it("never touches a DM, even at rate 1", async () => {
    for (let i = 0; i < 40; i++) {
      const drafts = await postAndCapture(1, [
        { id: "d1", kind: "reply", angle: "empathetic", body: REPLY_BODY, charCount: REPLY_BODY.length },
        { id: "d2", kind: "dm", angle: null, body: DM_BODY, charCount: DM_BODY.length },
      ]);
      const dm = drafts.find((d) => d.kind === "dm")!;
      expect(dm.body).toBe(DM_BODY);
      expect(dm.charCount).toBe(DM_BODY.length);
    }
  });

  it("mutates replies at rate 1 and keeps charCount in sync with the body", async () => {
    let mutated = 0;
    for (let i = 0; i < 40; i++) {
      const drafts = await postAndCapture(1, [
        { id: "d1", kind: "reply", angle: "empathetic", body: REPLY_BODY, charCount: REPLY_BODY.length },
      ]);
      const reply = drafts[0]!;
      expect(reply.charCount).toBe([...reply.body].length);
      if (reply.body !== REPLY_BODY) mutated++;
    }
    expect(mutated).toBeGreaterThan(0);
  });

  it("never lets an X reply exceed the 280-char send limit", async () => {
    const long = `${REPLY_BODY} ${"and the alerting story is the same shape too so ".repeat(5)}`.slice(0, 279);
    for (let i = 0; i < 60; i++) {
      const drafts = await postAndCapture(1, [
        { id: "d1", kind: "reply", angle: "empathetic", body: long, charCount: long.length },
      ]);
      expect(drafts[0]!.charCount).toBeLessThanOrEqual(280);
    }
  });

  it("strips full stops from replies, on every platform, at any rate", async () => {
    for (const platform of ["x", "linkedin"] as const) {
