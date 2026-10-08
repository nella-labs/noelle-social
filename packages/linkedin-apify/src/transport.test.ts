import { describe, expect, it, vi } from "vitest";
import { ApifyError, createApifyLinkedInClient } from "./index.js";

const finished = (status = "SUCCEEDED", usageTotalUsd: unknown = 0.37) =>
  Response.json({ data: { id: "run", status, defaultDatasetId: "dataset", usageTotalUsd } });
const post = (id: number) => ({ id: `urn:li:activity:${id}`, content: "Source post" });

describe("LinkedIn canonical paid transport", () => {
  it("keeps provider-reported failed-run charges available to metering", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(finished("FAILED"));
    const client = createApifyLinkedInClient({ token: "test-token", fetchImpl });
    await expect(client.profilePosts({ publicId: "fixture" })).rejects.toMatchObject({ status: 502 });
    expect(client.drainLastRunUsd?.()).toBe(0.37);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("limits raw dataset retrieval while retaining its exact provider total", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(finished()).mockResolvedValueOnce(
      Response.json([post(123456), post(123457), post(123458)], { headers: { "X-Apify-Pagination-Total": "250" } }));
    const client = createApifyLinkedInClient({ token: "test-token", fetchImpl });
    expect(await client.profilePosts({ publicId: "fixture", maxPosts: 2 })).toHaveLength(2);
    expect(new URL(String(fetchImpl.mock.calls[1]![0])).searchParams.get("limit")).toBe("2");
    expect(client.drainRunReceipts?.()).toEqual([expect.objectContaining({
      actor: "linkedin-profile-posts", actualUsd: 0.37, resultCount: 250,
      fetchedResultCount: 3, resultCountComplete: true,
    })]);
  });

  it("bounds actor metadata before it can trigger a dataset fetch", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json({ data: {
      id: "run", status: "SUCCEEDED", defaultDatasetId: "dataset", padding: "x".repeat(4 * 1024 * 1024),
    } })).mockResolvedValueOnce(Response.json([]));
    const client = createApifyLinkedInClient({ token: "test-token", fetchImpl });
    await expect(client.profilePosts({ publicId: "fixture" })).rejects.toBeInstanceOf(ApifyError);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects fractional paid actor limits before dispatch", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(finished()).mockResolvedValueOnce(Response.json([]));
    const client = createApifyLinkedInClient({ token: "test-token", fetchImpl });
    await expect(client.profilePosts({ publicId: "fixture", maxPosts: 1.5 })).rejects.toMatchObject({ status: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not start a paid actor for an explicit zero limit", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(finished()).mockResolvedValueOnce(Response.json([]));
    const client = createApifyLinkedInClient({ token: "test-token", fetchImpl });
    expect(await client.profilePosts({ publicId: "fixture", maxPosts: 0 })).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps missing totals incomplete and clears earlier receipts before a no-op", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(finished()).mockResolvedValueOnce(Response.json([post(123456)]));
    const client = createApifyLinkedInClient({ token: "test-token", fetchImpl });
    await client.profilePosts({ publicId: "fixture" });
    expect(client.drainRunReceipts?.()).toEqual([expect.objectContaining({ resultCount: 1, resultCountComplete: false })]);
    await client.profilePosts({ publicId: "fixture", maxPosts: 0 });
    expect(client.drainRunReceipts?.()).toEqual([]);
    expect(client.drainLastRunUsd?.()).toBeNull();
  });

  it("rejects a multi-query paid workload beyond the operation item bound", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(finished()).mockResolvedValueOnce(Response.json([]));
    await expect(createApifyLinkedInClient({ token: "test-token", fetchImpl })
      .searchPosts({ queries: ["first", "second"], maxPosts: 3000 })).rejects.toMatchObject({ status: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
