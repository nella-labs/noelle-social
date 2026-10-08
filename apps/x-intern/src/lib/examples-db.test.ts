import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { getRecentSentExamples } from "./examples-db.js";

/**
 * postgres.js is a tagged-template client, so a fake `sql` is just a function
 * that records the template it was called with. Nested `sql\`...\`` fragments
 * come back through as values, which is how the conditional ORDER BY term is
 * spliced, so the fake resolves fragments recursively to rebuild the final SQL.
 */
function makeFakeSql(rows: unknown[] = []) {
  const calls: string[] = [];
  const render = (strings: TemplateStringsArray, vals: unknown[]): string =>
    strings.reduce((acc, s, i) => {
      if (i === strings.length - 1) return acc + s;
      const v = vals[i];
      return acc + s + (isFragment(v) ? v.__sql : `$${String(v)}`);
    }, "");

  type Fragment = { __sql: string; then?: undefined };
  const isFragment = (v: unknown): v is Fragment =>
    typeof v === "object" && v !== null && "__sql" in (v as Record<string, unknown>);

  const sql = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
    const text = render(strings, vals);
    // A fragment (no `select`) is spliced into an outer template, not executed.
    if (!/\bselect\b/i.test(text)) return { __sql: text };
    calls.push(text);
    return Promise.resolve(rows);
  }) as unknown as Sql;

  return { sql, calls };
}

const SHORT_TERM = "<= ";

describe("getRecentSentExamples", () => {
  it("returns [] without querying when limit is 0 or negative", async () => {
    const { sql, calls } = makeFakeSql([{ body: "x", edited: false }]);
    expect(await getRecentSentExamples(sql, "inst", 0)).toEqual([]);
    expect(await getRecentSentExamples(sql, "inst", -3)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("fails open to [] when the query throws (examples are a nice-to-have)", async () => {
    const sql = (() => {
      throw new Error("db down");
    }) as unknown as Sql;
    expect(await getRecentSentExamples(sql, "inst", 3)).toEqual([]);
  });

  it("trims bodies and drops empty/null ones", async () => {
    const { sql } = makeFakeSql([
      { body: "  first  ", edited: false },
      { body: null, edited: false },
      { body: "   ", edited: false },
      { body: "second", edited: true },
    ]);
    expect(await getRecentSentExamples(sql, "inst", 10)).toEqual(["first", "second"]);
  });

  describe("length ratchet fix", () => {
    // Pure-recency selection fed long sent replies back in as few-shot
    // exemplars, which bred longer replies (June avg 160 chars -> July 180 ->
    // pending queue 209). preferShort biases the exemplar set short.
    it("adds the short-preference ORDER BY term when preferShort is set", async () => {
      const { sql, calls } = makeFakeSql();
      await getRecentSentExamples(sql, "inst", 3, { preferShort: true });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain(SHORT_TERM);
      expect(calls[0]).toMatch(/length\(coalesce\(nullif\(/);
    });

    it("keeps edited-first as the top priority, ahead of the length term", async () => {
      const { sql, calls } = makeFakeSql();
      await getRecentSentExamples(sql, "inst", 3, { preferShort: true });
      const q = calls[0]!;
      const editedAt = q.indexOf("'edited' = 'true') desc");
      const lengthAt = q.indexOf("length(coalesce(nullif(");
      expect(editedAt).toBeGreaterThan(-1);
      expect(lengthAt).toBeGreaterThan(editedAt);
    });

    it("keeps recency as the tiebreak, so a thin short set still fills", async () => {
      const { sql, calls } = makeFakeSql();
      await getRecentSentExamples(sql, "inst", 3, { preferShort: true });
      const q = calls[0]!;
      expect(q.indexOf("a.decided_at desc nulls last")).toBeGreaterThan(
        q.indexOf("length(coalesce(nullif("),
      );
      // A soft ORDER BY preference, never a WHERE filter: filtering would
      // starve the exemplar set when few short replies exist. Check the WHERE
      // clause itself, not the whole statement (the ORDER BY term legitimately
      // sits after `where` in the text).
      const whereClause = q.slice(q.indexOf("where "), q.indexOf("order by"));
      expect(whereClause).not.toMatch(/length\(/);
    });

    it("does NOT bias by length by default", async () => {
      // The reply-diversity gate reuses this function as its near-duplicate
      // corpus and needs strict recency; short-biasing it would let a recent
      // long reply fall out of the dedup set and get repeated.
      const { sql, calls } = makeFakeSql();
      await getRecentSentExamples(sql, "inst", 3);
      expect(calls[0]).not.toContain(SHORT_TERM);
      expect(calls[0]).not.toMatch(/length\(coalesce\(nullif\(/);
    });

    it("default ordering is still edited-first then recency", async () => {
      const { sql, calls } = makeFakeSql();
      await getRecentSentExamples(sql, "inst", 3);
      const q = calls[0]!;
      expect(q.indexOf("a.decided_at desc nulls last")).toBeGreaterThan(
        q.indexOf("'edited' = 'true') desc"),
      );
    });
  });
});
