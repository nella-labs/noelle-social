import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  fetchIntent: vi.fn(() => new Promise<never>(() => {})),
  fetchPriorityReady: vi.fn(() => new Promise<never>(() => {})),
  fetchQueue: vi.fn(),
}));

vi.mock("../src/lib/api.js", () => ({
  ActuatorApi: class {
    fetchIntent = api.fetchIntent;
    fetchPriorityReady = api.fetchPriorityReady;
    fetchQueue = api.fetchQueue;
  },
}));
vi.mock("../src/lib/bridge-sink.js", () => ({ bridgePulse: vi.fn(), sinkLog: vi.fn() }));

type Stored = Record<string, unknown>;
type AlarmListener = (alarm: { name: string }) => void;

function storageArea(values: Stored) {
  return {
    get: vi.fn(async (keys: string | string[]) => {
      const names = typeof keys === "string" ? [keys] : keys;
      return Object.fromEntries(names.filter((key) => key in values).map((key) => [key, values[key]]));
    }),
    set: vi.fn(async (patch: Stored) => { Object.assign(values, patch); }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of typeof keys === "string" ? [keys] : keys) delete values[key];
    }),
  };
}

async function bootWorker(status: "running" | "stopped" | "halted-challenge", options: {
  epoch?: number;
  remoteStopped?: boolean;
  remoteStopDuringRestore?: boolean;
  trigger?: "alarm" | "tick";
} = {}) {
  const now = Date.now();
  const state = {
    sessionId: "saved-run", epoch: 7, status, startMs: now - 60_000, windowHours: 2,
    mode: "drain", actions: [], targets: { likes: 0, comments: 0, dms: 0 },
    done: { likes: 0, comments: 0, dms: 0 }, commentPool: [], dmPool: [],
    doneDraftIds: [], lastPollMs: now, persona: { wpm: 200 }, warmupSuppressMs: 0,
  };
  const local = storageArea({
    "actuator.config": { instanceId: "instance-1", apiBaseUrl: "http://localhost", token: "test" },
    "actuator.browserDiscoveryCanary": true,
    ...(options.remoteStopped ? { "actuator.remoteState": "stopped" } : {}),
  });
  const session = storageArea({ "actuator.runstate": state, "actuator.epoch": options.epoch ?? 7 });
  if (options.remoteStopDuringRestore) {
    const get = session.get;
    let stateReads = 0;
    session.get = vi.fn(async (keys: string | string[]) => {
      if (keys === "actuator.runstate" && ++stateReads === 2) {
        // Remote STOP persists after the first gate read, before the final state read.
        await local.set({ "actuator.remoteState": "stopped" });
      }
      return get(keys);
    });
  }
  let alarm: AlarmListener | undefined;
  let message: ((msg: { cmd: string }, sender: unknown, reply: (response: unknown) => void) => boolean) | undefined;
  const chromeMock = {
    storage: { local, session },
    runtime: {
      onStartup: { addListener: vi.fn() }, onInstalled: { addListener: vi.fn() },
      onMessage: { addListener: (listener: typeof message) => { message = listener; } },
    },
    alarms: {
      onAlarm: { addListener: (listener: AlarmListener) => { alarm = listener; } },
      get: vi.fn(async () => ({ name: "autonomy-check" })),
      create: vi.fn(async () => {}), clear: vi.fn(async () => true),
    },
    debugger: { onEvent: { addListener: vi.fn() } },
    tabs: { query: vi.fn(async () => []) },
  };
  vi.stubGlobal("chrome", chromeMock);
  vi.resetModules(); // a new module instance is an ordinary MV3 worker restart
  await import("../src/background/index.js");
  if (options.trigger === "tick") {
    expect(message).toBeDefined();
    message!({ cmd: "tick" }, {}, vi.fn());
  } else {
    expect(alarm).toBeDefined();
    alarm!({ name: "actuator-tick" });
  }
  return { local, session, state, chromeMock };
}

describe("LinkedIn worker restart", () => {
  beforeEach(() => { api.fetchPriorityReady.mockClear(); api.fetchIntent.mockClear(); api.fetchQueue.mockClear(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("rearms a persisted running session for priority work without starting a new run", async () => {
    const { session, chromeMock } = await bootWorker("running");
    await vi.waitFor(() => expect(api.fetchPriorityReady).toHaveBeenCalledTimes(1));
    expect(session.set).not.toHaveBeenCalledWith(expect.objectContaining({ "actuator.epoch": expect.any(Number) }));
    expect(api.fetchQueue).not.toHaveBeenCalled();
    expect(chromeMock.tabs.query).toHaveBeenCalled();
  });

  it.each([
    { status: "stopped", options: {}, reason: "terminal STOP" },
    { status: "halted-challenge", options: {}, reason: "challenge halt" },
    { status: "running", options: { epoch: 8 }, reason: "superseded epoch" },
    { status: "running", options: { remoteStopped: true }, reason: "remote STOP" },
  ] as const)("does not rearm $reason", async ({ status, options }) => {
    const { chromeMock } = await bootWorker(status, options);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.fetchPriorityReady).not.toHaveBeenCalled();
    expect(chromeMock.tabs.query).not.toHaveBeenCalled();
  });

  it("does not resume a tick when remote STOP lands during restoration", async () => {
    const { chromeMock } = await bootWorker("running", { remoteStopDuringRestore: true, trigger: "tick" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(chromeMock.tabs.query).not.toHaveBeenCalled();
  });
});
