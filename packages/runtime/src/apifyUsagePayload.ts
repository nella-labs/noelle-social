import type { ApifyDailyUsage } from "./apifyUsage.js";

/** Preserve an optional provider USD measurement, including zero and decimals. */
export function readApifyUsd(value: unknown): number | undefined {
  const amount = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof amount === "number" && Number.isFinite(amount) && amount >= 0 ? amount : undefined;
}

function finiteNonnegative(value: unknown, field: string): number {
  const amount = readApifyUsd(value);
  if (amount === undefined) {
    throw new Error(`${field} must be a nonnegative finite number`);
  }
  return amount;
}

function isoDate(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be an ISO date string`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${field} must be a valid ISO date string`);
  return parsed.toISOString();
}

function plainDate(value: unknown, field: string): string {
  return isoDate(value, field).slice(0, 10);
}

function dataObject(body: unknown, endpoint: string): Record<string, unknown> {
  const data = (body as { data?: unknown })?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${endpoint} response is missing data`);
  }
  return data as Record<string, unknown>;
}

export function parseLimits(body: unknown): {
  monthlyUsageUsd: number;
  maxMonthlyUsageUsd: number;
  cycleStartAt: string;
  cycleEndAt: string;
} {
  const data = dataObject(body, "limits");
  const current = data.current as Record<string, unknown> | undefined;
  const limits = data.limits as Record<string, unknown> | undefined;
  const cycle = data.monthlyUsageCycle as Record<string, unknown> | undefined;
  const cycleStartAt = isoDate(cycle?.startAt, "monthlyUsageCycle.startAt");
  const cycleEndAt = isoDate(cycle?.endAt, "monthlyUsageCycle.endAt");
  if (new Date(cycleStartAt) >= new Date(cycleEndAt)) throw new Error("billing cycle start must be before end");
  return {
    monthlyUsageUsd: finiteNonnegative(current?.monthlyUsageUsd ?? data.monthlyUsageUsd, "monthlyUsageUsd"),
    maxMonthlyUsageUsd: finiteNonnegative(limits?.maxMonthlyUsageUsd ?? data.maxMonthlyUsageUsd, "maxMonthlyUsageUsd"),
    cycleStartAt,
    cycleEndAt,
  };
}

export function parseAccountId(body: unknown): string | undefined {
  const data = dataObject(body, "user");
  const id = data.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

export function parseMonthlyUsage(
  body: unknown,
  cycleStartAt: string,
  cycleEndAt: string,
): ApifyDailyUsage[] {
  const data = dataObject(body, "monthly usage");
  const cycle = data.usageCycle as Record<string, unknown> | undefined;
  const usageCycleStartAt = isoDate(cycle?.startAt, "usageCycle.startAt");
  const usageCycleEndAt = isoDate(cycle?.endAt, "usageCycle.endAt");
  if (usageCycleStartAt !== cycleStartAt || usageCycleEndAt !== cycleEndAt) {
    throw new Error("monthly usage billing cycle does not match limits billing cycle");
  }
  finiteNonnegative(data.totalUsageCreditsUsdAfterVolumeDiscount, "totalUsageCreditsUsdAfterVolumeDiscount");
  const daily = data.dailyServiceUsages;
  if (!Array.isArray(daily)) throw new Error("dailyServiceUsages must be an array");
  return daily
    .map((entry, index) => {
      const row = entry as Record<string, unknown>;
      return {
        date: plainDate(row.date, `dailyServiceUsages[${index}].date`),
        usageUsd: finiteNonnegative(row.totalUsageCreditsUsd, `dailyServiceUsages[${index}].totalUsageCreditsUsd`),
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}
