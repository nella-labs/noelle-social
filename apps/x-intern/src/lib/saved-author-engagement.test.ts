import { describe, expect, it, vi } from "vitest";
import { getSavedAuthorEngagement } from "./saved-author-engagement-db.js";

const args = {
  agentInstanceId: "instance",
  windowDays: 30,
  limitAuthors: 20,
  samplePosts: 3,
  minPosts: 1,
};
const row = (author: string, id: string, likes: string | null, replies = "0", reposts = "0") => ({
  author_handle: author,
  author_id: null,
  author_name: null,
  external_id: id,
  text: id,
  url: null,
  likes,
  replies,
  reposts,
});
function source(rows: ReturnType<typeof row>[]) {
  return vi.fn((strings: TemplateStringsArray) =>
    strings.join("").includes("with watched") ? rows : "fragment",
  ) as never;
}

describe("saved author measurements", () => {
  it("does not query for nonpositive or noninteger controls", async () => {
    for (const limitAuthors of [0, -1, 0.5, Number.NaN]) {
      const sql = source([]);
      expect(await getSavedAuthorEngagement(sql, { ...args, limitAuthors })).toEqual([]);
      expect(sql).not.toHaveBeenCalled();
    }
  });

  it("preserves unknown metrics and measured zero in the same author sample", async () => {
    expect(
      await getSavedAuthorEngagement(
        source([row("a", "unknown", null), row("a", "zero", "0")]),
        args,
      ),
    ).toMatchObject([
      {
        measuredPostCount: 1,
        observedPostCount: 2,
        avgEngagement: 0,
        posts: [
          { externalId: "zero", engagement: 0 },
          { externalId: "unknown", engagement: null },
        ],
      },
    ]);
  });
  it("does not produce an inexact post total when safe integer counts overflow", async () => {
    expect(
      await getSavedAuthorEngagement(
        source([row("a", "overflow", String(Number.MAX_SAFE_INTEGER), "1")]),
        args,
      ),
    ).toMatchObject([{ measuredPostCount: 0, avgEngagement: null, totalEngagement: null }]);
  });
  it("does not produce an inexact aggregate when several valid totals overflow", async () => {
    expect(
      await getSavedAuthorEngagement(
        source([row("a", "one", String(Number.MAX_SAFE_INTEGER)), row("a", "two", "1")]),
        args,
      ),
    ).toMatchObject([{ measuredPostCount: 2, avgEngagement: null, totalEngagement: null }]);
  });
  it("preserves latest-first ordering on tied post counts and sorts unknown authors last", async () => {
    const authors = await getSavedAuthorEngagement(
      source([row("unknown", "unknown", null), row("a", "newer", "1"), row("a", "older", "1")]),
      args,
    );
    expect(authors.map((author) => author.authorHandle)).toEqual(["a", "unknown"]);
    expect(authors[0]?.posts.map((post) => post.externalId)).toEqual(["newer", "older"]);
  });
});
