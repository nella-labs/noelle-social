import { describe, expect, it, vi } from "vitest";
import { XAuthError, XWriteUncertainError, type XClient } from "@noelle/x-client";
import { runSendTick } from "./send-tick.js";

const drafts = [
  { draft_id: "d1", body: "one", in_reply_to_id: "101", lead_id: "l1" },
  { draft_id: "d2", body: "two", in_reply_to_id: "102", lead_id: "l2" },
];
const claim = { orgId: "org", draftId: "d1", targetTweetId: "101", approvalId: "a1" };
const make = () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
  pendingDrafts: drafts,
  xClient: {
    createTweet: vi.fn().mockResolvedValue({ id: "201", url: "https://x.com/me/status/201" }),
  } as unknown as XClient,
  markSent: vi.fn().mockResolvedValue(undefined),
  markErrored: vi.fn().mockResolvedValue(undefined),
  reserveReply: vi.fn<() => Promise<typeof claim | null>>().mockResolvedValue(claim),
  releaseReply: vi.fn().mockResolvedValue(undefined),
  markUncertain: vi.fn().mockResolvedValue(undefined),
});

describe("durable reply dispatch", () => {
  it("finishes the reservation before posting and retains it after success", async () => {
    const args = make();
    const order: string[] = [];
    args.pendingDrafts = [drafts[0]!];
    args.reserveReply.mockImplementation(async () => {
      order.push("reserve");
      return claim;
    });
    vi.mocked(args.xClient.createTweet).mockImplementation(async () => {
      order.push("post");
      return { id: "201", url: "https://x.com/me/status/201" };
    });
    expect((await runSendTick(args))[0]?.status).toBe("sent");
    expect(order).toEqual(["reserve", "post"]);
    expect(args.releaseReply).not.toHaveBeenCalled();
  });
  it("reserves before dispatch and withholds an already claimed target", async () => {
    const args = make();
    args.reserveReply.mockResolvedValue(null);
    const outcomes = await runSendTick(args);
    expect(outcomes.map((o) => o.status)).toEqual(["withheld", "withheld"]);
    expect(args.xClient.createTweet).not.toHaveBeenCalled();
    expect(args.markSent).not.toHaveBeenCalled();
  });

  it("halts before dispatch when the reservation store fails", async () => {
    const args = make();
    args.reserveReply.mockRejectedValue(new Error("database unavailable"));
    expect((await runSendTick(args)).map((o) => o.status)).toEqual(["claim_unavailable"]);
    expect(args.xClient.createTweet).not.toHaveBeenCalled();
    expect(args.markErrored).not.toHaveBeenCalled();
  });

  it("retains the claim, reconciles and halts after an uncertain dispatched write", async () => {
    const args = make();
    vi.mocked(args.xClient.createTweet).mockRejectedValue(
      new XWriteUncertainError("response lost"),
    );
    expect((await runSendTick(args)).map((o) => o.status)).toEqual(["uncertain"]);
    expect(args.xClient.createTweet).toHaveBeenCalledTimes(1);
    expect(args.releaseReply).not.toHaveBeenCalled();
    expect(args.markErrored).not.toHaveBeenCalled();
    expect(args.markUncertain).toHaveBeenCalledWith(expect.objectContaining({ draftId: "d1" }));
  });

  it("retains known receipt after markSent fails and cannot turn it into a resend", async () => {
    const args = make();
    args.markSent.mockRejectedValue(new Error("receipt database failed"));
    const outcomes = await runSendTick(args);
    expect(outcomes).toEqual([
      expect.objectContaining({ status: "uncertain", sentExternalId: "201" }),
    ]);
    expect(args.xClient.createTweet).toHaveBeenCalledTimes(1);
    expect(args.releaseReply).not.toHaveBeenCalled();
    expect(args.markErrored).not.toHaveBeenCalled();
    expect(args.markUncertain).toHaveBeenCalledWith(
      expect.objectContaining({ receipt: { id: "201", url: "https://x.com/me/status/201" } }),
    );
  });

  it("keeps the batch halted even if reconciliation persistence also fails", async () => {
    const args = make();
    args.markSent.mockRejectedValue(new Error("receipt database failed"));
    args.markUncertain.mockRejectedValue(new Error("still unavailable"));
    expect((await runSendTick(args)).map((o) => o.status)).toEqual(["uncertain"]);
    expect(args.xClient.createTweet).toHaveBeenCalledTimes(1);
    expect(args.releaseReply).not.toHaveBeenCalled();
  });

  it("releases only its own reservation after a definite rejection", async () => {
    const args = make();
    vi.mocked(args.xClient.createTweet).mockRejectedValue(new XAuthError());
    expect((await runSendTick(args)).map((o) => o.status)).toEqual(["auth_failed"]);
    expect(args.releaseReply).toHaveBeenCalledExactlyOnceWith(claim);
  });
});
