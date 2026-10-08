import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { countSentDmsToAuthor, getRecentDmsToAuthor } from "./dmLadderDb.js";

/** A fake `sql` tag: called as sql`...${v}...`, resolves to `rows` (or throws). */
function fakeSql(rows: unknown[] | (() => never)): Sql {
  return ((_s: TemplateStringsArray, ..._v: unknown[]) => {
    if (typeof rows === "function") return rows();
    return Promise.resolve(rows);
  }) as unknown as Sql;
}

describe("countSentDmsToAuthor", () => {
  it("returns the count from the query", async () => {
    const n = await countSentDmsToAuthor(fakeSql([{ n: 2 }]), {
      agentInstanceId: "inst",
      authorHandle: "kaia-tham",
    });
    expect(n).toBe(2);
  });

  it("returns 0 when no author key is known (never hits the DB)", async () => {
    let called = false;
    const sql = ((..._a: unknown[]) => {
      called = true;
      return Promise.resolve([{ n: 5 }]);
    }) as unknown as Sql;
    expect(await countSentDmsToAuthor(sql, { agentInstanceId: "inst", authorHandle: null })).toBe(0);
    expect(called).toBe(false);
  });

  it("fails safe to 0 on a DB error", async () => {
    const sql = fakeSql(() => {
      throw new Error("db down");
    });
    expect(await countSentDmsToAuthor(sql, { agentInstanceId: "inst", authorHandle: "x" })).toBe(0);
  });
});

describe("getRecentDmsToAuthor", () => {
  it.each([NaN, Infinity, -Infinity, -1, 0.5])("declines invalid or sub-integer limit %s before querying", async (limit) => {
    let queried = false;
    const checked = (() => {
      queried = true;
      throw new Error("unexpected query");
    }) as unknown as Sql;
    expect(await getRecentDmsToAuthor(checked, { agentInstanceId: "i", authorHandle: "target", limit })).toEqual([]);
    expect(queried).toBe(false);
  });

  it("returns [] for limit <= 0 without querying", async () => {
    let called = false;
    const sql = ((..._a: unknown[]) => {
      called = true;
      return Promise.resolve([]);
    }) as unknown as Sql;
    expect(await getRecentDmsToAuthor(sql, { agentInstanceId: "i", authorHandle: "x", limit: 0 })).toEqual([]);
    expect(called).toBe(false);
  });

  it("dedupes identical bodies and drops blanks, preserving order", async () => {
    const sql = fakeSql([
      { body: "hey, what fought back hardest?" },
      { body: "  " },
      { body: "hey, what fought back hardest?" },
      { body: "loved the demo teardown" },
    ]);
    const out = await getRecentDmsToAuthor(sql, { agentInstanceId: "i", authorHandle: "x", limit: 10 });
    expect(out).toEqual(["hey, what fought back hardest?", "loved the demo teardown"]);
  });

  it("fails open to [] on a DB error", async () => {
    const sql = fakeSql(() => {
      throw new Error("boom");
    });
    expect(await getRecentDmsToAuthor(sql, { agentInstanceId: "i", authorHandle: "x", limit: 5 })).toEqual([]);
  });
});
