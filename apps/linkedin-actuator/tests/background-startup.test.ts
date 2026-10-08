import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({ fetchQueue: vi.fn(), enableSend: vi.fn(), ackIntent: vi.fn(),
  logActivity: vi.fn(), attach: vi.fn(), detach: vi.fn(), detachAll: vi.fn(), fetchPriorityReady: vi.fn(),
  health: vi.fn(), fetchIntent: vi.fn(), fetchExtensionBuild: vi.fn() }));
const apiMock = () => ({ ActuatorApi: class {
  fetchQueue = seams.fetchQueue; enableSend = seams.enableSend; ackIntent = seams.ackIntent;
  logActivity = seams.logActivity; fetchPriorityReady = seams.fetchPriorityReady;
  health = seams.health; fetchIntent = seams.fetchIntent; fetchExtensionBuild = seams.fetchExtensionBuild;
} });
const cdpMock = () => ({ Cdp: class { attach = seams.attach; detach = seams.detach; detachAll = seams.detachAll; } });
vi.mock("../src/lib/api.js", () => apiMock());
vi.mock("../src/background/cdp.js", () => cdpMock());
vi.mock("../src/lib/bridge-sink.js", () => ({ bridgePulse: vi.fn(), sinkLog: vi.fn() }));

type Stored = Record<string, unknown>;
type Reply = { ok: boolean; error?: string };
type Listener = (msg: { cmd: string; params?: unknown }, sender: unknown, reply: (response: Reply) => void) => boolean;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function storage(values: Stored) {
  return {
    get: vi.fn(async (keys: string | string[]) => Object.fromEntries(
      (Array.isArray(keys) ? keys : [keys]).filter(key => key in values)
        .map(key => [key, structuredClone(values[key])]),
    )),
    set: vi.fn(async (patch: Stored) => { Object.assign(values, structuredClone(patch)); }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    }),
  };
}
async function settle() { for (let i = 0; i < 200; i++) await Promise.resolve(); }
const queue = { comments: [], dms: [] };
async function boot(gateConfig = false, gatePublication = false, options: { status?: string; config?: Stored; local?: Stored; session?: Stored } = {}) {
  const enteredConfig = deferred<void>();
  const configRelease = deferred<void>();
  const values: Stored = { "actuator.config": { apiBaseUrl: "https://inert.example.test", token: "inert",
    instanceId: "instance", caps: { likes: 1, comments: 0, dms: 0 }, autonomous: false, ...options.config },
    "actuator.automationStartMs": Date.now() - 90 * 86400000, ...options.local };
  const local = storage(values);
  if (gateConfig) {
    const get = local.get;
    let first = true;
    local.get = vi.fn(async keys => {
      if (keys === "actuator.config" && first) {
        first = false; enteredConfig.resolve(); await configRelease.promise;
      }
      return get(keys);
    });
  }
  if (gatePublication) {
    const set = local.set;
    let first = true;
    local.set = vi.fn(async patch => {
      if (patch["actuator.remoteState"] === "running" && first) {
        first = false; enteredConfig.resolve(); await configRelease.promise;
      }
      return set(patch);
    });
  }
  const sessionValues: Stored = { "actuator.epoch": 7, "actuator.runstate": {
    sessionId: "previous", epoch: 7, status: options.status ?? "running", startMs: Date.now(), windowHours: 1,
    targets: { likes: 0, comments: 0, dms: 0 }, done: { likes: 0, comments: 0, dms: 0 },
    actions: [], commentPool: [], dmPool: [], doneDraftIds: [], lastPollMs: Date.now(),
    persona: { wpm: 200 }, warmupSuppressMs: 0,
  } };
  Object.assign(sessionValues, options.session);
  if (options.status === "none") delete sessionValues["actuator.runstate"];
  let message!: Listener;
  let alarm!: (event: { name: string }) => void;
  let startup!: () => void;
  const addListener = vi.fn();
  const chrome = {
    storage: { local, session: storage(sessionValues) },
    runtime: { onStartup: { addListener: (listener: () => void) => { startup = listener; } }, onInstalled: { addListener },
      onMessage: { addListener: (listener: Listener) => { message = listener; } } },
    alarms: { create: vi.fn(async () => {}), clear: vi.fn(async () => true), get: vi.fn(async () => ({ name: "autonomy-check" })),
      onAlarm: { addListener: (listener: typeof alarm) => { alarm = listener; } } },
    tabs: { sendMessage: vi.fn(async () => ({ observed: { challenge: true } })), get: vi.fn(async () => ({ id: 9, url: "https://www.linkedin.com/feed/" })), query: vi.fn(async () => [{ id: 9, url: "https://www.linkedin.com/feed/" }]),
      onCreated: { addListener }, onUpdated: { addListener } },
  };
  vi.stubGlobal("chrome", chrome);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network is forbidden in this fixture"); }));
  vi.resetModules();
  await import("../src/background/index.js");
  expect(message).toBeTypeOf("function");
  const command = (cmd: string) => new Promise<Reply>(resolve => {
    expect(message({ cmd, params: { windowHours: 1, targetComments: 0, targetLikes: 1 } }, {}, resolve)).toBe(true);
  });
  const snapshot = () => structuredClone(sessionValues["actuator.runstate"]) as { epoch: number; status: string; sessionId: string };
  return { command, snapshot, chrome, values, sessionValues, enteredConfig, configRelease, alarm, startup };
}
async function automaticBoot(path: string) {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const h = await boot(false, false, { status: path === "recovery" ? "running" : "idle",
    config: { autonomous: !path.endsWith("resume"), autoDrain: true, autoStartHour: 0, autoEndHour: 24,
    autoTargetComments: 0, autoTargetLikes: 1, stallRecoverMinutes: 1 },
    local: path.endsWith("resume") ? { "actuator.fullAuto": { curfew: true } }
    : path !== "daily" ? { "actuator.lastAutoStartDay": today } : {},
  });
  if (path === "recovery") {
    const startMs = Date.now() - 10 * 60_000;
    Object.assign(h.sessionValues["actuator.runstate"] as Stored, { startMs,
    actions: [{ kind: "comment", atMs: startMs, executed: false }],
    commentPool: [{ draftId: "old", body: "approved", url: "https://www.linkedin.com/feed/update/urn:li:activity:1/" }],
    });
    h.values["actuator.stallProbe"] = { sid: "previous", progressMs: startMs };
  }
  seams.fetchQueue.mockResolvedValue({ comments: [{ approval_id: "approval", draft_id: "draft",
    body: "approved", target: { url: "https://www.linkedin.com/feed/update/urn:li:activity:1/" } }], dms: [] });
  return h;
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-06T15:00:00Z"));
  vi.clearAllMocks();
  seams.fetchQueue.mockResolvedValue(queue); seams.enableSend.mockResolvedValue(undefined);
  seams.ackIntent.mockResolvedValue(undefined); seams.logActivity.mockResolvedValue(undefined);
  seams.attach.mockResolvedValue(undefined); seams.detach.mockResolvedValue(undefined); seams.detachAll.mockResolvedValue(undefined);
  seams.health.mockResolvedValue({ status: "ok" }); seams.fetchIntent.mockResolvedValue(null); seams.fetchExtensionBuild.mockResolvedValue(null);
  seams.fetchPriorityReady.mockResolvedValue(null);
});
afterEach(async () => { await settle(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("linkedin registered lifecycle entry", () => {
  it.each(["startRun", "startDrain"])("healthy %s saves and arms the current epoch", async cmd => {
    const h = await boot();
    expect(await h.command(cmd)).toEqual({ ok: true }); await settle();
    const observed = { status: h.snapshot().status, epoch: h.snapshot().epoch,
      currentEpoch: h.sessionValues["actuator.epoch"], attached: seams.attach.mock.calls.length,
      alarm: h.chrome.alarms.create.mock.calls.length, desired: h.values["actuator.remoteState"] ?? null };
    expect(observed).toEqual({ status: "running", epoch: 8, currentEpoch: 8, attached: 1, alarm: 1,
      desired: cmd === "startDrain" ? "running" : null });
    expect(seams.enableSend.mock.calls.map(call => call[1])).toEqual([true]);
  });
  it.each(["startRun", "startDrain"])("STOP remains authoritative when %s waits for the queue", async cmd => {
    const entered = deferred<void>(); const release = deferred<typeof queue>();
    seams.fetchQueue.mockImplementation(async () => { entered.resolve(); return release.promise; });
    const h = await boot(); const start = h.command(cmd); await entered.promise;
    expect(await h.command("stopRun")).toEqual({ ok: true }); await settle();
    const stopped = h.snapshot(); expect(stopped.status).toBe("stopped"); expect(stopped.epoch).toBe(9);
    seams.attach.mockClear(); h.chrome.alarms.create.mockClear();
    release.resolve(queue); expect(await start).toEqual({ ok: false, error: "start superseded" }); await settle();
    const observed = { state: h.snapshot(), attachedAfterStop: seams.attach.mock.calls.length,
      alarmAfterStop: h.chrome.alarms.create.mock.calls.length, currentEpoch: h.sessionValues["actuator.epoch"],
      desired: h.values["actuator.remoteState"], ack: seams.ackIntent.mock.calls.map(call => call.slice(0, 2)) };
    expect({ state: observed.state, attached: observed.attachedAfterStop, alarm: observed.alarmAfterStop,
      desired: observed.desired }).toEqual({ state: stopped, attached: 0, alarm: 0, desired: "stopped" });
  });
  it.each(["startRun", "startDrain"])("STOP during %s attach does not rearm its alarm or running intent", async cmd => {
    const entered = deferred<void>(); const release = deferred<void>();
    seams.attach.mockImplementation(async () => { entered.resolve(); return release.promise; });
    const h = await boot(); const start = h.command(cmd); await entered.promise;
    expect(await h.command("stopRun")).toEqual({ ok: true }); await settle();
    const stopped = h.snapshot(); expect(stopped.status).toBe("stopped");
    h.chrome.alarms.create.mockClear();
    release.resolve(); expect(await start).toEqual({ ok: false, error: "start superseded" }); await settle();
    expect(seams.detach).toHaveBeenCalledWith(9);
    const observed = { state: h.snapshot(), alarmAfterStop: h.chrome.alarms.create.mock.calls.length,
      desired: h.values["actuator.remoteState"], ack: seams.ackIntent.mock.calls.map(call => call.slice(0, 2)) };
    expect({ state: observed.state, alarm: observed.alarmAfterStop, desired: observed.desired })
      .toEqual({ state: stopped, alarm: 0, desired: "stopped" });
  });
  it("an older startRun delayed on configuration does not claim a new epoch after STOP", async () => {
    const h = await boot(true); const start = h.command("startRun"); await h.enteredConfig.promise;
    expect(await h.command("stopRun")).toEqual({ ok: true }); await settle();
    const stopped = h.snapshot(); expect(stopped.status).toBe("stopped"); expect(stopped.epoch).toBe(9);
    seams.attach.mockClear(); h.chrome.alarms.create.mockClear();
    h.configRelease.resolve(); expect(await start).toEqual({ ok: false, error: "start superseded" }); await settle();
    const observed = { state: h.snapshot(), currentEpoch: h.sessionValues["actuator.epoch"],
      attachedAfterStop: seams.attach.mock.calls.length, alarmAfterStop: h.chrome.alarms.create.mock.calls.length };
    expect({ state: observed.state, epoch: observed.currentEpoch, attached: observed.attachedAfterStop,
      alarm: observed.alarmAfterStop }).toEqual({ state: stopped, epoch: 9, attached: 0, alarm: 0 });
  });
  it("a delayed running publication after successful drain does not overwrite later STOP intent", async () => {
    const h = await boot(false, true);
    expect(await h.command("startDrain")).toEqual({ ok: true }); await h.enteredConfig.promise;
    let acknowledged = false;
    const stop = h.command("stopRun").then(reply => { acknowledged = true; return reply; });
    await settle(); expect(acknowledged).toBe(false);
    h.configRelease.resolve();
    expect(await stop).toEqual({ ok: true }); await settle();
    const stopped = h.snapshot(); expect(stopped.status).toBe("stopped");
    expect(h.values["actuator.remoteState"]).toBe("stopped");
    const observed = { state: h.snapshot(), desired: h.values["actuator.remoteState"],
      ack: seams.ackIntent.mock.calls.map(call => call.slice(0, 2)) };
    expect({ state: observed.state, desired: observed.desired, lastAck: observed.ack.at(-1) })
      .toEqual({ state: stopped, desired: "stopped", lastAck: ["idle", "stopped"] });
  });
  it("a completed STOP after healthy start remains terminal", async () => {
    const h = await boot();
    expect(await h.command("startRun")).toEqual({ ok: true });
    expect(await h.command("stopRun")).toEqual({ ok: true }); await settle();
    const observed = { status: h.snapshot().status, epoch: h.snapshot().epoch,
      currentEpoch: h.sessionValues["actuator.epoch"], desired: h.values["actuator.remoteState"],
      alarmCleared: h.chrome.alarms.clear.mock.calls.length };
