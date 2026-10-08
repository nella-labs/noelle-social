import { describe, expect, it } from "vitest";
import { createApifyXClient } from "@noelle/x-apify";
import { createRotatingApifyClient } from "./apify-rotating.js";

function pool(firstDatasetStatus: number, second = false) {
  return createRotatingApifyClient({
    candidates: ["first", ...(second ? ["second"] : [])].map((token) => ({
      credentialId: token,
      token,
      wasExhausted: false,
    })),
    buildClient: (token) =>
      createApifyXClient({
        token,
        fetchImpl: (async (_url: unknown, init?: RequestInit) => {
          if (init?.method === "POST")
            return Response.json({
              data: {
                id: token,
                status: "SUCCEEDED",
                defaultDatasetId: token,
                usageTotalUsd: token === "first" ? 0.2 : 0.3,
              },
            });
          return token === "first" && firstDatasetStatus !== 200
            ? new Response("failed", { status: firstDatasetStatus })
            : Response.json([], { headers: { "X-Apify-Pagination-Total": "0" } });
        }) as typeof fetch,
      }),
  });
}

describe("rotated paid receipts", () => {
  it("drains a paid failed attempt before propagating the dataset error", async () => {
    const client = pool(500);
    await expect(client.userTweets({ handle: "builder" })).rejects.toMatchObject({ status: 500 });
    expect(client.drainRunReceipts?.()).toEqual([
      expect.objectContaining({ actualUsd: 0.2, credentialId: "first" }),
    ]);
  });

  it("preserves both paid charges and exact credential identities through failover", async () => {
    const client = pool(401, true);
    await client.userTweets({ handle: "builder" });
    const receipts = client.drainRunReceipts?.() ?? [];
    expect(receipts.map(({ credentialId, actualUsd }) => ({ credentialId, actualUsd }))).toEqual([
      { credentialId: "first", actualUsd: 0.2 },
      { credentialId: "second", actualUsd: 0.3 },
    ]);
    expect(receipts.reduce((total, r) => total + (r.actualUsd ?? 0), 0)).toBe(0.5);
    expect(client.currentCredentialId()).toBe("second");
    expect(client.drainRunReceipts?.()).toEqual([]);
  });

  it("clears undrained receipts and charge state at the next no-op operation", async () => {
    const client = pool(200);
    await client.userTweets({ handle: "builder" });
    await client.userTweets({ handle: "builder", limit: 0 });
    expect(client.drainRunReceipts?.()).toEqual([]);
    expect(client.drainLastRunUsd()).toBeNull();
  });
});
