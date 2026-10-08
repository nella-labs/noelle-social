import { describe, expect, it, vi } from "vitest";
import { getWatchlistSubreddits } from "./watchlist-db.js";

describe("getWatchlistSubreddits", () => {
  it("maps rows + defaults a null min_score to 0, oldest-added first", async () => {
    const fragments: string[] = [];
    const sql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray) => {
        fragments.push(strings.join("?"));
        return [
          {
            id: "row-1",
            subreddit: "SaaS",
            objective: "find founders shipping dev tools",
            min_score: 25,
            added_at: "2026-06-01T00:00:00.000Z",
          },
          {
            id: "row-2",
            subreddit: "ExperiencedDevs",
            objective: null,
            min_score: null,
            added_at: "2026-06-02T00:00:00.000Z",
          },
        ];
      }),
      { json: (x: unknown) => x },
    ) as never;

    const out = await getWatchlistSubreddits(sql, "inst-1");
    expect(out).toEqual([
      {
        id: "row-1",
        subreddit: "SaaS",
        objective: "find founders shipping dev tools",
        minScore: 25,
        addedAt: "2026-06-01T00:00:00.000Z",
      },
      {
        id: "row-2",
        subreddit: "ExperiencedDevs",
        objective: null,
        minScore: 0,
        addedAt: "2026-06-02T00:00:00.000Z",
      },
    ]);

    const q = fragments[0]!;
    expect(q).toMatch(/from noelle\.reddit_watchlist/);
    expect(q).toMatch(/order by added_at asc/);
  });
});
