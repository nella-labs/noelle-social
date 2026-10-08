import { describe, expect, it, vi } from "vitest";
import {
  listActiveXInternInstances,
  listProfilerXInternInstances,
  listWatchlistOrActiveXInternInstances,
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
  ) as unknown as Parameters<typeof listActiveXInternInstances>[0];
  return { tag, calls };
}

describe("listActiveXInternInstances", () => {
  it("returns rows from the query", async () => {
    const rows = [{ id: "i1", org_id: "o1" }];
    const { tag } = mockSqlTag(rows);
    expect(await listActiveXInternInstances(tag)).toEqual(rows);
  });

  it("filters to active instances only", async () => {
    const { tag, calls } = mockSqlTag();
    await listActiveXInternInstances(tag);
    expect(calls[0]?.[1]).toEqual(["active"]);
  });
});

describe("listProfilerXInternInstances", () => {
  it("includes paused instances too (profiler is decoupled from pause)", async () => {
    const { tag, calls } = mockSqlTag();
    await listProfilerXInternInstances(tag);
    expect(calls[0]?.[1]).toEqual(["active", "paused"]);
  });
});

describe("listWatchlistOrActiveXInternInstances", () => {
  it("includes paused instances too (the watchlist lane is always-on)", async () => {
    const { tag, calls } = mockSqlTag();
    await listWatchlistOrActiveXInternInstances(tag);
    expect(calls[0]?.[1]).toEqual(["active", "paused"]);
  });

  it("returns paused relationship-DM instances even when the watchlist lane is off", async () => {
    const row = {
      id: "dm-only",
      org_id: "org-1",
      status: "paused",
      watchlist_enabled: false,
      lane_config: { dms: { relationship_dms_enabled: true } },
    };
    const { tag } = mockSqlTag([row]);
    expect(await listWatchlistOrActiveXInternInstances(tag)).toEqual([row]);
  });
});

describe("isWorkerEnabled", () => {
  const base: ActiveInstance = { id: "i", org_id: "o" };

  it("defaults to enabled when the flag is absent (pre-0019 / unbackfilled rows)", () => {
    expect(isWorkerEnabled(base, "discovery")).toBe(true);
    expect(isWorkerEnabled(base, "send")).toBe(true);
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

  it("gates the watchlist lane on watchlist_enabled (absent → on, false → off)", () => {
    expect(isWorkerEnabled(base, "watchlist")).toBe(true);
    expect(isWorkerEnabled({ ...base, watchlist_enabled: true }, "watchlist")).toBe(true);
    expect(isWorkerEnabled({ ...base, watchlist_enabled: false }, "watchlist")).toBe(false);
  });
});
