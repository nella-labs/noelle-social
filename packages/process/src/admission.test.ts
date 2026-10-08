import { afterEach, expect, it, vi } from "vitest";
import { BoundedProcessQueue } from "./admission.js";
import { CliProcessError } from "./cliProcess.js";
function gate() {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { pending, finish };
}
afterEach(() => vi.useRealTimers());
it("admits32 requests, executes four at once, and preserves FIFO", async () => {
  const queue = new BoundedProcessQueue(),
    held = gate(),
    started: number[] = [];
  const reads = Array.from({ length: 32 }, (_, i) =>
    queue.run(performance.now() + 5000, async () => {
      started.push(i);
      await held.pending;
      return i;
    }),
  );
  expect(started).toEqual([0, 1, 2, 3]);
  expect(() => queue.checkAvailable()).toThrow("busy");
  await expect(queue.run(performance.now() + 5000, async () => 33)).rejects.toMatchObject({
    code: "busy",
  });
  held.finish();
  expect(await Promise.all(reads)).toEqual(Array.from({ length: 32 }, (_, i) => i));
  expect(started).toEqual(Array.from({ length: 32 }, (_, i) => i));
});
it("expires waiting work before executing its callback", async () => {
  vi.useFakeTimers();
  const queue = new BoundedProcessQueue(),
    held = gate(),
    callback = vi.fn(async () => 1);
  const active = Array.from({ length: 4 }, () =>
    queue.run(performance.now() + 5000, () => held.pending),
  );
  const waiting = queue.run(performance.now() + 20, callback).catch((error) => error);
  await vi.advanceTimersByTimeAsync(30);
  expect(await waiting).toMatchObject({ code: "timeout" });
  expect(callback).not.toHaveBeenCalled();
  held.finish();
  await Promise.all(active);
});
it("checks the original deadline after resource closure", async () => {
  vi.useFakeTimers({ toFake: ["performance"] });
  const queue = new BoundedProcessQueue(),
    held = gate();
  const result = queue
    .run(performance.now() + 20, async () => {
      await held.pending;
      return "late";
    })
    .catch((error) => error);
  await vi.advanceTimersByTimeAsync(30);
  held.finish();
  expect(await result).toMatchObject({ code: "timeout" });
});
it("closes admission after failed process cleanup and rejects queued work", async () => {
  const queue = new BoundedProcessQueue(),
    held = gate();
  const outcomes = Array.from({ length: 8 }, (_, i) =>
    queue
      .run(performance.now() + 5000, async () => {
        await held.pending;
        if (i === 0) throw new CliProcessError("cleanup_failed");
        return i;
      })
      .catch((error) => error),
  );
  held.finish();
  const results = await Promise.all(outcomes);
  expect(results[0]).toBeInstanceOf(CliProcessError);
  expect(results.slice(1, 4)).toEqual([1, 2, 3]);
  expect(results.slice(4).every((value) => value.code === "cleanup_failed")).toBe(true);
  await expect(queue.run(performance.now() + 5000, async () => 1)).rejects.toMatchObject({
    code: "cleanup_failed",
  });
});
it("releases failed callbacks and rejects invalid deadlines without dispatch", async () => {
  const queue = new BoundedProcessQueue(),
    callback = vi.fn(async () => 1);
  await expect(queue.run(NaN, callback)).rejects.toMatchObject({ code: "timeout" });
  expect(callback).not.toHaveBeenCalled();
  await expect(
    queue.run(performance.now() + 5000, async () => {
      throw new Error("failed");
    }),
  ).rejects.toThrow("failed");
  expect(await queue.run(performance.now() + 5000, callback)).toBe(1);
});
