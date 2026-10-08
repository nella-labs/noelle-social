import { describe, expect, it, vi } from "vitest";
import { ApifyError, createApifyRedditClient } from "./index.js";

const finished = (status = "SUCCEEDED", usageTotalUsd: unknown = 0.37) =>
  Response.json({ data: { id: "run", status, defaultDatasetId: "dataset", usageTotalUsd } });

describe("Reddit canonical paid transport", () => {
  it("retains failed terminal usage for metering", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(finished("FAILED"));
    const client = createApifyRedditClient({ token: "test-token", fetchImpl });
    await expect(client.subredditPosts({ subreddit: "fixture" })).rejects.toMatchObject({ status: 502 });
    expect(client.drainLastRunUsd?.()).toBe(0.37);
  });
  it("requests only the bounded raw dataset page", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(finished()).mockResolvedValueOnce(Response.json([]));
    const client = createApifyRedditClient({ token: "test-token", fetchImpl });
    await client.subredditPosts({ subreddit: "fixture", maxItems: 2, commentsPerPost: 2 });
    expect(new URL(String(fetchImpl.mock.calls[1]![0])).searchParams.get("limit")).toBe("2");
  });
  it("bounds metadata before dispatching a dataset request", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json({ data: {
      id: "run", status: "SUCCEEDED", defaultDatasetId: "dataset", padding: "x".repeat(4 * 1024 * 1024),
    } })).mockResolvedValueOnce(Response.json([]));
    await expect(createApifyRedditClient({ token: "test-token", fetchImpl }).subredditPosts({ subreddit: "fixture" }))
      .rejects.toBeInstanceOf(ApifyError);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it.each([1.5, 501])("rejects unsupported paid comment fanout %s before dispatch", async commentsPerPost => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(finished()).mockResolvedValueOnce(Response.json([]));
    await expect(createApifyRedditClient({ token: "test-token", fetchImpl }).subredditPosts({ subreddit: "fixture", commentsPerPost }))
      .rejects.toMatchObject({ status: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("does not dispatch an explicit zero post limit", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(finished()).mockResolvedValueOnce(Response.json([]));
    expect(await createApifyRedditClient({ token: "test-token", fetchImpl }).subredditPosts({ subreddit: "fixture", maxItems: 0 })).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("records real zero with exact raw coverage, then clears prior-operation receipts", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(finished("SUCCEEDED", 0)).mockResolvedValueOnce(
      Response.json([], { headers: { "X-Apify-Pagination-Total": "20" } }));
    const client = createApifyRedditClient({ token: "test-token", fetchImpl });
    await client.subredditPosts({ subreddit: "fixture" });
    expect(client.drainRunReceipts?.()).toEqual([expect.objectContaining({
      actualUsd: 0, resultCount: 20, resultCountComplete: true, fetchedResultCount: 0,
    })]);
    await client.subredditPosts({ subreddit: "fixture", maxItems: 0 });
    expect(client.drainRunReceipts?.()).toEqual([]);
  });
});
