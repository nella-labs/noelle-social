import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as owner from "./patternBreakerDb.js";
import {
  setup,
  reset,
  close,
  sql,
  scope,
  instance,
  rule,
  insertRules,
} from "./patternBreakerDb.fixture.js";

const url = process.env.PATTERN_RULES_DATABASE_URL;
describe.skipIf(!url)("Complete standing rules and bounded history (native)", () => {
  beforeAll(() => setup(url!));
  beforeEach(reset);
  afterAll(() => close(url!));

  it("admits a complete measured-empty set", async () => {
    expect(await owner.loadActivePatternRules(sql, scope)).toEqual([]);
  });

  it("admits all one hundred valid standing rules", async () => {
    await insertRules(100);
    expect(await owner.loadActivePatternRules(sql, scope)).toHaveLength(100);
  });

  it("holds an oversized complete set instead of returning partial guidance", async () => {
    await insertRules(101);
    await expect(owner.loadActivePatternRules(sql, scope)).rejects.toThrow(/complete active/i);
  });

  it("holds a stale owner instead of treating its rules as measured empty", async () => {
    await sql`update noelle.agent_instances set role='reddit_intern' where id=${instance}`;
    await expect(owner.loadActivePatternRules(sql, scope)).rejects.toThrow(/owner|unavailable/i);
  });

  it("holds a malformed active instruction rather than silently filtering it out", async () => {
    const id = await rule();
    await sql`update noelle.pattern_rules set instruction=${"x".repeat(601)} where id=${id}`;
    await expect(owner.loadActivePatternRules(sql, scope)).rejects.toThrow(/admission|malformed/i);
  });

  it("bounds a blocked read, leaves no queued tail, and recovers", async () => {
    const connection = await sql.reserve();
    try {
      await connection`begin`;
      await connection`lock table noelle.pattern_rules in access exclusive mode`;
      const started = Date.now();
      await expect(owner.loadActivePatternRules(sql, scope)).rejects.toBeInstanceOf(
        owner.PatternRulesHeldError,
      );
      expect(Date.now() - started).toBeLessThan(4500);
      await connection`rollback`;
      await vi.waitFor(async () => {
        const [row] = await sql`select count(*)::int as count from pg_stat_activity
          where datname=current_database() and application_name='pattern-native'
            and state='active' and query like '%limit%' and pid<>pg_backend_pid()`;
        expect(row?.count).toBe(0);
      });
      expect(await owner.loadActivePatternRules(sql, scope)).toEqual([]);
    } finally {
      await connection`rollback`.catch(() => {});
      connection.release();
    }
  });
});
