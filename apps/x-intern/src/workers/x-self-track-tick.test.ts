import { describe, it, expect } from "vitest";
import { runXSelfTrackTick, type OwnPostReader } from "./x-self-track-tick.js";
import type { Sql } from "postgres";

// A fake postgres.js tag: returns canned rows for the SELECT (listOwnPublishedPosts)
// and [] for INSERTs (recordOwnPostMetrics), branching on the query text.
function fakeSql(selectRows: unknown[], onInsert?: (vals: unknown[]) => void): Sql {
  const tag = (strings: TemplateStringsArray, ...vals: unknown[]) => {
    const q = Array.isArray(strings) ? strings.join(" ") : String(strings);
    if (/insert\s+into/i.test(q)) {
      onInsert?.(Object.values(vals[0] as Record<string, unknown>));
      return Promise.resolve([]);
    }
    return Promise.resolve(selectRows);
  };
  return Object.assign(tag, { json: (value: unknown) => value }) as unknown as Sql;
}

const tweet = (id: string, over: Partial<{ likes: number; reposts: number; replies: number; followers: number }> = {}) => ({
  id,
  text: "t",
  created_at: "2026-07-01T00:00:00Z",
  url: `https://x.com/me/status/${id}`,
  author: { handle: "me", id: "u", followers: over.followers ?? 1000 },
  is_repost: false,
  likes: over.likes ?? 10,
  reposts: over.reposts ?? 2,
  replies: over.replies ?? 1,
});

const reader = (tweets: ReturnType<typeof tweet>[]): OwnPostReader => ({
  userTweets: async () => ({ tweets }),
});

describe("runXSelfTrackTick", () => {
  it("measures posts whose tweet is found, attributing idea_id", async () => {
    const inserts: unknown[][] = [];
    const sql = fakeSql(
      [
        { external_id: "1", idea_id: "idea-1", handle: "me" },
        { external_id: "2", idea_id: null, handle: "me" },
      ],
      (v) => inserts.push(v),
    );
    const res = await runXSelfTrackTick({
      sql,
      instanceId: "inst",
      orgId: "org",
      reader: reader([tweet("1", { likes: 99 }), tweet("2")]),
      windowDays: 30,
      maxPosts: 50,
    });
    expect(res.postsConsidered).toBe(2);
    expect(res.measured).toBe(2);
    expect(inserts).toHaveLength(2);
  });

  it("skips a post whose tweet Apify didn't return (never records a 0)", async () => {
    const sql = fakeSql([
      { external_id: "1", idea_id: "idea-1", handle: "me" },
      { external_id: "missing", idea_id: "idea-2", handle: "me" },
    ]);
    const res = await runXSelfTrackTick({
      sql,
      instanceId: "inst",
      orgId: "org",
      reader: reader([tweet("1")]), // only "1" comes back
      windowDays: 30,
      maxPosts: 50,
    });
    expect(res.postsConsidered).toBe(2);
    expect(res.measured).toBe(1);
  });

  it("returns 0 measured when there are no published posts", async () => {
    const res = await runXSelfTrackTick({
      sql: fakeSql([]),
      instanceId: "inst",
      orgId: "org",
      reader: reader([tweet("1")]),
      windowDays: 30,
      maxPosts: 50,
    });
    expect(res).toEqual({ postsConsidered: 0, measured: 0 });
  });

  it("isolates a per-handle Apify failure (no throw, others still measured)", async () => {
    const warns: unknown[] = [];
    const sql = fakeSql([
      { external_id: "1", idea_id: "idea-1", handle: "gooduser" },
      { external_id: "2", idea_id: "idea-2", handle: "baduser" },
    ]);
    const failingReader: OwnPostReader = {
      userTweets: async ({ handle }) => {
        if (handle === "baduser") throw new Error("apify 403");
        return { tweets: [tweet("1")] };
      },
    };
    const res = await runXSelfTrackTick({
      sql,
      instanceId: "inst",
      orgId: "org",
      reader: failingReader,
      windowDays: 30,
      maxPosts: 50,
      log: { warn: (o) => warns.push(o) },
    });
    expect(res.measured).toBe(1); // gooduser's post recorded, baduser isolated
    expect(warns).toHaveLength(1);
  });
});
