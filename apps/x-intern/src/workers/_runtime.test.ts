import { describe, expect, it, vi } from "vitest";
import { runWorkerLoop } from "./_runtime.js";

describe("runWorkerLoop", () => {
  it("calls onTick once per active instance and idles when empty", async () => {
    const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() } as never;
    const ticks: string[] = [];
    let calls = 0;
    const listActive = vi.fn(async () => {
      calls++;
      if (calls === 1) return [{ id: "i1", org_id: "o1" }];
      return [];
    });
    const stopAfter = vi.fn(() => calls >= 2);
    await runWorkerLoop({
      log,
      kind: "discovery",
      pollMs: 0,
      idlePollMs: 0,
      sleep: async () => {},
      listActive,
      onTick: async (inst) => { ticks.push(inst.id); },
      shouldStop: stopAfter,
    });
    expect(ticks).toEqual(["i1"]);
    expect(listActive).toHaveBeenCalledTimes(2);
  });
});
