import { describe, expect, it } from "vitest";
import {
  checkApifyAccountUsage,
  type ApifyAccountUsageHealth,
} from "./apifyUsage.js";

import { makeFetch, makeThrowingFetch, jsonResponse } from "./apifyUsage.test-utils.js";

describe("checkApifyAccountUsage", () => {
  it("returns the current limits balance and keeps provider daily usage exact", async () => {
    const cycleStartAt = "2026-09-01T00:00:00.000Z";
    const cycleEndAt = "2026-10-01T00:00:00.000Z";
    const { fetch, calls } = makeFetch([
      jsonResponse(200, {
        data: {
          current: { monthlyUsageUsd: 12.345678 },
          limits: { maxMonthlyUsageUsd: 100 },
          monthlyUsageCycle: { startAt: cycleStartAt, endAt: cycleEndAt },
        },
      }),
      jsonResponse(200, { data: { id: "usr_abc123" } }),
      jsonResponse(200, {
        data: {
          usageCycle: { startAt: cycleStartAt, endAt: cycleEndAt },
          totalUsageCreditsUsdAfterVolumeDiscount: 9.99,
          dailyServiceUsages: [
            { date: "2026-09-02T00:00:00.000Z", totalUsageCreditsUsd: 2.005 },
            { date: "2026-09-01T00:00:00.000Z", totalUsageCreditsUsd: 0 },
          ],
        },
      }),
    ]);

    const result = await checkApifyAccountUsage("apify-token", {
      fetch,
      now: () => new Date("2026-09-17T12:00:00.000Z"),
    });

    expect(result).toEqual<ApifyAccountUsageHealth>({
      alive: true,
      httpStatus: 200,
      accountId: "usr_abc123",
      monthlyUsageUsd: 12.345678,
      maxMonthlyUsageUsd: 100,
      remainingUsd: 87.654322,
      cycleStartAt,
      cycleEndAt,
      dailyUsage: [
        { date: "2026-09-01", usageUsd: 0 },
        { date: "2026-09-02", usageUsd: 2.005 },
      ],
      fetchedAt: "2026-09-17T12:00:00.000Z",
    });
    expect(calls.map(([input]) => String(input))).toEqual([
      "https://api.apify.com/v2/users/me/limits",
      "https://api.apify.com/v2/users/me",
      "https://api.apify.com/v2/users/me/usage/monthly",
    ]);
    expect(calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer apify-token" });
  });

  it("treats a 401 as invalid without fabricating usage fields", async () => {
    const { fetch } = makeFetch([jsonResponse(401, { error: { message: "token rejected" } })]);

    await expect(checkApifyAccountUsage("dead-token", {
      fetch,
      now: () => new Date("2026-09-17T12:00:00.000Z"),
    })).resolves.toEqual({
      alive: false,
      httpStatus: 401,
      fetchedAt: "2026-09-17T12:00:00.000Z",
      error: "apify limits request failed with HTTP 401",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the limits balance alive when a secondary endpoint is unauthorized", async () => {
    const cycleStartAt = "2026-09-01T00:00:00.000Z";
    const cycleEndAt = "2026-10-01T00:00:00.000Z";
    const { fetch } = makeFetch([
      jsonResponse(200, {
        data: {
          current: { monthlyUsageUsd: 120 },
          limits: { maxMonthlyUsageUsd: 100 },
          monthlyUsageCycle: { startAt: cycleStartAt, endAt: cycleEndAt },
        },
      }),
      jsonResponse(401, { error: { message: "missing scope" } }),
    ]);

    await expect(checkApifyAccountUsage("apify-token", {
      fetch,
      now: () => new Date("2026-09-17T12:00:00.000Z"),
    })).resolves.toEqual({
      alive: true,
      httpStatus: 200,
      monthlyUsageUsd: 120,
      maxMonthlyUsageUsd: 100,
      remainingUsd: 0,
      cycleStartAt,
      cycleEndAt,
      fetchedAt: "2026-09-17T12:00:00.000Z",
      error: "apify user request failed with HTTP 401",
    });
  });

  it("keeps the limits balance alive when a secondary endpoint has a network error", async () => {
    const cycleStartAt = "2026-09-01T00:00:00.000Z";
    const cycleEndAt = "2026-10-01T00:00:00.000Z";
    const { fetch } = makeThrowingFetch([
      jsonResponse(200, {
        data: {
          current: { monthlyUsageUsd: 7 },
          limits: { maxMonthlyUsageUsd: 25 },
          monthlyUsageCycle: { startAt: cycleStartAt, endAt: cycleEndAt },
        },
      }),
      new Error("network down"),
    ]);

    await expect(checkApifyAccountUsage("apify-token", {
      fetch,
      now: () => new Date("2026-09-17T12:00:00.000Z"),
    })).resolves.toEqual({
      alive: true,
      httpStatus: 200,
      monthlyUsageUsd: 7,
      maxMonthlyUsageUsd: 25,
      remainingUsd: 18,
      cycleStartAt,
      cycleEndAt,
      fetchedAt: "2026-09-17T12:00:00.000Z",
      error: "HTTP request failed",
    });
  });

});
