import { describe, expect, it, vi } from "vitest";
import { checkApifyToken } from "./apifyTokenHealth.js";

const token = "private-fixture-token";
const check = (response: Response, timeoutMs?: number) => checkApifyToken(token, {
  fetchImpl: vi.fn().mockResolvedValue(response), ...(timeoutMs !== undefined ? { timeoutMs } : {}),
});

describe("shared Apify token health", () => {
  it("preserves measured zero and decimal usage, plan and normalized cycle", async () => {
    expect(await check(Response.json({ data: { current: { monthlyUsageUsd: "0" },
      limits: { maxMonthlyUsageUsd: 5.5 }, plan: { id: "FREE" },
      monthlyUsageCycle: { endAt: "2026-06-01T03:00:00+03:00" } } }))).toEqual({
      alive: true, httpStatus: 200, monthlyUsageUsd: 0, maxMonthlyUsageUsd: 5.5,
      remainingUsd: 5.5, plan: "FREE", cycleEndAt: "2026-06-01T00:00:00.000Z",
    });
  });

  it("reads older flat limits and clamps an exhausted account's remaining amount", async () => {
    expect(await check(Response.json({ data: { monthlyUsageUsd: 8, maxMonthlyUsageUsd: "5" } })))
      .toMatchObject({ alive: true, monthlyUsageUsd: 8, maxMonthlyUsageUsd: 5, remainingUsd: 0 });
  });

  it("confirms a valid account with no reported budget fields without inventing usage", async () => {
    expect(await check(Response.json({ data: {} }))).toEqual({ alive: true, httpStatus: 200 });
  });

  it.each(["", " ", null, true, -1, "-2", "Infinity", "bad"])("leaves malformed usage %j unknown", async value => {
    const result = await check(Response.json({ data: { current: { monthlyUsageUsd: value },
      limits: { maxMonthlyUsageUsd: value } } }));
    expect(result).toEqual({ alive: true, httpStatus: 200 });
  });

  it("can use measured flat data when a nested value is malformed", async () => {
    expect(await check(Response.json({ data: { current: { monthlyUsageUsd: " " }, monthlyUsageUsd: 0 } })))
      .toEqual({ alive: true, httpStatus: 200, monthlyUsageUsd: 0 });
  });

  it.each(["2026-02-30T00:00:00Z", "2025-02-29T00:00:00Z", "bad", ""])("leaves malformed cycle %j unknown", async endAt => {
    expect(await check(Response.json({ data: { monthlyUsageCycle: { endAt } } })))
      .toEqual({ alive: true, httpStatus: 200 });
  });

  it.each([201, 401, 403, 429, 500])("retains HTTP %s without accepting it as alive or copying its body", async status => {
    const result = await check(new Response("private-provider-body", { status }));
    expect(result).toMatchObject({ alive: false, httpStatus: status });
    expect(result.error).not.toContain("private-provider-body");
  });

  it.each([200, 401])("bounds oversized metadata with its received HTTP %s", async status => {
    const result = await check(new Response("x".repeat(4 * 1024 * 1024 + 1), { status }));
    expect(result).toMatchObject({ alive: false, httpStatus: status, error: expect.stringContaining("4 MiB") });
  });

  it.each([200, 401])("keeps the deadline active through a stalled HTTP %s body and cancels the reader", async status => {
    const cancel = vi.fn();
    const result = await check(new Response(new ReadableStream({ cancel }), { status }), 20);
    expect(result).toMatchObject({ alive: false, httpStatus: status, error: expect.stringContaining("timed out") });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["invalid JSON", "null", "[]", "{}", '{"data":[]}'])("fails closed on invalid limits metadata %s", async body => {
    expect(await check(new Response(body))).toMatchObject({ alive: false, httpStatus: 200 });
  });

  it("sanitizes network failures and preserves the encoded public token query contract", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error(`https://api.apify.com/?token=${token}`));
    const result = await checkApifyToken(token, { fetchImpl });
    expect(result).toMatchObject({ alive: false, httpStatus: 0 });
    expect(result.error).not.toContain(token);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain(`/v2/users/me/limits?token=${token}`);
  });
});
