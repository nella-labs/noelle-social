import { describe, expect, it, vi } from "vitest";
import { promoteWatchlistAuthors } from "./watchlist-promote.js";

// A sql tag mock that records each call's args (tag is invoked as
// sql(strings, ...values)) and returns canned rows.
function mockSqlTag(rows: unknown[] = []) {
  const calls: unknown[][] = [];
  const tag = Object.assign(
    vi.fn(async (...args: unknown[]) => {
      calls.push(args);
      return rows;
    }),
    { unsafe: vi.fn() },
  ) as unknown as Parameters<typeof promoteWatchlistAuthors>[0];
  return { tag, calls };
}

describe("promoteWatchlistAuthors", () => {
  it("returns the promoted handles from the insert ... returning", async () => {
    const { tag } = mockSqlTag([{ handle: "alice" }, { handle: "bob" }]);
    const out = await promoteWatchlistAuthors(tag, "inst", "org", { minDrafted: 2, maxPerRun: 5 });
    expect(out).toEqual(["alice", "bob"]);
  });

  it("interpolates instanceId, orgId and thresholds into the query", async () => {
    const { tag, calls } = mockSqlTag([]);
    await promoteWatchlistAuthors(tag, "inst-1", "org-1", {
      minDrafted: 3,
      maxPerRun: 7,
      backfillHours: 12,
    });
    const values = calls[0]!.slice(1); // everything after the strings array
    expect(values).toContain("inst-1");
    expect(values).toContain("org-1");
    expect(values).toContain(3); // minDrafted
    expect(values).toContain(7); // maxPerRun
    expect(values).toContain(12); // backfillHours
  });

  it("short-circuits without touching the db when maxPerRun <= 0 (disabled)", async () => {
    const { tag, calls } = mockSqlTag([]);
    const out = await promoteWatchlistAuthors(tag, "inst", "org", { maxPerRun: 0 });
    expect(out).toEqual([]);
    expect(calls.length).toBe(0);
  });

  it("defaults to minDrafted 2, maxPerRun 5, backfill 24h", async () => {
    const { tag, calls } = mockSqlTag([]);
    await promoteWatchlistAuthors(tag, "i", "o");
    const values = calls[0]!.slice(1);
    expect(values).toContain(2);
    expect(values).toContain(5);
    expect(values).toContain(24);
  });
});
