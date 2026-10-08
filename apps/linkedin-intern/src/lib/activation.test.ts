import { describe, expect, it, vi } from "vitest";
import {
  listActiveLinkedinInternInstances,
  listActiveOrPausedLinkedinInternInstances,
  listProfilerLinkedinInternInstances,
  isWorkerEnabled,
  type ActiveInstance,
} from "./activation.js";

// A sql tag mock that records each call's args so we can assert the status
// filter each selector interpolates. The tagged template is invoked as
// sql(strings, ...values); the only interpolated value is the status list.
function mockSqlTag(rows: unknown[] = []) {
  const calls: unknown[][] = [];
  const tag = Object.assign(
    vi.fn(async (...args: unknown[]) => {
      calls.push(args);
      return rows;
    }),
    { unsafe: vi.fn() },
  ) as unknown as Parameters<typeof listActiveLinkedinInternInstances>[0];
  return { tag, calls };
}

describe("listActiveLinkedinInternInstances", () => {
  it("returns rows from the query", async () => {
    const rows = [{ id: "i1", org_id: "o1" }];
    const { tag } = mockSqlTag(rows);
    expect(await listActiveLinkedinInternInstances(tag)).toEqual(rows);
  });

  it("filters to active instances only", async () => {
    const { tag, calls } = mockSqlTag();
    await listActiveLinkedinInternInstances(tag);
    expect(calls[0]?.[1]).toEqual(["active"]);
  });
});

describe("listProfilerLinkedinInternInstances", () => {
  it("includes paused instances too (profiler is decoupled from pause)", async () => {
    const { tag, calls } = mockSqlTag();
    await listProfilerLinkedinInternInstances(tag);
    expect(calls[0]?.[1]).toEqual(["active", "paused"]);
  });
});

describe("listActiveOrPausedLinkedinInternInstances", () => {
  it("includes paused instances too (the always-on watchlist lane needs them)", async () => {
    const { tag, calls } = mockSqlTag();
    await listActiveOrPausedLinkedinInternInstances(tag);
    expect(calls[0]?.[1]).toEqual(["active", "paused"]);
  });
});

describe("isWorkerEnabled", () => {
  const base: ActiveInstance = { id: "i", org_id: "o" };

  it("defaults to enabled when the flag is absent (unbackfilled rows)", () => {
    expect(isWorkerEnabled(base, "discovery")).toBe(true);
    expect(isWorkerEnabled(base, "drafter")).toBe(true);
  });

  it("is disabled only when the flag is explicitly false", () => {
    expect(isWorkerEnabled({ ...base, classifier_enabled: false }, "classifier")).toBe(false);
    expect(isWorkerEnabled({ ...base, classifier_enabled: true }, "classifier")).toBe(true);
  });

  it("gates each worker on its own flag", () => {
    const inst: ActiveInstance = { ...base, discovery_enabled: false, drafter_enabled: true };
    expect(isWorkerEnabled(inst, "discovery")).toBe(false);
    expect(isWorkerEnabled(inst, "drafter")).toBe(true);
    expect(isWorkerEnabled(inst, "classifier")).toBe(true); // absent → on
  });

  it("gates the profiler on profiler_enabled (absent → on, false → off)", () => {
    expect(isWorkerEnabled(base, "profiler")).toBe(true);
    expect(isWorkerEnabled({ ...base, profiler_enabled: true }, "profiler")).toBe(true);
    expect(isWorkerEnabled({ ...base, profiler_enabled: false }, "profiler")).toBe(false);
  });

  it("gates the always-on watchlist lane on watchlist_enabled (absent → on, false → off)", () => {
    expect(isWorkerEnabled(base, "watchlist")).toBe(true);
    expect(isWorkerEnabled({ ...base, watchlist_enabled: true }, "watchlist")).toBe(true);
    expect(isWorkerEnabled({ ...base, watchlist_enabled: false }, "watchlist")).toBe(false);
  });
});
