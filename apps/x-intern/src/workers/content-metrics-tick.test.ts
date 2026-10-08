import { describe, it, expect } from "vitest";
import { runContentMetricsTick, type TweetMetricsReader } from "./content-metrics-tick.js";
import type { TweetMetrics } from "@noelle/x-client";
import type { Sql } from "postgres";

// Fake postgres.js tag: canned rows for the SELECT (listPublishedTweetsForMetrics),
// captures INSERT bind values (recordOwnPostMetrics), branching on query text.
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

const metric = (id: string, over: Partial<TweetMetrics> = {}): TweetMetrics => ({
  id,
  views: over.views ?? 4000,
  likes: over.likes ?? 10,
  reposts: over.reposts ?? 3,
  replies: over.replies ?? 1,
  quotes: over.quotes ?? 0,
  bookmarks: over.bookmarks ?? 2,
});

const reader = (metrics: TweetMetrics[]): TweetMetricsReader => ({
  getTweetMetrics: async () => metrics,
});

describe("runContentMetricsTick", () => {
  it("preserves measured quotes and distinguishes missing bookmarks from real zero", async () => {
    const inserts: unknown[][] = [];
    const sql = fakeSql([
      { tweet_id: "1", slot_id: null, idea_id: null },
      { tweet_id: "2", slot_id: null, idea_id: null },
    ], (v) => inserts.push(v));
    await runContentMetricsTick({
      sql, instanceId: "inst", orgId: "org", windowDays: 30, maxPosts: 50,
      reader: reader([
        { ...metric("1"), quotes: 7, bookmarks: null },
        { ...metric("2"), quotes: 0, bookmarks: 0 },
      ]),
    });
    expect(inserts.map((v) => v.slice(-2))).toEqual([[7, null], [0, 0]]);
  });

  it("appends a snapshot per returned tweet, carrying views + slot/idea attribution", async () => {
    const inserts: unknown[][] = [];
    const sql = fakeSql(
      [
        { tweet_id: "1", slot_id: "slot-1", idea_id: "idea-1" },
        { tweet_id: "2", slot_id: null, idea_id: "idea-2" },
      ],
      (v) => inserts.push(v),
    );
    const res = await runContentMetricsTick({
      sql,
      instanceId: "inst",
      orgId: "org",
      reader: reader([metric("1", { views: 9000 }), metric("2")]),
      windowDays: 30,
      maxPosts: 50,
    });
    expect(res).toEqual({ postsConsidered: 2, measured: 2 });
    // Snapshot record contains attribution and observed counters.
    expect(inserts).toHaveLength(2);
    expect(inserts[0]).toContain("slot-1");
    expect(inserts[0]).toContain(9000); // real impressions flow through as views
  });

  it("skips a post X didn't return (never records a 0)", async () => {
    const sql = fakeSql([
      { tweet_id: "1", slot_id: "slot-1", idea_id: "idea-1" },
      { tweet_id: "missing", slot_id: null, idea_id: null },
    ]);
    const res = await runContentMetricsTick({
      sql,
      instanceId: "inst",
      orgId: "org",
      reader: reader([metric("1")]), // only "1" comes back
      windowDays: 30,
      maxPosts: 50,
    });
    expect(res).toEqual({ postsConsidered: 2, measured: 1 });
  });

  it("no-ops with no reader (unconnected account) and never queries", async () => {
    let queried = false;
    const sql = ((..._a: unknown[]) => {
      queried = true;
      return Promise.resolve([]);
    }) as unknown as Sql;
    const res = await runContentMetricsTick({
      sql,
      instanceId: "inst",
      orgId: "org",
      reader: null,
      windowDays: 30,
      maxPosts: 50,
    });
    expect(res).toEqual({ postsConsidered: 0, measured: 0 });
    expect(queried).toBe(false);
  });

  it("drops the sweep (no throw) when the lookup errors", async () => {
    const warns: unknown[] = [];
    const sql = fakeSql([{ tweet_id: "1", slot_id: "slot-1", idea_id: "idea-1" }]);
    const failing: TweetMetricsReader = {
      getTweetMetrics: async () => {
        throw new Error("x api 429");
      },
    };
    const res = await runContentMetricsTick({
      sql,
      instanceId: "inst",
      orgId: "org",
      reader: failing,
      windowDays: 30,
      maxPosts: 50,
      log: { warn: (o) => warns.push(o) },
    });
    expect(res).toEqual({ postsConsidered: 1, measured: 0 });
    expect(warns).toHaveLength(1);
  });
});
