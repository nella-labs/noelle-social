import { describe, expect, it, vi } from "vitest";
import { createWakeGate } from "./wake-gate.js";

describe("worker wake gate", () => {
  it("ends a poll sleep as soon as a notification arrives", async () => {
    vi.useFakeTimers();
    try {
      const gate = createWakeGate();
      const done = vi.fn();
      const sleeping = gate.sleep(30_000).then(done);
      gate.wake();
      await sleeping;
      expect(done).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("remembers a notification that arrived just before the worker slept", async () => {
    vi.useFakeTimers();
    try {
      const gate = createWakeGate();
      gate.wake();
      await gate.sleep(30_000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
