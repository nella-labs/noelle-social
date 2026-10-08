import { randomInt } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readXBrowserReplyCap, readXBrowserReplyCapInTransaction, writeXBrowserReplyCap } from "./x-browser-reply-cap-db.js";

const { drawInteger } = vi.hoisted(() => ({ drawInteger: vi.fn<(min: number, max: number) => number>() }));
vi.mock("node:crypto", async importOriginal => ({
  ...await importOriginal<typeof import("node:crypto")>(), randomInt: drawInteger,
}));
const identity = { orgId: "org", instanceId: "instance" };
function database() {
  const row = { actuator_daily_reply_cap: 140, actuator_daily_reply_cap_min: 80 as number | null,
    sampled_day: "2026-10-06" as string | null, actuator_daily_reply_cap_effective: 120 as number | null,
    today: "2026-10-07" };
  const queries: string[] = [];
  let exists = true;
  const tag = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?"); queries.push(query);
    if (query.includes("from noelle.agent_instances")) return exists ? [{ ...row }] : [];
    if (query.includes("update noelle.agent_instances")) {
      if (query.includes("actuator_daily_reply_cap_min=")) {
        [row.actuator_daily_reply_cap, row.actuator_daily_reply_cap_min, row.sampled_day,
          row.actuator_daily_reply_cap_effective] = values as [number, number | null, string | null, number | null];
      } else [row.sampled_day, row.actuator_daily_reply_cap_effective] = values as [string, number];
    }
    return [];
  };
  const begin = vi.fn(async (fn: (tx: TransactionSql) => Promise<unknown>) => fn(tag as unknown as TransactionSql));
  return { sql: Object.assign(tag, { begin }) as unknown as Sql, row, queries, begin,
    remove: () => { exists = false; } };
}

describe("X daily cap owner", () => {
  beforeEach(() => { drawInteger.mockReset(); });
  it("draws from the full inclusive range while excluding yesterday's value", async () => {
    const db = database(); drawInteger.mockReturnValue(120);
    expect(await readXBrowserReplyCap(db.sql, identity)).toEqual({
      cap: 121, configuredCap: 140, minimum: 80, day: "2026-10-07",
    });
    expect(randomInt).toHaveBeenCalledWith(80, 140);
    expect(db.row.actuator_daily_reply_cap_effective).toBe(121);
    expect(db.row.sampled_day).toBe("2026-10-07");
    expect(db.queries).toContain("set local lock_timeout='5s'");
    expect(db.queries).toContain("set local statement_timeout='10s'");
    expect(db.queries).toContain("for update");
    await readXBrowserReplyCap(db.sql, identity);
    expect(randomInt).toHaveBeenCalledTimes(1);
  });
  it.each([[80, 139, 140], [140, 80, 80]])("can reach either endpoint excluding %i", async (previous, drawn, result) => {
    const db = database(); db.row.actuator_daily_reply_cap_effective = previous;
    drawInteger.mockReturnValue(drawn);
    expect((await readXBrowserReplyCap(db.sql, identity))?.cap).toBe(result);
  });
  it("uses the full range when the previous value lies outside a changed policy", async () => {
    const db = database(); db.row.actuator_daily_reply_cap_effective = 150;
    drawInteger.mockReturnValue(80);
    expect((await readXBrowserReplyCap(db.sql, identity))?.cap).toBe(80);
    expect(randomInt).toHaveBeenCalledWith(80, 141);
  });
  it("does not draw or lock a fixed policy", async () => {
    const db = database(); db.row.actuator_daily_reply_cap_min = null;
    expect(await readXBrowserReplyCap(db.sql, identity)).toEqual({ cap: 140 });
    expect(randomInt).not.toHaveBeenCalled();
    expect(db.queries).not.toContain("for update");
    expect(db.queries.some(query => query.includes("update noelle.agent_instances"))).toBe(false);
  });
  it("reuses a claim's transaction without opening a second transaction", async () => {
    const db = database(); db.row.sampled_day = db.row.today;
    expect((await readXBrowserReplyCapInTransaction(db.sql as unknown as TransactionSql, identity))?.cap).toBe(120);
    expect(db.begin).not.toHaveBeenCalled();
    expect(db.queries.some(query => query.includes("role='x_intern'"))).toBe(true);
  });
  it("starts at the ceiling, clamps edits, and clears every variation field on a legacy write", async () => {
    const db = database(); db.row.actuator_daily_reply_cap_min = null;
    expect((await writeXBrowserReplyCap(db.sql, identity, { cap: 140, minimum: 80 }))?.cap).toBe(140);
    db.row.actuator_daily_reply_cap_effective = 120;
    expect((await writeXBrowserReplyCap(db.sql, identity, { cap: 110, minimum: 80 }))?.cap).toBe(110);
    expect(await writeXBrowserReplyCap(db.sql, identity, { cap: 0 })).toEqual({ cap: 0 });
    expect(db.row).toMatchObject({ actuator_daily_reply_cap_min: null, sampled_day: null,
      actuator_daily_reply_cap_effective: null });
    expect(randomInt).not.toHaveBeenCalled();
  });
  it("withholds corrupt policy state and missing owners", async () => {
    const db = database(); db.row.actuator_daily_reply_cap_min = 150;
    await expect(readXBrowserReplyCap(db.sql, identity)).rejects.toThrow("Invalid saved");
    db.remove();
    expect(await readXBrowserReplyCap(db.sql, identity)).toBeNull();
    expect(await writeXBrowserReplyCap(db.sql, identity, { cap: 140 })).toBeNull();
  });
  it("rejects an invalid write before opening a transaction", async () => {
    const db = database();
    await expect(writeXBrowserReplyCap(db.sql, identity, { cap: 140, minimum: 141 })).rejects.toThrow();
    expect(db.begin).not.toHaveBeenCalled();
    expect(db.queries).toEqual([]);
  });
});
