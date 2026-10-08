import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as owner from "./patternBreakerDb.js";
import {
  setup,
  reset,
  close,
  sql,
  scope,
  operatorScope,
  org,
  foreignOrg,
  instance,
  rule,
  alert,
  insertRules,
} from "./patternBreakerDb.fixture.js";

const url = process.env.PATTERN_RULES_DATABASE_URL;
describe.skipIf(!url)("Bounded pattern rule and alert pages (native)", () => {
  beforeAll(() => setup(url!));
  beforeEach(reset);
  afterAll(() => close(url!));

  it("returns an explicit bounded rule page and continuation", async () => {
    await insertRules(60);
    const page = await owner.listPatternRules(sql, scope);
    expect(Array.isArray(page)).toBe(false);
    expect(page.rules).toHaveLength(50);
    expect(page.nextCursor).not.toBeNull();
    expect(page.total).toBe(60);
  });

  it("returns an explicit bounded visible-alert page and continuation", async () => {
    const id = await rule();
    for (let n = 0; n < 60; n++) await alert(id, { status: "open" });
    const page = await owner.loadVisibleAlerts(sql, scope);
    expect(Array.isArray(page)).toBe(false);
    expect(page.alerts).toHaveLength(50);
    expect(page.nextCursor).not.toBeNull();
    expect(page.total).toBe(60);
  });

  it("pages every active and disabled rule in stable severity/time/ID order", async () => {
    const ids: string[] = [];
    for (let n = 0; n < 9; n++) {
      const id = await rule({ active: n < 6 });
      ids.push(id);
      await sql`update noelle.pattern_rules set severity=${n % 2 ? "high" : "low"},
        created_at=${`2026-10-01T00:00:00.00000${n}Z`}::text::timestamptz where id=${id}`;
    }
    const expected = await sql<{ id: string }[]>`select id from noelle.pattern_rules
      order by active desc,case severity when 'high' then 0 when 'medium' then 1 else 2 end,created_at desc,id`;
    let cursor:
      | NonNullable<Awaited<ReturnType<typeof owner.listPatternRules>>["nextCursor"]>
      | undefined;
    const seen: string[] = [];
    do {
      const page = await owner.listPatternRules(sql, scope, {
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      expect(page.counts).toEqual({ active: 6, disabled: 3, malformedActive: 0 });
      expect(page.total).toBe(9);
      seen.push(...page.rules.map((row) => row.id));
      cursor = page.nextCursor ? JSON.parse(JSON.stringify(page.nextCursor)) : undefined;
      if (cursor) expect(cursor.createdAt).toMatch(/\.\d{6}Z$/);
    } while (cursor);
    expect(seen).toEqual(expected.map((row) => row.id));
    expect(new Set(seen).size).toBe(ids.length);
    expect((await owner.listPatternRules(sql, scope, { section: "disabled" })).rules).toHaveLength(
      3,
    );
  });

  it("retains malformed rules as bounded operator recovery rows", async () => {
    const id = await rule();
    await sql`update noelle.pattern_rules set instruction=${"x".repeat(50000)},suggestion=${"x".repeat(601)} where id=${id}`;
    const page = await owner.listPatternRules(sql, scope, { section: "active" });
    expect(page.counts.malformedActive).toBe(1);
    expect(page.rules).toEqual([
      expect.objectContaining({ id, admitted: false, suggestion: null }),
    ]);
    expect(page.rules[0]!.instruction.length).toBeLessThanOrEqual(600);
    expect(
      await sql.begin((tx) => owner.setPatternRuleActiveInTx(tx, operatorScope, id, false)),
    ).toBe(true);
    expect(await owner.loadActivePatternRules(sql, scope)).toEqual([]);
  });

  it("pages history including terminal alerts without changing the visible default", async () => {
    const id = await rule();
    for (const [n, status] of [
      "open",
      "refining",
      "refined",
      "acknowledged",
      "reverted",
    ].entries()) {
      const alertId = await alert(id, { status });
      await sql`update noelle.pattern_alerts set created_at=${`2026-10-01T00:00:00.00000${n}Z`}::text::timestamptz where id=${alertId}`;
    }
    expect((await owner.loadVisibleAlerts(sql, scope)).total).toBe(3);
    const seen: string[] = [];
    let cursor:
      | NonNullable<Awaited<ReturnType<typeof owner.loadVisibleAlerts>>["nextCursor"]>
      | undefined;
    do {
      const page = await owner.loadVisibleAlerts(sql, scope, {
        view: "history",
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      expect(page.total).toBe(5);
      seen.push(...page.alerts.map((row) => row.status));
      cursor = page.nextCursor ? JSON.parse(JSON.stringify(page.nextCursor)) : undefined;
    } while (cursor);
    expect(seen).toEqual(["reverted", "acknowledged", "refined", "refining", "open"]);
  });

  it("uses the ID keyset for tied alert timestamps", async () => {
    const id = await rule();
    const ids = await Promise.all(Array.from({ length: 4 }, () => alert(id, { status: "open" })));
    await sql`update noelle.pattern_alerts set created_at='2026-10-01T00:00:00.123456Z'`;
    const first = await owner.loadVisibleAlerts(sql, scope, { limit: 2 });
    const second = await owner.loadVisibleAlerts(sql, scope, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect([...first.alerts, ...second.alerts].map((row) => row.id)).toEqual(ids.sort());
    expect(second.nextCursor).toBeNull();
  });

  it("excludes soft foreign rows from counts and continuations", async () => {
    const foreign = await rule({ org: foreignOrg });
    await alert(foreign);
    await rule();
    const page = await owner.listPatternRules(sql, scope);
    expect(page.total).toBe(1);
    expect((await owner.loadVisibleAlerts(sql, scope)).total).toBe(0);
  });

  it("fails explicitly after current membership is removed", async () => {
    await sql`delete from noelle.org_members where org_id=${org}`;
    await expect(owner.listPatternRules(sql, operatorScope)).rejects.toThrow(/owner|unavailable/i);
    await expect(owner.loadVisibleAlerts(sql, operatorScope)).rejects.toThrow(/owner|unavailable/i);
  });

  it("rejects invalid bounds and crossed cursor sections before SQL dispatch", async () => {
    const query = vi.fn();
    const client = { query, fragments: sql } as unknown as Parameters<
      typeof owner.listPatternRules
    >[0];
    await expect(owner.listPatternRules(client, scope, { limit: 101 })).rejects.toThrow();
    await expect(owner.loadVisibleAlerts(client, scope, { limit: 0 })).rejects.toThrow();
    await expect(
      owner.listPatternRules(client, scope, {
        section: "active",
        cursor: {
          section: "disabled",
          active: false,
          severity: "high",
          createdAt: "2026-10-01T00:00:00.123456Z",
          id: instance,
        },
      }),
    ).rejects.toThrow(/section/);
    await expect(
      owner.loadVisibleAlerts(client, scope, {
        cursor: {
          view: "visible",
          createdAt: "2026-02-30T00:00:00Z",
          id: instance,
        },
      }),
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});
