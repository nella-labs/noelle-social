import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { RunSchedule } from "@noelle/contracts";
import { runSchedulerTick } from "../lib/scheduler.js";

// Fake postgres.js `sql`: records every executed query and returns the configured
// rows for the SELECT. Handles the dual nature of the client — a tagged template
// (query) vs a `sql(array)` fragment helper (used for `role in ${sql(ROLES)}`).
function makeFakeSql(dueRows: unknown[]) {
  const queries: { text: string; values: unknown[] }[] = [];
  const sql = ((...args: unknown[]) => {
    const first = args[0];
    // Fragment helper: sql(array) — a plain array with no `.raw` (TemplateStringsArray has .raw).
    if (args.length === 1 && Array.isArray(first) && !("raw" in first)) {
      return { __fragment: first };
    }
    const strings = first as readonly string[];
    const values = args.slice(1);
    const text = strings.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
    queries.push({ text, values });
    if (text.startsWith("select")) return Promise.resolve(dueRows);
    return Promise.resolve([]);
  }) as unknown as Sql;
  sql.begin = (async (fn: (tx: unknown) => Promise<unknown>) => fn(sql)) as never;
  return { sql, queries };
}

const intervalSchedule: RunSchedule = {
  enabled: true,
  mode: "interval",
  intervalHours: 6,
  timezone: "UTC",
  goal: 20,
};

const now = new Date("2026-07-12T10:00:00Z");

describe("runSchedulerTick", () => {
  it("fires an idle armed schedule with the goal, stamping the Start-all columns", async () => {
    const { sql, queries } = makeFakeSql([
      { id: "inst-1", run_schedule: intervalSchedule, goal_target: null },
    ]);

    const res = await runSchedulerTick(sql, now);

    expect(res).toEqual({ fired: 1, skipped: 0, cleared: 0 });
    const update = queries.find((q) => q.text.startsWith("update"));
    expect(update).toBeDefined();
    expect(update!.text).toMatch(/status\s*=\s*'active'/);
    expect(update!.text).toMatch(/goal_target\s*=/);
    expect(update!.text).toMatch(/goal_started_at\s*=\s*now\(\)/);
    expect(update!.text).toMatch(/run_schedule_next_at\s*=/);
    // goal (20) and a fresh next_at (now + 6h) are bound as values.
    expect(update!.values).toContain(20);
    const nextAt = update!.values.find((v) => v instanceof Date) as Date | undefined;
    expect(nextAt?.toISOString()).toBe("2026-07-12T16:00:00.000Z");
  });

  it("skips (does not stomp) an instance already mid goal-run, but rolls next_at", async () => {
    const { sql, queries } = makeFakeSql([
      { id: "inst-1", run_schedule: intervalSchedule, goal_target: 50 },
    ]);

    const res = await runSchedulerTick(sql, now);

    expect(res).toEqual({ fired: 0, skipped: 1, cleared: 0 });
    const update = queries.find((q) => q.text.startsWith("update"))!;
    // A skip only touches next_at — it must NOT re-open a goal-run.
    expect(update.text).toMatch(/run_schedule_next_at\s*=/);
    expect(update.text).not.toMatch(/goal_target\s*=/);
    expect(update.text).not.toMatch(/status\s*=\s*'active'/);
  });

  it("clears next_at for a disabled schedule so it stops firing", async () => {
    const { sql, queries } = makeFakeSql([
      {
        id: "inst-1",
        run_schedule: { ...intervalSchedule, enabled: false },
        goal_target: null,
      },
    ]);

    const res = await runSchedulerTick(sql, now);

    expect(res).toEqual({ fired: 0, skipped: 0, cleared: 1 });
    const update = queries.find((q) => q.text.startsWith("update"))!;
    expect(update.text).toMatch(/run_schedule_next_at\s*=\s*null/);
  });

  it("treats an unparseable schedule as no-schedule (clears)", async () => {
    const { sql } = makeFakeSql([
      { id: "inst-1", run_schedule: { mode: "daily" /* incomplete */ }, goal_target: null },
    ]);
    const res = await runSchedulerTick(sql, now);
    expect(res).toEqual({ fired: 0, skipped: 0, cleared: 1 });
  });

  it("does nothing when no schedules are due", async () => {
    const { sql, queries } = makeFakeSql([]);
    const res = await runSchedulerTick(sql, now);
    expect(res).toEqual({ fired: 0, skipped: 0, cleared: 0 });
    expect(queries.filter((q) => q.text.startsWith("update"))).toHaveLength(0);
  });
});
