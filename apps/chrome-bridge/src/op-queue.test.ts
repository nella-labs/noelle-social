import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChromeOp } from "@noelle/contracts";
import { OpQueue } from "./op-queue.js";

const ping: ChromeOp = { op: "meta.ping" };

describe("OpQueue", () => {
  it("enqueue → drainForExt → report resolves with the reported result", async () => {
    const q = new OpQueue({ opTimeoutMs: 10_000 });
    const pending = q.enqueue(ping);

    const drained = q.drainForExt();
    expect(drained).toHaveLength(1);
    expect(drained[0]?.op).toEqual(ping);

    const id = drained[0]?.id ?? "";
    const reported = q.report(id, { ok: true, value: "pong" });
    expect(reported).toBe(true);

    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.value).toBe("pong");
    expect(typeof result.tookMs).toBe("number");
  });

  it("drainForExt returns then clears the queued ops", () => {
    const q = new OpQueue({ opTimeoutMs: 10_000 });
    void q.enqueue(ping);
    void q.enqueue(ping);
    expect(q.drainForExt()).toHaveLength(2);
    expect(q.drainForExt()).toHaveLength(0); // cleared after the first drain
  });

  it("a never-reported op resolves to a timeout result (not a rejection)", async () => {
    const q = new OpQueue({ opTimeoutMs: 15 }); // tiny real timeout
    const result = await q.enqueue(ping);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("op timeout");
  });

  it("report on an unknown/expired id is a no-op returning false", () => {
    const q = new OpQueue({ opTimeoutMs: 10_000 });
    expect(q.report("nope", { ok: true })).toBe(false);
  });

  it("tracks ext-connected state from polls with an injectable clock", () => {
    let t = 1_000;
    const q = new OpQueue({ opTimeoutMs: 100, now: () => t });
    expect(q.isConnected()).toBe(false); // no poll yet

    q.drainForExt(); // poll at t=1000
    expect(q.isConnected()).toBe(true);

    t = 1_000 + 5_000; // 5s later — still inside the 10s window
    expect(q.isConnected()).toBe(true);

    t = 1_000 + 10_001; // >10s since last poll
    expect(q.isConnected()).toBe(false);
  });

  it("hello records ext info and refreshes the connected clock", () => {
    const t = 500;
    const q = new OpQueue({ opTimeoutMs: 100, now: () => t });
    q.hello({ extId: "abc", extVersion: "0.0.1", chromeVersion: "126.0" });
    expect(q.isConnected()).toBe(true);
    const st = q.status();
    expect(st.extVersion).toBe("0.0.1");
    expect(st.chromeVersion).toBe("126.0");
    expect(st.lastPollAt).toBe(500);
  });
});

describe("OpQueue deadline boundaries", () => {
  afterEach(() => { vi.runAllTimers(); vi.useRealTimers(); });

  it("refuses to dispatch an expired queued operation before its timer callback runs", async () => {
    vi.useFakeTimers();
    let now = 0;
    const queue = new OpQueue({ opTimeoutMs: 100, now: () => now });
    const result = queue.enqueue(ping);
    now = 100;
    expect(queue.drainForExt()).toEqual([]);
    expect(queue.status()).toMatchObject({ queued: 0, pending: 0 });
    expect(await result).toEqual({ ok: false, error: "op timeout", tookMs: 100 });
  });

  it("refuses an expired drained receipt before its timer callback runs", async () => {
    vi.useFakeTimers();
    let now = 0;
    const queue = new OpQueue({ opTimeoutMs: 100, now: () => now });
    const result = queue.enqueue(ping);
    const id = queue.drainForExt()[0]!.id;
    now = 100;
    expect(queue.report(id, { ok: true, value: "late pong" })).toBe(false);
    expect(await result).toEqual({ ok: false, error: "op timeout", tookMs: 100 });
    expect(queue.report(id, { ok: true })).toBe(false);
  });

  it("expires only old work and accepts an unexpired operation once", async () => {
    vi.useFakeTimers();
    let now = 0;
    const queue = new OpQueue({ opTimeoutMs: 100, now: () => now });
    const old = queue.enqueue(ping);
    now = 90;
    const fresh = queue.enqueue(ping);
    now = 100;
    const drained = queue.drainForExt();
    expect(drained).toHaveLength(1);
    expect(await old).toMatchObject({ ok: false, error: "op timeout" });
    expect(queue.report(drained[0]!.id, { ok: true, value: "pong" })).toBe(true);
    expect(await fresh).toEqual({ ok: true, value: "pong", tookMs: 10 });
    expect(queue.report(drained[0]!.id, { ok: true })).toBe(false);
    expect(queue.status()).toMatchObject({ queued: 0, pending: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });
});
