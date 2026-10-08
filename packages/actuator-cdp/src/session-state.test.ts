import { describe, expect, it, vi } from "vitest";
import { createSessionRunStateStore, tickIsCurrent } from "./session-state.js";
import { makeSerialQueue } from "./serial-queue.js";

type State = { epoch?: number; status: string };
function fixture(epoch?: number) {
  const values: Record<string, unknown> = { "actuator.epoch": epoch };
  const session = {
    get: vi.fn(async (key: string) => ({ [key]: values[key] })),
    set: vi.fn(async (next: Record<string, unknown>) => { Object.assign(values, next); }),
    remove: vi.fn(async (key: string) => { delete values[key]; }),
  };
  const store = createSessionRunStateStore<State>(() => session);
  return { values, session, store };
}

describe("session run-state ownership", () => {
  it("allocates distinct epochs to simultaneous generation changes", async () => {
    const { store } = fixture(1);
    expect(await Promise.all([store.bumpEpoch(), store.bumpEpoch()])).toEqual([2, 3]);
    expect(await store.currentEpoch()).toBe(3);
  });
  it("claims only the generation observed before asynchronous preparation", async () => {
    const { store } = fixture(1);
    expect(await store.claimEpoch(1)).toBe(2);
    expect(await store.claimEpoch(1)).toBeNull();
    expect(await store.currentEpoch()).toBe(2);
    expect(await store.claimEpoch()).toBe(3);
  });
  it("orders admitted short metadata before a later STOP and rejects stale metadata", async () => {
    const { store } = fixture(1);
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const admitted = new Promise<void>(r => { entered = r; });
    const writes: string[] = [];
    const running = store.runIfCurrent(1, async () => { entered(); await gate; writes.push("running"); });
    await admitted;
    const stop = (async () => {
      const epoch = await store.bumpEpoch();
      await store.runIfCurrent(epoch, async () => { writes.push("stopped"); });
    })();
    // A paused storage RPC must finish before its cooperating queued STOP can ACK.
    release(); await Promise.all([running, stop]);
    expect(writes).toEqual(["running", "stopped"]);
    expect(await store.runIfCurrent(1, async () => { writes.push("stale"); })).toBe(false);
    expect(writes).toEqual(["running", "stopped"]);
  });
  it("a rejected metadata operation releases the shared queue", async () => {
    const { store } = fixture(1);
    await expect(store.runIfCurrent(1, async () => { throw new Error("metadata rejected"); })).rejects.toThrow("metadata rejected");
    expect(await store.claimEpoch(1)).toBe(2);
  });
  it("keeps STOP authoritative when an old guarded read is delayed", async () => {
    const { values, session, store } = fixture(1);
    let admit!: () => void; let release!: () => void;
    const admitted = new Promise<void>(resolve => { admit = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    session.get.mockImplementationOnce(async () => {
      const snapshot = { "actuator.epoch": values["actuator.epoch"] };
      admit(); await gate; return snapshot;
    });
    const old = store.saveIfCurrent({ epoch: 1, status: "running" });
    await admitted;
    const stop = (async () => {
      const epoch = await store.bumpEpoch();
      await store.saveState({ epoch, status: "stopped" });
    })();
    try { await Promise.resolve(); } finally {
      release(); await Promise.all([old, stop]);
    }
    expect(await store.loadState()).toEqual({ epoch: 2, status: "stopped" });
  });
  it("refuses a stale generation without writing its state", async () => {
    const { session, store } = fixture(2);
    expect(await store.saveIfCurrent({ epoch: 1, status: "running" })).toBe(false);
    expect(session.set).not.toHaveBeenCalled();
    expect(await store.loadState()).toBeNull();
  });
  it("accepts legacy generation zero and fences it after the first bump", async () => {
    const { store } = fixture();
    expect(await store.currentEpoch()).toBe(0);
    expect(await store.saveIfCurrent({ status: "running" })).toBe(true);
    expect(await store.bumpEpoch()).toBe(1);
    expect(await store.saveIfCurrent({ status: "stopped" })).toBe(false);
    expect(tickIsCurrent(undefined, 0)).toBe(true);
    expect(tickIsCurrent(undefined, 1)).toBe(false);
  });
  it("clears the state while preserving the generation", async () => {
    const { store } = fixture(2);
    await store.saveState({ epoch: 2, status: "running" });
    await store.clearState();
    expect(await store.loadState()).toBeNull();
    expect(await store.currentEpoch()).toBe(2);
  });
  it.each(["get", "set", "remove"] as const)("a rejected %s does not wedge later operations", async operation => {
    const { session, store } = fixture(1);
    session[operation].mockRejectedValueOnce(new Error("storage rejected"));
    const first = operation === "get" ? store.bumpEpoch()
      : operation === "set" ? store.saveState({ epoch: 1, status: "running" }) : store.clearState();
    await expect(first).rejects.toThrow("storage rejected");
    expect(await store.bumpEpoch()).toBe(2);
  });
  it("a rejected guarded write returns its own rejection then releases the queue", async () => {
    const { session, store } = fixture(1);
    session.set.mockRejectedValueOnce(new Error("write failed"));
    await expect(store.saveIfCurrent({ epoch: 1, status: "running" })).rejects.toThrow("write failed");
    expect(await store.saveIfCurrent({ epoch: 1, status: "stopped" })).toBe(true);
  });
  it("reads the current storage adapter lazily", async () => {
    const first = fixture(1); const second = fixture(4);
    let session = first.session;
    const store = createSessionRunStateStore<State>(() => session);
    expect(await store.bumpEpoch()).toBe(2);
    session = second.session;
    expect(await store.bumpEpoch()).toBe(5);
    expect(first.values["actuator.epoch"]).toBe(2);
  });
  it("independent queues preserve values and rejection recovery", async () => {
    const queue = makeSerialQueue();
    await expect(queue(async () => { throw new Error("rejected"); })).rejects.toThrow("rejected");
    expect(await queue(async () => "receipt")).toBe("receipt");
  });
});
