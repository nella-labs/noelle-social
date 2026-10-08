import { describe, expect, it } from "vitest";
import { createRunReceiptStore } from "./apifyRunReceipts.js";

describe("per-operation Apify receipts", () => {
  it("replaces polling observations and retains distinct runs, including failed charges", () => {
    const store = createRunReceiptStore();
    const first = store.beginRun("first");
    first.observe({ id: "r1", status: "RUNNING", usageTotalUsd: 0.1 });
    first.observe({ id: "r1", status: "SUCCEEDED", usageTotalUsd: 0.3 });
    first.setCoverage({ resultCount: 120, resultCountComplete: true, fetchedResultCount: 2 });
    store.beginRun("second").observe({ id: "r2", status: "FAILED", usageTotalUsd: 0.2 });
    expect(store.drainLastRunUsd()).toBe(0.5);
    expect(store.drainLastRunUsd()).toBeNull();
    expect(store.drain()).toEqual([
      expect.objectContaining({ runId: "r1", actualUsd: 0.3, resultCount: 120, fetchedResultCount: 2 }),
      expect.objectContaining({ runId: "r2", terminal: true, actualUsd: 0.2, resultCountComplete: false }),
    ]);
    expect(store.drain()).toEqual([]);
  });

  it.each([undefined, null, "0.1", -1, NaN, Infinity])("does not fabricate final usage %j", usageTotalUsd => {
    const store = createRunReceiptStore();
    store.beginRun("actor").observe({ status: "SUCCEEDED", usageTotalUsd });
    expect(store.drainLastRunUsd()).toBeNull();
    expect(store.drain()[0]?.actualUsd).toBeNull();
  });

  it("preserves real zero and keeps provisional usage unknown", () => {
    const store = createRunReceiptStore();
    store.beginRun("actor").observe({ status: "RUNNING", usageTotalUsd: 0.2 });
    expect(store.drainLastRunUsd()).toBeNull();
    store.clear();
    store.beginRun("actor").observe({ status: "SUCCEEDED", usageTotalUsd: 0 });
    expect(store.drainLastRunUsd()).toBe(0);
  });

  it("checks capacity before another paid run and clears all prior operation state", () => {
    const store = createRunReceiptStore(1);
    store.beginRun("one").observe({ id: "old", status: "SUCCEEDED", usageTotalUsd: 0.2 });
    expect(() => store.beginRun("two")).toThrow(/run limit/);
    store.clear();
    expect(store.drain()).toEqual([]);
    store.beginRun("two");
    expect(store.drainLastRunUsd()).toBeNull();
    expect(store.drain()[0]?.runId).toBeNull();
  });
});
