import { describe, expect, it, vi } from "vitest";
import { meterApifyRun, withMeteredApifyCall } from "./apifyMetering.js";
import type { ApifyRunReceipt } from "./apifyRunReceipts.js";

const row = (actualUsd: number | null): ApifyRunReceipt => ({ runId: "run", actor: "actual-actor", actualUsd,
  status: "FAILED", terminal: true, credentialId: "paid-credential", resultCount: 0,
  resultCountComplete: false, fetchedResultCount: 0 });
const args = () => ({ orgId: "org", instanceId: "instance", agentRole: "x_intern" as const,
  worker: "worker", actor: "fallback-actor", startedAt: new Date(), recorder: { record: vi.fn().mockResolvedValue(undefined) }, log: { warn: vi.fn() } });

describe("shared per-attempt Apify metering", () => {
  it("records every receipt through a bounded four-worker pool and awaits completion", async () => {
    const spend = args();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let inFlight = 0; let peak = 0;
    spend.recorder.record.mockImplementation(async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await blocked; inFlight--;
    });
    const pending = withMeteredApifyCall({ ...spend,
      client: { drainRunReceipts: () => Array.from({ length: 9 }, () => row(0.37)) } }, async () => []);
    await Promise.resolve(); await Promise.resolve();
    try { expect(spend.recorder.record).toHaveBeenCalledTimes(4); }
    finally { release(); await pending; }
    expect(spend.recorder.record).toHaveBeenCalledTimes(9);
    expect(peak).toBe(4); expect(inFlight).toBe(0);
  });

  it("awaits the full receipt tail after a recorder rejection before propagating retrieval failure", async () => {
    const spend = args();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let inFlight = 0; let calls = 0; let settled = false;
    spend.recorder.record.mockImplementation(async () => {
      calls++;
      if (calls === 1) throw new Error("private storage failure");
      inFlight++; await blocked; inFlight--;
    });
    const pending = withMeteredApifyCall({ ...spend,
      client: { drainRunReceipts: () => Array.from({ length: 9 }, () => row(0.37)) } },
      async () => { throw new Error("retrieval failure"); }).catch(error => { settled = true; return error; });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    try { expect(settled).toBe(false); expect(inFlight).toBeGreaterThan(0); }
    finally { release(); }
    expect(await pending).toMatchObject({ message: "retrieval failure" });
    expect(calls).toBe(9); expect(inFlight).toBe(0);
    expect(spend.log.warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(spend.log.warn.mock.calls)).not.toContain("private storage failure");
  });

  it.each([0, 0.37])("meters a received charge %s even when the operation fails or returns no results", async actualUsd => {
    const spend = args();
    const client = { drainRunReceipts: () => [row(actualUsd)] };
    await expect(withMeteredApifyCall({ ...spend, client }, async () => { throw new Error("dataset failed"); })).rejects.toThrow("dataset failed");
    expect(spend.recorder.record).toHaveBeenCalledOnce();
    expect(spend.recorder.record.mock.calls[0]![0]).toMatchObject({ cents: Math.round(actualUsd * 100),
      credentialId: "paid-credential", model: "apify/actual-actor", costBasis: "provider_reported" });
  });

  it("does not turn an incomplete normalized count into a full fallback charge", async () => {
    const spend = args();
    await meterApifyRun({ ...spend, actualUsd: null, resultCount: 100, resultCountComplete: false });
    expect(spend.recorder.record).not.toHaveBeenCalled(); expect(spend.log.warn).toHaveBeenCalledOnce();
  });

  it("may estimate only a known raw total and labels it without claiming provider usage", async () => {
    const spend = args();
    await meterApifyRun({ ...spend, actualUsd: null, resultCount: 100, resultCountComplete: true });
    expect(spend.recorder.record).toHaveBeenCalledOnce();
    expect(spend.recorder.record.mock.calls[0]![0]).toMatchObject({ costBasis: "unknown" });
  });

  it("uses isolated operation clients rather than shared legacy receipt state", async () => {
    const spend = args();
    const scoped = { drainRunReceipts: () => [row(0.37)], run: vi.fn().mockResolvedValue([]) };
    const client = { isolateOperation: () => scoped, drainRunReceipts: () => [], run: vi.fn() };
    await withMeteredApifyCall({ ...spend, client }, operation => operation.run());
    expect(scoped.run).toHaveBeenCalledOnce(); expect(client.run).not.toHaveBeenCalled();
    expect(spend.recorder.record).toHaveBeenCalledOnce();
  });

  it("retains the original operation failure when receipt storage rejects, and warns without its body", async () => {
    const spend = args(); spend.recorder.record.mockRejectedValue(new Error("private-store-error"));
    await expect(withMeteredApifyCall({ ...spend, client: { drainRunReceipts: () => [row(0.37)] } }, async () => { throw new Error("operation failed"); })).rejects.toThrow("operation failed");
    expect(spend.log.warn).toHaveBeenCalledOnce(); expect(JSON.stringify(spend.log.warn.mock.calls)).not.toContain("private-store-error");
  });
});
