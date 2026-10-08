import { describe, it, expect } from "vitest";
import { getRecentRepliesToAuthor, getRecentReplyPhrasings, getVoiceExemplars } from "./priorReplies.js";

// A `postgres` tagged-template stand-in: records the interpolated values so the
// tests can assert what was bound, and returns whatever rows are queued.
function fakeSql(rows: Array<{ body?: string | null; post?: string | null; reply?: string | null }> | Error) {
  const calls: unknown[][] = [];
  const queries: string[] = [];
  const boundValues = (values: unknown[]): unknown[] => values.flatMap((value) =>
    value && typeof value === "object" && "values" in value && Array.isArray(value.values)
      ? boundValues(value.values) : [value]);
  const sql = ((_strings: TemplateStringsArray, ...values: unknown[]) => {
    if (!_strings.join("?").includes("from noelle.approvals")) return { strings: _strings, values };
    calls.push(boundValues(values));
    queries.push(_strings.join("?"));
    return rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows);
  }) as never;
  return { sql, calls, queries };
}

describe("getRecentRepliesToAuthor", () => {
  const base = { agentInstanceId: "ai", authorHandle: "someone", limit: 3 };

  it("short-circuits without querying when the limit is <= 0", async () => {
    const { sql, calls } = fakeSql([{ body: "x" }]);
    expect(await getRecentRepliesToAuthor(sql, { ...base, limit: 0 })).toEqual([]);
    expect(await getRecentRepliesToAuthor(sql, { ...base, limit: -1 })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("short-circuits when there is no handle AND no author id", async () => {
    const { sql, calls } = fakeSql([{ body: "x" }]);
    expect(
      await getRecentRepliesToAuthor(sql, { ...base, authorHandle: null, authorId: null }),
    ).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("does not fall back to the post author when a selected commenter is unknown", async () => {
    const { sql, calls } = fakeSql([{ body: "post author history" }]);
    for (const author of [undefined, "", "  ", "u/", " /U/ "]) {
      expect(await getRecentRepliesToAuthor(sql, { ...base, authorId: "post-author-id",
        replyTarget: { kind: "comment", ...(author === undefined ? {} : { author }) } })).toEqual([]);
    }
    expect(calls).toHaveLength(0);
  });

  it("binds a case-folded bare Reddit commenter without changing the displayed author", async () => {
    const { sql, calls } = fakeSql([]);
    const replyTarget = { kind: "comment" as const, author: " /U/CoMmEnT_AuThOr " };
    await getRecentRepliesToAuthor(sql, { ...base, replyTarget });
    expect(calls[0]).toContain("comment_author");
    expect(replyTarget.author).toBe(" /U/CoMmEnT_AuThOr ");
  });

  it("treats a BLANK author id as null so the OR cannot match other authors", async () => {
    // An empty string would bind `l.author_id = ''`, matching every other lead
    // with a blank author_id — i.e. leaking another person's replies into this
    // person's memory. Both blank forms must normalize to null.
    for (const blank of ["", "   "]) {
      const { sql, calls } = fakeSql([]);
      await getRecentRepliesToAuthor(sql, { ...base, authorId: blank });
      expect(calls[0]).toContain(null);
      expect(calls[0]).not.toContain(blank);
    }
  });

  it("passes a real author id through untouched", async () => {
    const { sql, calls } = fakeSql([]);
    await getRecentRepliesToAuthor(sql, { ...base, authorId: "uid-1" });
    expect(calls[0]).toContain("uid-1");
  });

  it("dedupes identical bodies and drops blanks, preserving order", async () => {
    const { sql } = fakeSql([
      { body: "first take" },
      { body: "  " },
      { body: "first take" },
      { body: null },
      { body: "second take" },
    ]);
    expect(await getRecentRepliesToAuthor(sql, base)).toEqual(["first take", "second take"]);
  });

  it("fails OPEN — a query error yields [] rather than breaking the draft", async () => {
    const { sql } = fakeSql(new Error("db down"));
    expect(await getRecentRepliesToAuthor(sql, base)).toEqual([]);
  });
});

describe("getRecentReplyPhrasings", () => {
  const base = { agentInstanceId: "ai", limit: 5 };

  it("short-circuits without querying when the limit is <= 0", async () => {
    const { sql, calls } = fakeSql([{ body: "x" }]);
    expect(await getRecentReplyPhrasings(sql, { ...base, limit: 0 })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("dedupes and drops blanks, preserving order", async () => {
    const { sql } = fakeSql([
      { body: "an opener" },
      { body: "an opener" },
      { body: "" },
      { body: "another" },
    ]);
    expect(await getRecentReplyPhrasings(sql, base)).toEqual(["an opener", "another"]);
  });

  it("fails OPEN on a query error", async () => {
    const { sql } = fakeSql(new Error("db down"));
    expect(await getRecentReplyPhrasings(sql, base)).toEqual([]);
  });

  it("binds the instance id and the row limit", async () => {
    const { sql, calls } = fakeSql([]);
    await getRecentReplyPhrasings(sql, { agentInstanceId: "inst-9", limit: 7 });
    expect(calls[0]).toContain("inst-9");
    expect(calls[0]).toContain(7);
  });
});

describe("ordering contract", () => {
  // The feed-wide avoid-list must be ordered by pure recency. A sent-first
  // ordering starves PENDING approvals out of the window whenever a backlog
  // exists — the avoid-list would go blind exactly when the queue is fullest and
  // repetition is most likely. The per-person query deliberately keeps
  // sent-first (a sent take is the stronger "already covered" signal).
  it("feed-wide orders by recency; per-person keeps sent-first", async () => {
    const src = await import("node:fs/promises");
    const text = await src.readFile(new URL("./priorReplies.ts", import.meta.url), "utf8");
    const perPerson = text.slice(0, text.indexOf("getRecentReplyPhrasings"));
    const feedWide = text.slice(text.indexOf("getRecentReplyPhrasings"));
    expect(perPerson).toContain("order by (a.status = 'sent') desc");
    expect(feedWide).toContain("order by coalesce(a.decided_at, a.created_at) desc");
    expect(feedWide).not.toContain("(a.status = 'sent') desc");
  });
});

describe("getVoiceExemplars", () => {
  const args = { agentInstanceId: "linkedin-instance", excludeLeadId: "lead-1", limit: 6, humanOnly: true };

  it("selects human-sent or human-edited replies before applying the recency limit", async () => {
    const { sql, queries, calls } = fakeSql([]);
    await getVoiceExemplars(sql, args);
    expect(queries[0]).toContain("d.payload->>'sent_via' = 'manual'");
    expect(queries[0]).toContain("nullif(d.payload->>'edited_body', '') is not null");
    expect(queries[0]!.indexOf("d.payload->>'sent_via' = 'manual'")).toBeLessThan(queries[0]!.indexOf("limit ?"));
    expect(calls[0]).toContain("linkedin-instance");
    expect(calls[0]).toContain("lead-1");
    expect(calls[0]).toContain(6);
    expect(calls[0]).toContain(true);
  });

  it("preserves other platforms' existing sent-example selection by default", async () => {
    const { sql, queries, calls } = fakeSql([{ post: "X post", reply: "dashboard send" }]);
    expect(await getVoiceExemplars(sql, { agentInstanceId: "x-instance", limit: 6 })).toEqual([
      { post: "X post", reply: "dashboard send" },
    ]);
    expect(queries[0]).toContain("? = false or");
    expect(calls[0]).toContain(false);
  });

  it("deduplicates and drops empty post or reply pairs", async () => {
    const { sql } = fakeSql([
      { post: "first post", reply: "sent reply" },
      { post: "same reply's other post", reply: "sent reply" },
      { post: " ", reply: "irrelevant" },
      { post: "second post", reply: "second reply" },
    ]);
    expect(await getVoiceExemplars(sql, args)).toEqual([
      { post: "first post", reply: "sent reply" },
      { post: "second post", reply: "second reply" },
    ]);
  });

  it("uses curated anchor fallback when no human example can be fetched", async () => {
    const { sql, calls } = fakeSql(new Error("db unavailable"));
    expect(await getVoiceExemplars(sql, args)).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

describe("bounded reply memory limits", () => {
  const readers = [getRecentRepliesToAuthor, getRecentReplyPhrasings, getVoiceExemplars];
  it.each(readers)("rejects non-finite or sub-one limits without querying", async (read) => {
    const { sql, calls } = fakeSql([]);
    for (const limit of [NaN, Infinity, -Infinity, 0, -1, 0.9]) {
      expect(await read(sql, { agentInstanceId: "ai", authorHandle: "target", limit })).toEqual([]);
    }
    expect(calls).toHaveLength(0);
  });
  it.each(readers)("floors finite limits and caps the query at 100 rows", async (read) => {
    const { sql, calls } = fakeSql([]);
    await read(sql, { agentInstanceId: "ai", authorHandle: "target", limit: 3.9 });
    await read(sql, { agentInstanceId: "ai", authorHandle: "target", limit: 1000 });
    expect(calls.map((call) => call.at(-1))).toEqual([3, 100]);
  });
});
