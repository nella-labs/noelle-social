import { describe, expect, it, vi } from "vitest";
import { ApifyError, createApifyVideoClient } from "./index.js";

const finished = (status = "SUCCEEDED", usageTotalUsd: unknown = 0.37) =>
  Response.json({ data: { id: "run", status, defaultDatasetId: "dataset", usageTotalUsd } });
const video = (id: string) => ({ id, videoUrl: "https://fixture.invalid/video", videoViewCount: 1 });
const pull = (client: ReturnType<typeof createApifyVideoClient>, lane: "creator" | "hashtag" | "niche") =>
  lane === "creator" ? client.creatorReels({ platform: "instagram", handle: "fixture" })
    : lane === "hashtag" ? client.hashtagReels({ platform: "instagram", query: "fixture" })
      : client.nicheCreatorReels({ platform: "instagram", query: "fixture" });

describe("Video canonical paid transport", () => {
  it("does not replay an ambiguous creator failure through the niche hashtag fallback", async () => {
    let posts = 0;
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts++;
        if (posts > 1) throw new Error("ambiguous creator transport failure");
        return finished("SUCCEEDED", 0.1);
      }
      return Response.json([{ username: "fixture" }]);
    }) as unknown as typeof fetch;
    const client = createApifyVideoClient({ token: "test-token", fetchImpl });
    await expect(pull(client, "niche")).rejects.toMatchObject({ status: 0 });
    expect(posts).toBe(2);
    expect(client.drainRunReceipts?.().map(row => row.actualUsd)).toEqual([0.1, null]);
  });

  it.each(["creator", "hashtag", "niche"] as const)("does not advance the %s provider chain after an ambiguous paid dispatch", async lane => {
    for (const failure of ["network", "502", "504", "invalid_metadata", "dataset_network", "dataset_502"]) {
      let posts = 0;
      const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
        if (init?.method === "POST") {
          posts++;
          if (failure === "network") throw new Error("ambiguous transport failure");
          if (failure === "502" || failure === "504") return new Response("upstream failure", { status: Number(failure) });
          if (failure === "invalid_metadata") return new Response("{invalid", { status: 200 });
          return finished();
        }
        if (failure === "dataset_network") throw new Error("dataset transport failure");
        return new Response("dataset failure", { status: 502 });
      }) as unknown as typeof fetch;
      const client = createApifyVideoClient({ token: "test-token", fetchImpl });
      await expect(pull(client, lane)).rejects.toBeInstanceOf(ApifyError);
      expect(posts, failure).toBe(1);
      expect(client.drainRunReceipts?.()).toEqual([expect.objectContaining({
        actualUsd: failure.startsWith("dataset_") ? 0.37 : null,
      })]);
    }
  });

  it.each(["creator", "hashtag", "niche"] as const)("retains completed-failure charges while allowing the %s fallback", async lane => {
    let posts = 0;
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "POST") return finished(++posts === 1 ? "FAILED" : "SUCCEEDED", posts === 1 ? 0.1 : 0.2);
      return Response.json(lane === "creator" ? [{ username: "fixture", latestPosts: [video("fallback")] }] : [video("fallback")]);
    }) as unknown as typeof fetch;
    const client = createApifyVideoClient({ token: "test-token", fetchImpl });
    expect(await pull(client, lane)).toHaveLength(1);
    expect(posts).toBe(2);
    expect(client.drainRunReceipts?.().map(row => [row.status, row.actualUsd])).toEqual([["FAILED", 0.1], ["SUCCEEDED", 0.2]]);
  });

  it("retains failed terminal usage for metering", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(finished("FAILED"));
    const client = createApifyVideoClient({ token: "test-token", fetchImpl });
    await expect(client.creatorReels({ platform: "tiktok", handle: "fixture" })).rejects.toMatchObject({ status: 502 });
    expect(client.drainLastRunUsd?.()).toBe(0.37);
  });
  it("limits the raw dataset download", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(finished()).mockResolvedValueOnce(Response.json([]));
    await createApifyVideoClient({ token: "test-token", fetchImpl }).creatorReels({ platform: "tiktok", handle: "fixture", maxItems: 2 });
    expect(new URL(String(fetchImpl.mock.calls[1]![0])).searchParams.get("limit")).toBe("2");
  });
  it("bounds metadata before another request", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json({ data: {
      id: "run", status: "SUCCEEDED", defaultDatasetId: "dataset", padding: "x".repeat(4 * 1024 * 1024),
    } })).mockResolvedValueOnce(Response.json([]));
    await expect(createApifyVideoClient({ token: "test-token", fetchImpl }).creatorReels({ platform: "tiktok", handle: "fixture" }))
      .rejects.toBeInstanceOf(ApifyError);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it("rejects fractional paid limits before dispatch", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(finished()).mockResolvedValueOnce(Response.json([]));
    await expect(createApifyVideoClient({ token: "test-token", fetchImpl }).creatorReels({ platform: "tiktok", handle: "fixture", maxItems: 1.5 }))
      .rejects.toMatchObject({ status: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("does not dispatch for an explicit zero limit", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(finished()).mockResolvedValueOnce(Response.json([]));
    expect(await createApifyVideoClient({ token: "test-token", fetchImpl }).creatorReels({ platform: "tiktok", handle: "fixture", maxItems: 0 })).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("stops niche creator retrieval at the global requested clip limit", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(finished()).mockResolvedValueOnce(Response.json([{ username: "first" }, { username: "second" }]))
      .mockResolvedValueOnce(finished()).mockResolvedValueOnce(Response.json([video("one"), video("two")]))
      .mockResolvedValueOnce(finished()).mockResolvedValueOnce(Response.json([video("three"), video("four")]));
    const result = await createApifyVideoClient({ token: "test-token", fetchImpl }).nicheCreatorReels({ platform: "instagram", query: "fixture", maxItems: 2 });
    expect(result).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
  it("rejects an invalid global niche limit before even searching creators", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(finished()).mockResolvedValueOnce(Response.json([]));
    await expect(createApifyVideoClient({ token: "test-token", fetchImpl })
      .nicheCreatorReels({ platform: "instagram", query: "fixture", maxItems: 1.5 })).rejects.toMatchObject({ status: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("retains all receipts through the nested niche-to-hashtag fallback", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(finished("SUCCEEDED", 0.1)).mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(finished("SUCCEEDED", 0.2)).mockResolvedValueOnce(Response.json([video("fallback")]));
    const client = createApifyVideoClient({ token: "test-token", fetchImpl });
    expect(await client.nicheCreatorReels({ platform: "instagram", query: "fixture" })).toHaveLength(1);
    expect(client.drainLastRunUsd?.()).toBeCloseTo(0.3);
    expect(client.drainRunReceipts?.()).toEqual([
      expect.objectContaining({ actualUsd: 0.1, actor: "instagram-search-scraper", resultCountComplete: false }),
      expect.objectContaining({ actualUsd: 0.2, actor: "instagram-search-scraper", resultCountComplete: false }),
    ]);
    await client.creatorReels({ platform: "tiktok", handle: "fixture", maxItems: 0 });
    expect(client.drainRunReceipts?.()).toEqual([]);
  });
});
