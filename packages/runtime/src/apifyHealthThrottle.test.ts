import { describe, expect, it, vi } from "vitest";
import { createThrottledApifyHealthSweep } from "./apifyHealthSweep.js";

const result = { pruned: 0, checked: 1, invalidated: 0, alive: 1, inconclusive: 0 };
function heldRun() {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  return { release, run: vi.fn(async () => { await gate; return result; }) };
}

describe("health sweep roster and in-flight ownership", () => {
  it("admits one overlapping run, stamps only completion, and then expires", async () => {
    let now = 0;
    const held = heldRun();
    const sweep = createThrottledApifyHealthSweep({ intervalMs: 1000, now: () => now, run: held.run });
    const first = sweep("one");
    try {
      now = 2000;
      const second = sweep("one");
      expect(held.run).toHaveBeenCalledTimes(1);
      held.release();
      expect(await second).toBeNull();
    } finally { held.release(); await first; }
    now = 2999;
    expect(await sweep("one")).toBeNull();
    now = 3000;
    expect(await sweep("one")).toEqual(result);
  });

  it("keeps a removed executing claim until it settles, including remove and readd", async () => {
    const held = heldRun();
    const sweep = createThrottledApifyHealthSweep({ intervalMs: 1000, now: () => 0, run: held.run });
    const first = sweep("one");
    try {
      sweep.reconcileOrganizations([]);
      sweep.reconcileOrganizations(["one"]);
      expect(await sweep("one")).toBeNull();
      expect(held.run).toHaveBeenCalledTimes(1);
    } finally { held.release(); await first; }
    expect(await sweep("one")).toBeNull();
  });

  it("does not restore a removed organization's old completion", async () => {
    const held = heldRun();
    const sweep = createThrottledApifyHealthSweep({ intervalMs: 1000, now: () => 0, run: held.run });
    const first = sweep("one");
    try { sweep.reconcileOrganizations([]); }
    finally { held.release(); await first; }
    sweep.reconcileOrganizations(["one"]);
    expect(await sweep("one")).toEqual(result);
    expect(held.run).toHaveBeenCalledTimes(2);
  });

  it("drops inactive completed state and preserves live completions", async () => {
    const run = vi.fn(async () => result);
    const sweep = createThrottledApifyHealthSweep({ intervalMs: 1000, now: () => 0, run });
    await sweep("one"); await sweep("two");
    sweep.reconcileOrganizations(["two"]);
    expect(await sweep("two")).toBeNull();
    expect(await sweep("one")).toEqual(result);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("keeps stable ordered 129 organizations eligible on every due snapshot", async () => {
    let now = 0;
    const run = vi.fn(async (_org: string) => result);
    const sweep = createThrottledApifyHealthSweep({ intervalMs: 1000, now: () => now, run });
    const orgs = Array.from({ length: 129 }, (_, i) => `org-${i}`);
    for (let tick = 0; tick < 3; tick++) {
      sweep.reconcileOrganizations(orgs);
      for (const org of orgs) expect(await sweep(org)).toEqual(result);
      for (const org of orgs) expect(await sweep(org)).toBeNull();
      now += 1000;
    }
    expect(run).toHaveBeenCalledTimes(387);
    expect(run.mock.calls.filter(([org]) => org === "org-128")).toHaveLength(3);
  });

  it("releases failed claims immediately without stamping a completion", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("fixture failure")).mockResolvedValue(result);
    const sweep = createThrottledApifyHealthSweep({ intervalMs: 1000, now: () => 0, run });
    await expect(sweep("one")).rejects.toThrow("fixture failure");
    expect(await sweep("one")).toEqual(result);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
