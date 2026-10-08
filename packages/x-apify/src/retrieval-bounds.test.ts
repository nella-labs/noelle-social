import { describe, expect, it } from "vitest";
import { createApifyXClient, normalizeTweet } from "./index.js";

function harness(total: number | null = 3) {
  const starts: Array<Record<string, unknown>> = [];
  const urls: string[] = [];
  const items = Array.from({ length: 3 }, (_, index) => ({
    id: String(index + 1),
    text: `Post ${index}`,
    createdAt: "2026-10-05T10:00:00Z",
    author: { userName: "builder", followers: 100 },
  }));
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    if (init?.method === "POST") {
      starts.push(JSON.parse(String(init.body)));
      return Response.json({
        data: { id: "run", status: "SUCCEEDED", defaultDatasetId: "data", usageTotalUsd: 0.37 },
      });
    }
    const limit = Number(new URL(url).searchParams.get("limit") ?? items.length);
    return Response.json(items.slice(0, limit), {
      headers: total === null ? {} : { "X-Apify-Pagination-Total": String(total) },
    });
  }) as typeof fetch;
  return { client: createApifyXClient({ token: "test", fetchImpl }), starts, urls };
}

describe("bounded paid retrieval", () => {
  it.each(["2026-02-30T10:00:00Z", "2025-02-29T10:00:00Z"])("drops the impossible source timestamp %s", (createdAt) => {
    expect(normalizeTweet({ id: "123", text: "A source observation", createdAt, author: { userName: "builder" } })).toBeNull();
  });

  it.each([["2024-02-29T10:00:00Z", "2024-02-29T10:00:00.000Z"],
    ["Wed Jun 18 14:03:12 +0000 2025", "2025-06-18T14:03:12.000Z"]])("preserves the valid source date %s", (createdAt, expected) => {
    expect(normalizeTweet({ id: "123", text: "A source observation", createdAt, author: { userName: "builder" } })?.created_at).toBe(expected);
  });

  it("rejects an oversized dataset body even if the provider ignores its item limit", async () => {
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return Response.json({ data: { id: "run", status: "SUCCEEDED", defaultDatasetId: "data" } });
      return Response.json([{ id: "1", text: "x".repeat(4 * 1024 * 1024), createdAt: "2026-10-05T10:00:00Z", author: { userName: "builder" } }]);
    }) as typeof fetch;
    const outcome = await createApifyXClient({ token: "test", fetchImpl }).userTweets({ handle: "builder", limit: 1 })
      .then(() => "accepted", (error: { status: number }) => error.status);
    expect(outcome).toBe(502);
  });

  it.each([Number.NaN, Infinity, -1, 1.5, 501])(
    "rejects an unsafe tweet limit %s before starting a paid actor",
    async (limit) => {
      const { client, starts } = harness();
      await expect(client.userTweets({ handle: "builder", limit })).rejects.toMatchObject({
        status: 400,
      });
      expect(starts).toHaveLength(0);
    },
  );

  it("makes no paid request for an explicit zero limit", async () => {
    const { client, starts } = harness();
    expect((await client.searchTimeline({ query: "builders", limit: 0 })).tweets).toEqual([]);
    expect(starts).toHaveLength(0);
  });

  it("does not reuse an earlier charge after a zero-result request starts no actor", async () => {
    const { client } = harness();
    await client.userTweets({ handle: "builder", limit: 2 });
    await client.userTweets({ handle: "builder", limit: 0 });
    expect(client.drainLastRunUsd?.()).toBeNull();
  });

  it("bounds dataset downloads while retaining the provider-reported raw total", async () => {
    const { client, starts, urls } = harness(999);
    const result = await client.userTweets({ handle: "builder", limit: 2 });
    expect(starts[0]?.maxItems).toBe(2);
    expect(new URL(urls[1]!).searchParams.get("limit")).toBe("2");
    expect(result.tweets).toHaveLength(2);
    expect(result).toMatchObject({
      resultCount: 999,
      fetchedResultCount: 2,
      resultCountComplete: true,
    });
    expect(client.drainLastRunUsd?.()).toBe(0.37);
  });

  it("marks a headerless full page as unknown coverage rather than a complete billed count", async () => {
    const { client } = harness(null);
    const result = await client.userTweets({ handle: "builder", limit: 2 });
    expect(result).toMatchObject({
      resultCount: 2,
      fetchedResultCount: 2,
      resultCountComplete: false,
    });
  });

  it("allocates follower list limits across seeds and both directions", async () => {
    const { client, starts, urls } = harness();
    await client.scrapeFollowers({
      seedHandles: ["one", "two"],
      maxUsers: 1000,
      getFollowers: true,
      getFollowing: true,
    });
    expect(starts[0]).toMatchObject({
      user_names: ["one", "two"],
      maxFollowers: 250,
      maxFollowings: 250,
    });
    expect(new URL(urls[1]!).searchParams.get("limit")).toBe("1000");
  });

  it.each([Number.NaN, Infinity, -1, 1.5, 2001])(
    "rejects unsafe follower cap %s before a paid actor",
    async (maxUsers) => {
      const { client, starts } = harness();
      await expect(
        client.scrapeFollowers({ seedHandles: ["seed"], maxUsers }),
      ).rejects.toMatchObject({ status: 400 });
      expect(starts).toHaveLength(0);
    },
  );

  it("rejects more seeds than the bounded follower actor supports", async () => {
    const { client, starts } = harness();
    await expect(
      client.scrapeFollowers({ seedHandles: ["a", "b", "c", "d", "e", "f"], maxUsers: 200 }),
    ).rejects.toMatchObject({ status: 400 });
    expect(starts).toHaveLength(0);
  });

  it("makes no paid follower run when both directions are off", async () => {
    const { client, starts } = harness();
    expect(
      (
        await client.scrapeFollowers({
          seedHandles: ["seed"],
          maxUsers: 200,
          getFollowers: false,
          getFollowing: false,
        })
      ).people,
    ).toEqual([]);
    expect(starts).toHaveLength(0);
  });

  it("rejects an unsafe conversation limit before a paid actor", async () => {
    const { client, starts } = harness();
    await expect(
      client.conversationReplies({ conversationId: "100", limit: Number.NaN }),
    ).rejects.toMatchObject({ status: 400 });
    expect(starts).toHaveLength(0);
  });
});
