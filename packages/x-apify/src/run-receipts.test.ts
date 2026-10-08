import { describe, expect, it } from "vitest";
import { createApifyXClient } from "./index.js";

function client(status = "SUCCEEDED", datasetStatus = 200, usage: unknown = 0.37) {
  return createApifyXClient({
    token: "fixture",
    fetchImpl: (async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "POST")
        return Response.json({
          data: { id: "run", status, defaultDatasetId: "data", usageTotalUsd: usage },
        });
      return datasetStatus === 200
        ? Response.json([], { headers: { "X-Apify-Pagination-Total": "0" } })
        : new Response("dataset failed", { status: datasetStatus });
    }) as typeof fetch,
  });
}

describe("paid run receipts", () => {
  it("retains terminal charge before a dataset failure", async () => {
    const c = client("SUCCEEDED", 500);
    await expect(c.userTweets({ handle: "builder" })).rejects.toMatchObject({ status: 500 });
    expect(c.drainRunReceipts?.()).toEqual([
      expect.objectContaining({
        runId: "run",
        status: "SUCCEEDED",
        terminal: true,
        actualUsd: 0.37,
        resultCountComplete: false,
      }),
    ]);
    expect(c.drainRunReceipts?.()).toEqual([]);
  });

  it.each(["FAILED", "ABORTED", "TIMED-OUT"])(
    "retains actual terminal usage for %s",
    async (status) => {
      const c = client(status);
      await c.userTweets({ handle: "builder" }).catch(() => {});
      expect(c.drainRunReceipts?.()).toEqual([
        expect.objectContaining({ status, actualUsd: 0.37 }),
      ]);
    },
  );

  it("stores one completed receipt with raw count coverage", async () => {
    const c = client();
    await c.userTweets({ handle: "builder" });
    expect(c.drainRunReceipts?.()).toEqual([
      expect.objectContaining({
        resultCount: 0,
        fetchedResultCount: 0,
        resultCountComplete: true,
        actualUsd: 0.37,
      }),
    ]);
  });

  it.each([null, -1, "bad"])("preserves unknown usage %s", async (usage) => {
    const c = client("SUCCEEDED", 500, usage);
    await c.userTweets({ handle: "builder" }).catch(() => {});
    expect(c.drainRunReceipts?.()[0]?.actualUsd).toBeNull();
  });

  it("does not leak an undrained receipt into a subsequent no-op", async () => {
    const c = client();
    await c.userTweets({ handle: "builder" });
    await c.userTweets({ handle: "builder", limit: 0 });
    expect(c.drainRunReceipts?.()).toEqual([]);
  });
});
