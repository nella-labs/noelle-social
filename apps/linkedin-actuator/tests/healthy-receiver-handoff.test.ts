import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  fetchExtensionBuild: vi.fn(async () => ({ stamp: "new-build" })),
  fetchDiscoveryCapacity: vi.fn(async () => ({ available: 0 })),
}));
vi.mock("../src/lib/api.js", () => ({
  ActuatorApi: class {
    fetchExtensionBuild = api.fetchExtensionBuild;
    fetchDiscoveryCapacity = api.fetchDiscoveryCapacity;
  },
}));
vi.mock("../src/lib/bridge-sink.js", () => ({ bridgePulse: vi.fn(), sinkLog: vi.fn() }));

function storage(values: Record<string, unknown>) {
  return {
    get: vi.fn(async (keys: string | string[]) => {
      const names = typeof keys === "string" ? [keys] : keys;
      return Object.fromEntries(names.filter((key) => key in values).map((key) => [key, values[key]]));
    }),
    set: vi.fn(async (patch: Record<string, unknown>) => { Object.assign(values, patch); }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of typeof keys === "string" ? [keys] : keys) delete values[key];
    }),
  };
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("reloads a newer build during a healthy receiver's queued-comment browse slot", async () => {
  const now = Date.now();
  const localValues: Record<string, unknown> = {
    "actuator.config": { instanceId: "one", apiBaseUrl: "http://localhost", token: "test" },
    "actuator.browserDiscoveryCanary": true,
    "actuator.fullAuto": { curfew: false },
  };
  const sessionValues: Record<string, unknown> = {
    "actuator.epoch": 7,
    "actuator.runstate": {
      sessionId: "run", epoch: 7, status: "running", mode: "drain",
      startMs: now - 60_000, windowHours: 2,
      actions: [{ kind: "comment", atMs: now + 60_000, executed: false }],
      targets: { likes: 0, comments: 1, dms: 0 }, done: { likes: 0, comments: 0, dms: 0 },
      commentPool: [{ approvalId: "approval", draftId: "draft", body: "reply", url: "https://www.linkedin.com/feed/update/urn:li:activity:7506985844398911488/" }],
      dmPool: [], doneDraftIds: [], lastPollMs: now, lastDiscoveryReadMs: 0,
      persona: { wpm: 200 }, warmupSuppressMs: 0,
    },
  };
  const local = storage(localValues);
  const session = storage(sessionValues);
  let onMessage: ((msg: { cmd: string }, sender: unknown, reply: (result: unknown) => void) => boolean) | undefined;
  const reload = vi.fn();
  const update = vi.fn();
  vi.stubGlobal("__BUILD_STAMP__", "old-build");
  vi.stubGlobal("chrome", {
    storage: { local, session },
    runtime: {
      reload, onMessage: { addListener: (listener: typeof onMessage) => { onMessage = listener; } },
      onStartup: { addListener: vi.fn() }, onInstalled: { addListener: vi.fn() },
    },
    alarms: { onAlarm: { addListener: vi.fn() } },
    debugger: {
      attach: vi.fn(async () => {}), sendCommand: vi.fn(async () => ({})),
      onEvent: { addListener: vi.fn() },
    },
    tabs: {
      query: vi.fn(async () => [{ id: 9, url: "https://www.linkedin.com/feed/" }]),
      sendMessage: vi.fn(async () => ({ ok: true, observed: { challenge: false } })),
      update,
    },
  });
  vi.resetModules();
  await import("../src/background/index.js");
  expect(onMessage).toBeDefined();
  const result = await new Promise<unknown>((resolve) => onMessage!({ cmd: "tick" }, {}, resolve));
  expect(result).toEqual({ ok: true });
  expect(api.fetchExtensionBuild).toHaveBeenCalledTimes(1);
  expect(reload).toHaveBeenCalledTimes(1);
  expect(localValues["actuator.lastReloadStamp"]).toBe("new-build");
  expect(update).not.toHaveBeenCalled();
});
