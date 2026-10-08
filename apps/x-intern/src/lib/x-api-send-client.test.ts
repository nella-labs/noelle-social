import { describe, expect, it, vi } from "vitest";
import { XAuthError, XWriteUncertainError } from "@noelle/x-client";
import { runSendTick } from "../workers/send-tick.js";
import { createXApiSendClient } from "./x-api-send-client.js";
import { reserveXApiWrite, releaseXApiWrite } from "./x-api-budget.js";

vi.mock("./x-api-budget.js", () => ({ reserveXApiWrite: vi.fn(), releaseXApiWrite: vi.fn() }));

describe("reply API budget outcome", () => {
  it.each([new XWriteUncertainError(), new Error("unclassified transport failure")])(
    "retains the reserved budget for uncertain outcomes",
    async (error) => {
      vi.mocked(reserveXApiWrite).mockResolvedValue({ orgId: "o", agentInstanceId: "i", day: "2026-10-05" });
      vi.mocked(releaseXApiWrite).mockClear().mockResolvedValue(undefined);
      const client = createXApiSendClient({
        sql: {} as never,
        orgId: "o",
        agentInstanceId: "i",
        cap: 4,
        handle: "me",
        write: { postTweet: vi.fn().mockRejectedValue(error) } as never,
      });
      await expect(client.createTweet({ inReplyToId: "101", text: "reply" })).rejects.toBe(error);
      expect(releaseXApiWrite).not.toHaveBeenCalled();
    },
  );

  it("returns budget after a known auth rejection", async () => {
    vi.mocked(reserveXApiWrite).mockResolvedValue({ orgId: "o", agentInstanceId: "i", day: "2026-10-05" });
    vi.mocked(releaseXApiWrite).mockClear().mockResolvedValue(undefined);
    const client = createXApiSendClient({
      sql: {} as never,
      orgId: "o",
      agentInstanceId: "i",
      cap: 4,
      handle: "me",
      write: { postTweet: vi.fn().mockRejectedValue(new XAuthError()) } as never,
    });
    await expect(client.createTweet({ inReplyToId: "101", text: "reply" })).rejects.toBeInstanceOf(
      XAuthError,
    );
    expect(releaseXApiWrite).toHaveBeenCalledOnce();
  });
});


it("distinguishes a lost budget response before dispatch from an uncertain tweet", async () => {
  vi.mocked(reserveXApiWrite).mockRejectedValue(new Error("reservation response lost"));
  vi.mocked(releaseXApiWrite).mockClear();
  const postTweet = vi.fn();
  const releaseReply = vi.fn().mockResolvedValue({ orgId: "o", agentInstanceId: "i", day: "2026-10-05" });
  const markUncertain = vi.fn();
  const client = createXApiSendClient({ sql: {} as never, orgId: "o", agentInstanceId: "i", cap: 4,
    handle: "me", write: { postTweet } as never });
  const outcomes = await runSendTick({ log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    pendingDrafts: [{ draft_id: "d", body: "reply", in_reply_to_id: "101", lead_id: "l" }], xClient: client,
    reserveReply: vi.fn().mockResolvedValue({ orgId: "o", draftId: "d", targetTweetId: "101", approvalId: "a" }),
    releaseReply, markUncertain, markSent: vi.fn(), markErrored: vi.fn() });
  expect(outcomes).toEqual([expect.objectContaining({ status: "preparation_failed" })]);
  expect(postTweet).not.toHaveBeenCalled();
  expect(markUncertain).not.toHaveBeenCalled();
  expect(releaseReply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ draftId: "d" }));
  expect(releaseXApiWrite).not.toHaveBeenCalled();
});
