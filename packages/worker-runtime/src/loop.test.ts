import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { installShutdown, runWorkerLoop } from "./loop.js";

function silentLogger() {
  const log = createLogger({ kind: "test", workerId: "t0" });
  log.level = "silent";
  return log;
}

describe("runWorkerLoop", () => {
  it("ticks every instance and stops when shouldStop flips", async () => {
    const ticked: string[] = [];
    let sweeps = 0;
    await runWorkerLoop({
      log: silentLogger(),
      kind: "discovery",
      pollMs: 10,
      idlePollMs: 20,
      listActive: async () => [{ id: "a" }, { id: "b" }],
      onTick: async (inst) => {
        ticked.push(inst.id);
      },
      sleep: async () => {
        sweeps += 1;
      },
      shouldStop: () => sweeps >= 2,
    });
    expect(ticked).toEqual(["a", "b", "a", "b"]);
  });

  it("isolates a throwing tick: later instances and later sweeps still run", async () => {
    const ticked: string[] = [];
    let sweeps = 0;
    await runWorkerLoop({
      log: silentLogger(),
      kind: "drafter",
      pollMs: 10,
      idlePollMs: 20,
      listActive: async () => [{ id: "boom" }, { id: "ok" }],
      onTick: async (inst) => {
        if (inst.id === "boom") throw new Error("tick exploded");
        ticked.push(inst.id);
      },
      sleep: async () => {
        sweeps += 1;
      },
      shouldStop: () => sweeps >= 2,
    });
    expect(ticked).toEqual(["ok", "ok"]);
  });

  it("idles on idlePollMs when no instances are active, pollMs after a sweep", async () => {
    const slept: number[] = [];
    let calls = 0;
    await runWorkerLoop({
      log: silentLogger(),
      kind: "classifier",
      pollMs: 111,
      idlePollMs: 222,
      // First poll: nothing active. Second poll: one instance.
      listActive: async () => (calls++ === 0 ? [] : [{ id: "a" }]),
      onTick: async () => {},
      sleep: async (ms) => {
        slept.push(ms);
      },
      shouldStop: () => slept.length >= 2,
    });
    expect(slept).toEqual([222, 111]);
  });

  it("never overlaps ticks: each tick finishes before the next starts", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let sweeps = 0;
    await runWorkerLoop({
      log: silentLogger(),
      kind: "send",
      pollMs: 10,
      idlePollMs: 20,
      listActive: async () => [{ id: "a" }, { id: "b" }, { id: "c" }],
      onTick: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
      },
      sleep: async () => {
        sweeps += 1;
      },
      shouldStop: () => sweeps >= 1,
    });
    expect(maxInFlight).toBe(1);
  });
});

describe("installShutdown", () => {
  it("returns false until a shutdown signal arrives, then true", () => {
    const shouldStop = installShutdown(silentLogger());
    expect(shouldStop()).toBe(false);
    process.emit("SIGTERM", "SIGTERM");
    expect(shouldStop()).toBe(true);
  });
});
