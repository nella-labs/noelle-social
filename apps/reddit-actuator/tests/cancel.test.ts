import { describe, it, expect } from "vitest";
import { abortableSleep, throwIfAborted, AbortError, isAbortError } from "../src/lib/cancel.js";

describe("abortableSleep", () => {
  it("resolves immediately when the signal is already aborted (the STOP case)", async () => {
    const ac = new AbortController();
    ac.abort();
    const start = Date.now();
    await abortableSleep(10_000, ac.signal); // a 10s reading dwell
    expect(Date.now() - start).toBeLessThan(200); // did NOT wait it out
  });

  it("resolves early when aborted mid-flight", async () => {
    const ac = new AbortController();
    const start = Date.now();
    const p = abortableSleep(10_000, ac.signal);
    setTimeout(() => ac.abort(), 20);
    await p;
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("still waits the full delay when never aborted", async () => {
    const ac = new AbortController();
    const start = Date.now();
    await abortableSleep(40, ac.signal);
    expect(Date.now() - start).toBeGreaterThanOrEqual(30);
  });

  it("does not leak: a resolved sleep ignores a later abort", async () => {
    const ac = new AbortController();
    await abortableSleep(5, ac.signal);
    // Aborting after it already resolved must not throw or double-resolve.
    expect(() => ac.abort()).not.toThrow();
  });
});

describe("throwIfAborted", () => {
  it("throws an AbortError once aborted", () => {
    const ac = new AbortController();
    ac.abort();
    expect(() => throwIfAborted(ac.signal)).toThrow(AbortError);
    let caught: unknown;
    try {
      throwIfAborted(ac.signal);
    } catch (e) {
      caught = e;
    }
    expect(isAbortError(caught)).toBe(true);
  });

  it("is a no-op while the run is live", () => {
    const ac = new AbortController();
    expect(() => throwIfAborted(ac.signal)).not.toThrow();
  });

  it("isAbortError only matches abort errors", () => {
    expect(isAbortError(new Error("boom"))).toBe(false);
    expect(isAbortError(new AbortError())).toBe(true);
  });
});
