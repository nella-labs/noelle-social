import { describe, expect, it } from "vitest";
import { batchMap } from "./batchMap.js";

/** Resolve after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("batchMap", () => {
  it("returns [] immediately for empty input", async () => {
    let called = false;
    const out = await batchMap(
      [],
      async () => {
        called = true;
        return 1;
      },
      { concurrency: 4 },
    );
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  it("preserves input order even when later items settle first", async () => {
    // Earlier items take longer, so completion order is reversed; the result
    // array must still line up with the input order.
    const items = [50, 40, 30, 20, 10];
    const out = await batchMap(
      items,
      async (ms, i) => {
        await delay(ms);
        return `${i}:${ms}`;
      },
      { concurrency: 5 },
    );
    expect(out).toEqual([
      { ok: true, value: "0:50" },
      { ok: true, value: "1:40" },
      { ok: true, value: "2:30" },
      { ok: true, value: "3:20" },
      { ok: true, value: "4:10" },
    ]);
  });

  it("passes the correct index to fn", async () => {
    const seen: number[] = [];
    await batchMap(
      ["a", "b", "c"],
      async (_item, i) => {
        seen.push(i);
        return i;
      },
      { concurrency: 1 },
    );
    expect(seen).toEqual([0, 1, 2]);
  });

  it("never exceeds the concurrency limit (in-flight counter)", async () => {
    const concurrency = 3;
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 20 }, (_v, i) => i);

    const out = await batchMap(
      items,
      async (n) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // Small delay so multiple workers overlap in the window.
        await delay(5);
        inFlight -= 1;
        return n * 2;
      },
      { concurrency },
    );

    expect(maxInFlight).toBeGreaterThan(1); // proves it actually parallelizes
    expect(maxInFlight).toBeLessThanOrEqual(concurrency);
    expect(out.map((r) => (r.ok ? r.value : null))).toEqual(
      items.map((n) => n * 2),
    );
  });

  it("runs all items but never more than the limit at once with a low cap", async () => {
    const concurrency = 1;
    let inFlight = 0;
    let maxInFlight = 0;
    const items = [1, 2, 3, 4];

    await batchMap(
      items,
      async (n) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await delay(2);
        inFlight -= 1;
        return n;
      },
      { concurrency },
    );

    expect(maxInFlight).toBe(1);
  });

  it("isolates a rejecting item: it becomes {ok:false} while others succeed", async () => {
    const out = await batchMap(
      [0, 1, 2, 3],
      async (n) => {
        if (n === 2) throw new Error("boom-2");
        return n * 10;
      },
      { concurrency: 2 },
    );

    expect(out[0]).toEqual({ ok: true, value: 0 });
    expect(out[1]).toEqual({ ok: true, value: 10 });
    const r2 = out[2];
    if (!r2 || r2.ok) throw new Error("expected out[2] to be a failure result");
    expect(r2.error).toBeInstanceOf(Error);
    expect((r2.error as Error).message).toBe("boom-2");
    expect(out[3]).toEqual({ ok: true, value: 30 });
  });

  it("does not reject the batch even when every item throws", async () => {
    const out = await batchMap(
      [1, 2, 3],
      async (n) => {
        throw n; // non-Error rejection value is preserved verbatim
      },
      { concurrency: 2 },
    );
    expect(out).toEqual([
      { ok: false, error: 1 },
      { ok: false, error: 2 },
      { ok: false, error: 3 },
    ]);
  });

  it("coerces concurrency <= 0 to 1 (still processes everything sequentially)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const out = await batchMap(
      [1, 2, 3],
      async (n) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await delay(2);
        inFlight -= 1;
        return n;
      },
      { concurrency: 0 },
    );
    expect(maxInFlight).toBe(1);
    expect(out).toEqual([
      { ok: true, value: 1 },
      { ok: true, value: 2 },
      { ok: true, value: 3 },
    ]);
  });

  it("coerces a negative concurrency to 1", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await batchMap(
      [1, 2, 3, 4],
      async (n) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await delay(2);
        inFlight -= 1;
        return n;
      },
      { concurrency: -5 },
    );
    expect(maxInFlight).toBe(1);
  });

  it("coerces NaN concurrency to 1", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await batchMap(
      [1, 2, 3],
      async (n) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await delay(2);
        inFlight -= 1;
        return n;
      },
      { concurrency: Number.NaN },
    );
    expect(maxInFlight).toBe(1);
  });

  it("treats Infinity concurrency as 1 (non-finite coercion), not unbounded", async () => {
    // Infinity is non-finite, so per the contract it coerces to 1 rather than
    // launching every item at once.
    let inFlight = 0;
    let maxInFlight = 0;
    await batchMap(
