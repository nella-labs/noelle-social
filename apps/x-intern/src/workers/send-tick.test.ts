import { describe, expect, it, vi } from "vitest";
import { runSendTick, REPLY_FORBIDDEN_TRIP } from "./send-tick.js";
import { XAuthError, XRateLimitError, XReplyRestrictedError, XError } from "../lib/x-client.js";

function makeXClient(overrides: Partial<{
  createTweet: (args: { inReplyToId: string; text: string }) => Promise<{
    id: string;
    url: string;
  }>;
}> = {}) {
  return {
    createTweet:
      overrides.createTweet ??
      vi.fn().mockResolvedValue({ id: "T1", url: "https://x.com/me/status/T1" }),
    verifyCredentials: vi.fn(),
    userTweets: vi.fn(),
    searchTimeline: vi.fn(),
  };
}

function makeLog() {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
}

describe("runSendTick", () => {
  it("posts each pending draft and marks sent_external_id", async () => {
    const xClient = makeXClient();
    const markSent = vi.fn().mockResolvedValue(undefined);
    const markErrored = vi.fn().mockResolvedValue(undefined);

    const outcomes = await runSendTick({
      log: makeLog(),
      pendingDrafts: [
        { draft_id: "d1", body: "hello", in_reply_to_id: "tweet-1", lead_id: "L" },
      ],
      xClient: xClient as never,
      markSent,
      markErrored,
    });

    expect(outcomes).toEqual([
      {
        draftId: "d1",
        leadId: "L",
        status: "sent",
        sentExternalId: "T1",
        sentUrl: "https://x.com/me/status/T1",
      },
    ]);
    expect(markSent).toHaveBeenCalledWith({
      draftId: "d1",
      sentExternalId: "T1",
      sentUrl: "https://x.com/me/status/T1",
    });
    expect(markErrored).not.toHaveBeenCalled();
  });

  it("posts multiple drafts in a batch in order", async () => {
    const tweetIds = ["T1", "T2", "T3"];
    let i = 0;
    const xClient = makeXClient({
      createTweet: vi.fn(async () => {
        const id = tweetIds[i++]!;
        return { id, url: `https://x.com/me/status/${id}` };
      }),
    });
    const markSent = vi.fn().mockResolvedValue(undefined);
    const markErrored = vi.fn().mockResolvedValue(undefined);

    const outcomes = await runSendTick({
      log: makeLog(),
      pendingDrafts: [
        { draft_id: "d1", body: "one", in_reply_to_id: "t1", lead_id: "L1" },
        { draft_id: "d2", body: "two", in_reply_to_id: "t2", lead_id: "L2" },
        { draft_id: "d3", body: "three", in_reply_to_id: "t3", lead_id: "L3" },
      ],
      xClient: xClient as never,
      markSent,
      markErrored,
    });

    expect(outcomes.map((o) => o.status)).toEqual(["sent", "sent", "sent"]);
    expect(outcomes.map((o) => o.sentExternalId)).toEqual(["T1", "T2", "T3"]);
    expect(markSent).toHaveBeenCalledTimes(3);
    expect(markErrored).not.toHaveBeenCalled();
  });

  it("stops the batch on XAuthError and reports auth_failed", async () => {
    const xClient = makeXClient({
      createTweet: vi
        .fn()
        .mockRejectedValueOnce(new XAuthError("x auth failed"))
        .mockResolvedValue({ id: "T-late", url: "https://x.com/me/status/T-late" }),
    });
    const markSent = vi.fn().mockResolvedValue(undefined);
    const markErrored = vi.fn().mockResolvedValue(undefined);

    const outcomes = await runSendTick({
      log: makeLog(),
      pendingDrafts: [
        { draft_id: "d1", body: "one", in_reply_to_id: "t1", lead_id: "L1" },
        { draft_id: "d2", body: "two", in_reply_to_id: "t2", lead_id: "L2" },
      ],
      xClient: xClient as never,
      markSent,
      markErrored,
    });

    // Auth error short-circuits the loop: d1 reports auth_failed, d2 is never attempted.
    expect(outcomes).toEqual([
      { draftId: "d1", status: "auth_failed", reason: "x auth failed" },
    ]);
    expect(markSent).not.toHaveBeenCalled();
    expect(markErrored).not.toHaveBeenCalled();
    expect(xClient.createTweet).toHaveBeenCalledTimes(1);
  });

  it("stops the batch on XRateLimitError and reports rate_limited", async () => {
    const xClient = makeXClient({
      createTweet: vi
        .fn()
        .mockRejectedValueOnce(new XRateLimitError("x rate limited"))
        .mockResolvedValue({ id: "T-late", url: "https://x.com/me/status/T-late" }),
    });
    const markSent = vi.fn().mockResolvedValue(undefined);
    const markErrored = vi.fn().mockResolvedValue(undefined);

    const outcomes = await runSendTick({
      log: makeLog(),
      pendingDrafts: [
        { draft_id: "d1", body: "one", in_reply_to_id: "t1", lead_id: "L1" },
        { draft_id: "d2", body: "two", in_reply_to_id: "t2", lead_id: "L2" },
      ],
      xClient: xClient as never,
      markSent,
      markErrored,
    });

    expect(outcomes).toEqual([
      { draftId: "d1", status: "rate_limited", reason: "x rate limited" },
    ]);
    expect(markSent).not.toHaveBeenCalled();
    expect(markErrored).not.toHaveBeenCalled();
    expect(xClient.createTweet).toHaveBeenCalledTimes(1);
  });

  it("flips approval to errored on a non-auth non-rate-limit XError and continues", async () => {
    const xClient = makeXClient({
      createTweet: vi
        .fn()
        .mockRejectedValueOnce(new XError("x 404 not found", 404))
        .mockResolvedValueOnce({ id: "T2", url: "https://x.com/me/status/T2" }),
    });
    const markSent = vi.fn().mockResolvedValue(undefined);
    const markErrored = vi.fn().mockResolvedValue(undefined);

    const outcomes = await runSendTick({
      log: makeLog(),
      pendingDrafts: [
        { draft_id: "d1", body: "one", in_reply_to_id: "t1", lead_id: "L1" },
        { draft_id: "d2", body: "two", in_reply_to_id: "t2", lead_id: "L2" },
      ],
      xClient: xClient as never,
      markSent,
      markErrored,
    });

    expect(outcomes).toEqual([
      { draftId: "d1", status: "errored", reason: "x 404 not found" },
      {
        draftId: "d2",
        leadId: "L2",
        status: "sent",
        sentExternalId: "T2",
        sentUrl: "https://x.com/me/status/T2",
      },
    ]);
    expect(markErrored).toHaveBeenCalledWith({
      draftId: "d1",
      reason: "x 404 not found",
    });
    expect(markSent).toHaveBeenCalledWith({
      draftId: "d2",
      sentExternalId: "T2",
      sentUrl: "https://x.com/me/status/T2",
    });
  });

  it("errors the row on ONE reply-restriction 403 and continues the batch", async () => {
    const xClient = makeXClient({
      createTweet: vi
        .fn()
        .mockRejectedValueOnce(new XReplyRestrictedError("x api reply not allowed"))
        .mockResolvedValueOnce({ id: "T2", url: "https://x.com/me/status/T2" }),
    });
    const markSent = vi.fn().mockResolvedValue(undefined);
    const markErrored = vi.fn().mockResolvedValue(undefined);

    const outcomes = await runSendTick({
      log: makeLog(),
