import { describe, it, expect } from "vitest";
import { makeSerialQueue } from "../src/lib/serialize.js";

function deferred<T = void>() {
  let resolve!: (v: T | PromiseLike<T>) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Flush microtasks + a macrotask so queued ops actually start.
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("makeSerialQueue", () => {
  it("runs ops strictly in FIFO order, never overlapping", async () => {
    const q = makeSerialQueue();
    const events: string[] = [];
    const d1 = deferred();
    const d2 = deferred();

    const p1 = q(async () => {
      events.push("start1");
      await d1.promise;
      events.push("end1");
    });
    const p2 = q(async () => {
      events.push("start2");
      await d2.promise;
      events.push("end2");
    });

    await flush();
    // op2 must NOT have started while op1 is still in flight.
    expect(events).toEqual(["start1"]);

    d1.resolve();
    await p1;
    await flush();
    // op1 finished → op2 starts, still no overlap.
    expect(events).toEqual(["start1", "end1", "start2"]);

    d2.resolve();
    await p2;
    expect(events).toEqual(["start1", "end1", "start2", "end2"]);
  });

  it("a rejecting op does not wedge the chain — the next op still runs", async () => {
    const q = makeSerialQueue();
    const ran: string[] = [];
    const p1 = q(async () => {
      ran.push("a");
      throw new Error("boom");
    });
    const p2 = q(async () => {
      ran.push("b");
    });

    await expect(p1).rejects.toThrow("boom");
    await p2;
    expect(ran).toEqual(["a", "b"]);
  });

  it("returns each op's own settlement", async () => {
    const q = makeSerialQueue();
    await expect(q(async () => {})).resolves.toBeUndefined();
    await expect(
      q(async () => {
        throw new Error("x");
      }),
    ).rejects.toThrow("x");
  });
});
