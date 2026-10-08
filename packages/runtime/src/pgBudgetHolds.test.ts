import { describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { readPgBudgetHolds } from "./pgBudgetHolds.js";

describe("budget hold cursor validation", () => {
  it.each([
    { admittedAt: "not a timestamp", id: "11111111-1111-1111-1111-111111111111" },
    { admittedAt: "2026-10-05 12:00:00.123456+00", id: "not a uuid" },
    { admittedAt: "2026-10-05 12:00:00.123456+00", id: "11111111-1111-1111-1111-111111111111", extra: true },
  ])("rejects a malformed cursor before creating a database operation: %j", async (cursor) => {
    const sql = vi.fn() as unknown as Sql;
    await expect(readPgBudgetHolds(sql, { orgId: "org", cursor })).rejects.toThrow("Invalid budget hold cursor");
    expect(sql).not.toHaveBeenCalled();
  });
});
