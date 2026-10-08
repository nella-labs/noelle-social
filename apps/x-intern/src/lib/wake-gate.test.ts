import { describe, expect, it, vi } from "vitest";
import { createWakeGate } from "./wake-gate.js";

describe("X worker notification wake", () => {
  it("consumes a notification received before entering the poll sleep", async () => {
    const gate = createWakeGate();
    gate.wake();
    const sleep = gate.sleep(60_000);
    await expect(sleep).resolves.toBeUndefined();
  });

  it("wakes a sleeping worker without waiting for the normal poll interval", async () => {
    vi.useFakeTimers();
    try {
      const gate = createWakeGate();
      const sleep = gate.sleep(60_000);
      gate.wake();
      await expect(sleep).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
