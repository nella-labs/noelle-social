import { describe, expect, it } from "vitest";
import { createApifyXClient } from "./index.js";

function reply(over: {
  id: string;
  userName: string;
  likeCount?: number;
  conversationId?: string;
}): Record<string, unknown> {
  return {
    type: "tweet",
    id: over.id,
    text: `reply body ${over.id}`,
    createdAt: "Wed Jun 18 14:03:12 +0000 2025",
    author: { userName: over.userName, id: `uid-${over.userName}`, followers: 100 },
    conversationId: over.conversationId ?? "100",
    likeCount: over.likeCount,
  };
}

// Mirrors the async run flow: POST /v2/acts/{id}/runs (returns the run object) →
// GET /v2/datasets/{id}/items (returns the items). `calls` records only the run
// STARTs, so its length == number of actor runs kicked off.
function makeFetch(items: unknown[]) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const run = () =>
    new Response(
      JSON.stringify({ data: { id: "run_x", status: "SUCCEEDED", defaultDatasetId: "ds_x" } }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? "GET";
    if (method === "POST" && url.includes("/runs")) {
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      return run();
    }
    if (method === "GET" && url.includes("/datasets/")) {
      return new Response(JSON.stringify(items), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return run();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("conversationReplies", () => {
  it("queries with the conversation_id operator and Top sort", async () => {
    const { fetchImpl, calls } = makeFetch([]);
    const client = createApifyXClient({ token: "t", fetchImpl });
    await client.conversationReplies({ conversationId: "100", limit: 5 });
    expect(calls).toHaveLength(1);
    const body = calls[0]!.body as { searchTerms: string[]; sort: string };
    expect(body.searchTerms).toEqual(["conversation_id:100"]);
    expect(body.sort).toBe("Top");
  });

  it("excludes the root post and the operator's own replies, ranked by likes desc", async () => {
    const items = [
      reply({ id: "100", userName: "op", conversationId: "100" }), // the ROOT post
      reply({ id: "101", userName: "alice", likeCount: 5 }),
      reply({ id: "102", userName: "bob", likeCount: 50 }),
      reply({ id: "103", userName: "demooperator", likeCount: 99 }), // operator's own reply
    ];
    const { fetchImpl } = makeFetch(items);
    const client = createApifyXClient({ token: "t", fetchImpl });
    const { tweets } = await client.conversationReplies({
      conversationId: "100",
      limit: 5,
      excludeHandle: "@demooperator",
    });
    expect(tweets.map((t) => t.id)).toEqual(["102", "101"]); // bob (50) before alice (5)
    expect(tweets.every((t) => t.author.handle !== "demooperator")).toBe(true);
  });

  it("returns empty without fetching for a blank conversation id", async () => {
    const { fetchImpl, calls } = makeFetch([reply({ id: "1", userName: "a" })]);
    const client = createApifyXClient({ token: "t", fetchImpl });
    const res = await client.conversationReplies({ conversationId: "  " });
    expect(res.tweets).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
