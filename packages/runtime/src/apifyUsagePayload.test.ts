import { describe, expect, it } from "vitest";
import {
  checkApifyAccountUsage,
} from "./apifyUsage.js";

import { makeFetch, jsonResponse } from "./apifyUsage.test-utils.js";
import { parseLimits, readApifyUsd } from "./apifyUsagePayload.js";

describe("optional Apify USD measurements", () => {
  it.each([0, 0.25, "0", "3.25"])("preserves reported amount %j", value => {
    expect(readApifyUsd(value)).toBe(Number(value));
  });
  it.each([undefined, null, "", " ", true, -1, "-0.1", NaN, Infinity, "bad"])("keeps malformed amount %j unknown", value => {
    expect(readApifyUsd(value)).toBeUndefined();
  });
  it.each([null, " ", -1])("retains the strict limits parser's rejection of %j", value => {
    expect(() => parseLimits({ data: { current: { monthlyUsageUsd: value },
      limits: { maxMonthlyUsageUsd: 5 }, monthlyUsageCycle: {
        startAt: "2026-09-01T00:00:00Z", endAt: "2026-10-01T00:00:00Z",
      } } })).toThrow("monthlyUsageUsd must be a nonnegative finite number");
  });
});

describe("Apify usage payload validation", () => {
  it("accepts legacy flat limits with numeric string amounts", async () => {
    const cycle = { startAt: "2026-09-01T00:00:00.000Z", endAt: "2026-09-30T23:59:59.999Z" };
    const { fetch } = makeFetch([
      jsonResponse(200, { data: { monthlyUsageUsd: "3.25", maxMonthlyUsageUsd: "5", monthlyUsageCycle: cycle } }),
      jsonResponse(200, { data: { id: "account" } }),
      jsonResponse(200, { data: { usageCycle: cycle, totalUsageCreditsUsdAfterVolumeDiscount: 3.25,
        dailyServiceUsages: [{ date: "2026-09-17", totalUsageCreditsUsd: 3.25 }] } }),
    ]);
    expect(await checkApifyAccountUsage("token", { fetch })).toMatchObject({
      alive: true, httpStatus: 200, accountId: "account", monthlyUsageUsd: 3.25,
      maxMonthlyUsageUsd: 5, remainingUsd: 1.75,
      dailyUsage: [{ date: "2026-09-17", usageUsd: 3.25 }],
    });
  });

  it("keeps limits health but omits usage when the account id is missing", async () => {
    const cycleStartAt = "2026-09-01T00:00:00.000Z";
    const cycleEndAt = "2026-10-01T00:00:00.000Z";
    const { fetch } = makeFetch([
      jsonResponse(200, {
        data: {
          current: { monthlyUsageUsd: 1 },
          limits: { maxMonthlyUsageUsd: 10 },
          monthlyUsageCycle: { startAt: cycleStartAt, endAt: cycleEndAt },
        },
      }),
      jsonResponse(200, { data: { id: "" } }),
    ]);

    await expect(checkApifyAccountUsage("apify-token", {
      fetch,
      now: () => new Date("2026-09-17T12:00:00.000Z"),
    })).resolves.toEqual({
      alive: true,
      httpStatus: 200,
      monthlyUsageUsd: 1,
      maxMonthlyUsageUsd: 10,
      remainingUsd: 9,
      cycleStartAt,
      cycleEndAt,
      fetchedAt: "2026-09-17T12:00:00.000Z",
      error: "apify user response missing account id",
    });
  });

  it("keeps limits health but omits usage when daily values are invalid", async () => {
    const cycleStartAt = "2026-09-01T00:00:00.000Z";
    const cycleEndAt = "2026-10-01T00:00:00.000Z";
    const { fetch } = makeFetch([
      jsonResponse(200, {
        data: {
          current: { monthlyUsageUsd: 1 },
          limits: { maxMonthlyUsageUsd: 10 },
          monthlyUsageCycle: { startAt: cycleStartAt, endAt: cycleEndAt },
        },
      }),
      jsonResponse(200, { data: { id: "usr_abc123" } }),
      jsonResponse(200, {
        data: {
          usageCycle: { startAt: cycleStartAt, endAt: cycleEndAt },
          totalUsageCreditsUsdAfterVolumeDiscount: 1,
          dailyServiceUsages: [{ date: "2026-09-01T00:00:00.000Z", totalUsageCreditsUsd: -0.01 }],
        },
      }),
    ]);

    await expect(checkApifyAccountUsage("apify-token", {
      fetch,
      now: () => new Date("2026-09-17T12:00:00.000Z"),
    })).resolves.toMatchObject({
      alive: true,
      httpStatus: 200,
      monthlyUsageUsd: 1,
      maxMonthlyUsageUsd: 10,
      remainingUsd: 9,
      cycleStartAt,
      cycleEndAt,
      fetchedAt: "2026-09-17T12:00:00.000Z",
      error: expect.stringContaining("nonnegative finite number"),
    });
  });

  it("keeps limits health but omits account and daily usage when the monthly cycle rolled over", async () => {
    const cycleStartAt = "2026-09-01T00:00:00.000Z";
    const cycleEndAt = "2026-10-01T00:00:00.000Z";
    const { fetch } = makeFetch([
      jsonResponse(200, {
        data: {
          current: { monthlyUsageUsd: 4 },
          limits: { maxMonthlyUsageUsd: 10 },
          monthlyUsageCycle: { startAt: cycleStartAt, endAt: cycleEndAt },
        },
      }),
      jsonResponse(200, { data: { id: "usr_abc123" } }),
      jsonResponse(200, {
        data: {
          usageCycle: {
            startAt: "2026-10-01T00:00:00.000Z",
            endAt: "2026-11-01T00:00:00.000Z",
          },
          totalUsageCreditsUsdAfterVolumeDiscount: 4,
          dailyServiceUsages: [{ date: "2026-10-01T00:00:00.000Z", totalUsageCreditsUsd: 4 }],
        },
      }),
    ]);

    await expect(checkApifyAccountUsage("apify-token", {
      fetch,
      now: () => new Date("2026-09-17T12:00:00.000Z"),
    })).resolves.toEqual({
      alive: true,
      httpStatus: 200,
      monthlyUsageUsd: 4,
      maxMonthlyUsageUsd: 10,
      remainingUsd: 6,
      cycleStartAt,
      cycleEndAt,
      fetchedAt: "2026-09-17T12:00:00.000Z",
      error: "monthly usage billing cycle does not match limits billing cycle",
    });
  });

  it("rejects invalid limits cycle boundaries", async () => {
    const { fetch } = makeFetch([
      jsonResponse(200, {
        data: {
          current: { monthlyUsageUsd: 1 },
          limits: { maxMonthlyUsageUsd: 10 },
          monthlyUsageCycle: {
            startAt: "2026-10-01T00:00:00.000Z",
            endAt: "2026-09-01T00:00:00.000Z",
          },
        },
      }),
    ]);

    await expect(checkApifyAccountUsage("apify-token", {
      fetch,
      now: () => new Date("2026-09-17T12:00:00.000Z"),
    })).resolves.toEqual({
      alive: false,
      httpStatus: 0,
      fetchedAt: "2026-09-17T12:00:00.000Z",
      error: "billing cycle start must be before end",
    });
  });
});
