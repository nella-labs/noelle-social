// Moved from apps/x-intern/src/lib/worker-runs.test.ts — the only app that had a
// test for this module (linkedin/reddit/video had none), so its 2 cases are kept
// verbatim in intent. The remaining cases cover the parts of the consolidated
// superset that were previously untested: the instance_id write (video-intern's
// 0078 addition), updateSummary/isCancelRequested, and the error path.
import { describe, expect, it, vi } from "vitest";
import { recordRun } from "./workerRuns.js";

type Captured = { text: string; values: unknown[] };

/**
 * Tagged-template stub that records every query. `rows` answers the insert (it
 * must carry an id — recordRun reads rows[0].id); `laterRows`, when given,
 * answers every query after it.
 */
function fakeSql(rows: unknown[] = [{ id: "42" }], laterRows?: unknown[]) {
  const calls: Captured[] = [];
  const sql = Object.assign(
    vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join("?"), values });
      return calls.length === 1 ? rows : (laterRows ?? rows);
    }),
    { unsafe: vi.fn(), json: vi.fn((v: unknown) => v) },
  ) as never;
  return { sql, calls };
}

describe("recordRun", () => {
  it("inserts a row with status='running' and updates on finish", async () => {
    const { sql, calls } = fakeSql();
    const run = await recordRun({ sql, kind: "discovery" });
    await run.finish({ status: "ok", rowsProcessed: 3 });
    expect(calls[0]!.text).toMatch(/insert into noelle\.worker_runs/);
    expect(calls[1]!.text).toMatch(/update noelle\.worker_runs/);
  });

  it("keys worker_status by <agentRole>:<kind> so org-mates don't collide", async () => {
    const { sql } = fakeSql([{ id: "1" }]);
    const puts: Array<{ bucket: string; key: string }> = [];
    const bus = {
      agentRole: "x_intern",
      agentInstanceId: "inst-1",
      put: async (bucket: string, key: string) => {
        puts.push({ bucket, key });
      },
      emit: async () => {},
      get: async () => null,
      list: async () => [],
      tail: async () => [],
    } as unknown as NonNullable<Parameters<typeof recordRun>[0]["bus"]>;

    const run = await recordRun({ sql, kind: "profiler", bus });
    await run.finish({ status: "ok", rowsProcessed: 0 });
    expect(puts.every((p) => p.bucket === "worker_status")).toBe(true);
    // both the running + idle writes land under the role-qualified key
    expect(puts.map((p) => p.key)).toEqual(["x_intern:profiler", "x_intern:profiler"]);
  });

  it("writes instance_id when given and NULL when not", async () => {
    // 0078 added worker_runs.instance_id (nullable, no default). Only the video
    // harvester passes it; for every other worker the explicit NULL must be
    // indistinguishable from the pre-0078 two-column insert.
    const withId = fakeSql();
    await recordRun({ sql: withId.sql, kind: "harvester", instanceId: "inst-9" });
    expect(withId.calls[0]!.text).toMatch(/insert into noelle\.worker_runs \(worker, instance_id\)/);
    expect(withId.calls[0]!.values).toEqual(["harvester", "inst-9"]);

    const withoutId = fakeSql();
    await recordRun({ sql: withoutId.sql, kind: "discovery" });
    expect(withoutId.calls[0]!.values).toEqual(["discovery", null]);
  });

  it("stamps error text + emits worker.error on a failed finish", async () => {
    const { sql, calls } = fakeSql();
    const events: Array<{ topic: string; summary: string }> = [];
    const states: string[] = [];
    const bus = {
      agentRole: "reddit_intern",
      agentInstanceId: "inst-1",
      put: async (_b: string, _k: string, val: { state: string }) => {
        states.push(val.state);
      },
      emit: async (e: { topic: string; summary: string }) => {
        events.push(e);
      },
      get: async () => null,
      list: async () => [],
      tail: async () => [],
    } as unknown as NonNullable<Parameters<typeof recordRun>[0]["bus"]>;

    const run = await recordRun({ sql, kind: "classifier", bus });
    await run.finish({ status: "error", rowsProcessed: 2, errorMessage: "boom" });
    expect(calls[1]!.values).toEqual([2, "boom", "42"]);
    expect(states).toEqual(["running", "error"]);
    expect(events).toHaveLength(1);
    expect(events[0]!.topic).toBe("worker.error");
    expect(events[0]!.summary).toContain("boom");
  });

  it("clears error to NULL on an ok finish", async () => {
    const { sql, calls } = fakeSql();
    const run = await recordRun({ sql, kind: "drafter" });
    await run.finish({ status: "ok" });
    // rows_processed defaults to 0, error is NULL — never the literal "ok".
    expect(calls[1]!.values).toEqual([0, null, "42"]);
  });

  it("writes the summary through sql.json", async () => {
    const { sql, calls } = fakeSql();
    const run = await recordRun({ sql, kind: "harvester", instanceId: "inst-9" });
    await run.updateSummary({
      phase: "starting",
      lanes: [],
      totals: { pulled: 0, kept: 0 },
    } as never);
    expect(calls.at(-1)!.text).toMatch(/update noelle\.worker_runs set summary/);
  });

  it("is fail-soft: a failing summary write or cancel poll never throws into the run", async () => {
    // Only the insert must succeed; the console-facing extras are best-effort, so
    // a dead DB mid-run must not take the harvest tick down with it.
    let first = true;
    const sql = Object.assign(
      vi.fn(async () => {
        if (first) {
          first = false;
          return [{ id: "42" }];
        }
        throw new Error("db down");
      }),
      { unsafe: vi.fn(), json: vi.fn((v: unknown) => v) },
    ) as never;
    const run = await recordRun({ sql, kind: "harvester" });
    await expect(run.updateSummary({} as never)).resolves.toBeUndefined();
    await expect(run.isCancelRequested()).resolves.toBe(false);
  });

  it("reads 'not cancelled' when the poll returns no row", async () => {
    const { sql } = fakeSql([{ id: "42" }], []);
    const run = await recordRun({ sql, kind: "harvester" });
    expect(await run.isCancelRequested()).toBe(false);
  });

  it("reads cancel_requested from the run's own row", async () => {
    const { sql, calls } = fakeSql([{ id: "7", cancel_requested: true }]);
    const run = await recordRun({ sql, kind: "harvester" });
    expect(await run.isCancelRequested()).toBe(true);
    expect(calls.at(-1)!.text).toMatch(/select cancel_requested from noelle\.worker_runs/);
    expect(calls.at(-1)!.values).toEqual(["7"]);
  });
});
