import { describe, expect, it, vi } from "vitest";
import { activateBrowserDiscovery, discoveryWriteGate } from "../src/background/discovery-mode.js";

function setup(status: "running" | "idle") {
  const values = new Map<string, unknown>([
    ["actuator.lastManualStopDay", "today"],
    ["actuator.remoteState", "stopped"],
  ]);
  const storage = {
    get: vi.fn(async (keys: string | string[]) => Object.fromEntries(
      (Array.isArray(keys) ? keys : [keys]).map((key) => [key, values.get(key)]),
    )),
    set: vi.fn(async (patch: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(patch)) values.set(key, value);
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key);
    }),
  };
  const startDrain = vi.fn(async () => {});
  const deps = {
    storage,
    keys: {
      drainIntent: "actuator.fullAuto",
      stopDay: "actuator.lastManualStopDay",
      remoteState: "actuator.remoteState",
    },
    loadStatus: vi.fn(async () => status),
    startDrain,
  };
  return { values, storage, startDrain, deps };
}

describe("browser discovery start control", () => {
  it("arms durable discovery and Auto without interrupting an active run", async () => {
    const { values, startDrain, deps } = setup("running");
    expect(await activateBrowserDiscovery(deps)).toBe("already-running");
    expect(values.get("actuator.browserDiscoveryCanary")).toBe(true);
    expect(values.get("actuator.fullAuto")).toEqual({ curfew: false });
    expect(values.has("actuator.lastManualStopDay")).toBe(false);
    expect(values.has("actuator.remoteState")).toBe(false);
    expect(startDrain).not.toHaveBeenCalled();
  });

  it("starts the persistent paced Auto run when idle", async () => {
    const { values, startDrain, deps } = setup("idle");
    expect(await activateBrowserDiscovery(deps)).toBe("started");
    expect(values.get("actuator.browserDiscoveryCanary")).toBe(true);
    expect(startDrain).toHaveBeenCalledOnce();
  });

  it("allows writes around the clock by default in discovery, even in an existing Auto run", async () => {
    const { storage } = setup("running");
    await storage.set({ "actuator.browserDiscoveryCanary": true });
    expect(await discoveryWriteGate(storage, Date.parse("2026-09-20T03:00:00"), true))
      .toEqual({ held: false });
    expect(await discoveryWriteGate(storage, Date.parse("2026-09-20T10:00:00"), true))
      .toEqual({ held: false });
  });

  it("holds comments and DMs in the saved local quiet window and responds to edits", async () => {
    const { storage } = setup("running");
    await storage.set({
      "actuator.browserDiscoveryCanary": true,
      "noelle.discoverySchedule.v1": { enabled: true, start: "01:00", end: "09:00" },
    });
    expect((await discoveryWriteGate(storage, Date.parse("2026-09-20T08:59:00"), false)).held).toBe(true);
    expect((await discoveryWriteGate(storage, Date.parse("2026-09-20T09:00:00"), false)).held).toBe(false);
    await storage.set({ "noelle.discoverySchedule.v1": { enabled: true, start: "11:30", end: "12:30" } });
    expect((await discoveryWriteGate(storage, Date.parse("2026-09-20T12:00:00"), false)).held).toBe(true);
  });

  it("keeps legacy Auto curfew when discovery is disabled and holds writes on storage failure", async () => {
    const { storage } = setup("running");
    expect((await discoveryWriteGate(storage, Date.parse("2026-09-20T03:00:00"), true)).held).toBe(true);
    expect((await discoveryWriteGate(storage, Date.parse("2026-09-20T03:00:00"), false)).held).toBe(false);
    storage.get.mockRejectedValueOnce(new Error("storage down"));
    expect((await discoveryWriteGate(storage, Date.parse("2026-09-20T12:00:00"), false)).held).toBe(true);
  });
});
