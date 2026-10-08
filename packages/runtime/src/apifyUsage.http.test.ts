import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkApifyAccountUsage } from "./apifyUsage.js";

const cycle = { startAt: "2026-09-01T00:00:00.000Z", endAt: "2026-10-01T00:00:00.000Z" };
const limits = {
  data: { current: { monthlyUsageUsd: 0 }, limits: { maxMonthlyUsageUsd: 5 }, monthlyUsageCycle: cycle },
};
const payload = (path: string) => path.endsWith("/limits") ? limits : path.endsWith("/monthly")
  ? { data: { usageCycle: cycle, totalUsageCreditsUsdAfterVolumeDiscount: 0,
    dailyServiceUsages: [{ date: "2026-09-01", totalUsageCreditsUsd: 0 }] } }
  : { data: { id: "fixture-account" } };
let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

async function fixture(options: { oversized?: boolean; delayMs?: number; stalledBody?: boolean } = {}) {
  let calls = 0;
  let closedBodies = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer((request, response) => {
    calls++;
    const send = () => {
      response.setHeader("content-type", "application/json");
      if (options.stalledBody) {
        response.write('{"data":');
        response.on("close", () => { closedBodies++; });
      } else {
        response.end(JSON.stringify({ ...payload(request.url!),
          ...(options.oversized && request.url!.endsWith("/limits")
            ? { padding: "x".repeat(5 * 1024 * 1024) } : {}),
        }));
      }
    };
    if (options.delayMs) {
      const timer = setTimeout(() => { timers.delete(timer); send(); }, options.delayMs);
      timers.add(timer);
    } else send();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local fixture address required");
  const base = `http://127.0.0.1:${address.port}`;
  close = async () => {
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  };
  return {
    calls: () => calls,
    closedBodies: () => closedBodies,
    fetch: ((input, init) => fetch(base + new URL(String(input)).pathname, init)) as typeof fetch,
  };
}

describe("Apify account health complete HTTP boundary", () => {
  it("preserves measured zero usage through all three bounded endpoints", async () => {
    const f = await fixture();
    const health = await checkApifyAccountUsage("fixture-key", { fetch: f.fetch, timeoutMs: 2000 });
    expect(health).toMatchObject({ alive: true, httpStatus: 200, monthlyUsageUsd: 0,
      dailyUsage: [{ date: "2026-09-01", usageUsd: 0 }] });
    expect(f.calls()).toBe(3);
  });

  it("rejects a limits response larger than the canonical 4 MiB bound", async () => {
    const f = await fixture({ oversized: true });
    const health = await checkApifyAccountUsage("fixture-key", { fetch: f.fetch, timeoutMs: 2000 });
    expect(health.alive).toBe(false);
    expect(f.calls()).toBe(1);
  });

  it("admits no HTTP work after parent cancellation", async () => {
    const f = await fixture();
    const controller = new AbortController();
    controller.abort();
    const health = await checkApifyAccountUsage("fixture-key", {
      fetch: f.fetch, timeoutMs: 2000, signal: controller.signal,
    });
    expect(health.alive).toBe(false);
    expect(f.calls()).toBe(0);
  });

  it("uses one original deadline for all serial endpoints", async () => {
    const f = await fixture({ delayMs: 80 });
    const health = await checkApifyAccountUsage("fixture-key", { fetch: f.fetch, timeoutMs: 200 });
    expect(health.dailyUsage).toBeUndefined();
    expect(health).toMatchObject({ alive: true, monthlyUsageUsd: 0 });
    expect(f.calls()).toBeGreaterThanOrEqual(2);
  });

  it("cancels a stalled body and releases the native HTTP socket", async () => {
    const f = await fixture({ stalledBody: true });
    const health = await checkApifyAccountUsage("fixture-key", { fetch: f.fetch, timeoutMs: 100 });
    expect(health.alive).toBe(false);
    expect(f.calls()).toBe(1);
    await vi.waitFor(() => expect(f.closedBodies()).toBe(1), { timeout: 1000, interval: 10 });
  });
});
