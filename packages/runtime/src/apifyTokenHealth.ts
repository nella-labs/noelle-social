import { decodeHttpJson, fetchBoundedHttpResponse, HttpBodyError } from "./boundedHttp.js";
import { readSourceTimestamp } from "./sourceValues.js";
import type { ApifyAccountUsageHealth } from "./apifyUsage.js";
import { readApifyUsd } from "./apifyUsagePayload.js";

/** Optional account limits are measurements; an absent balance is not zero. */
export interface ApifyTokenHealth extends ApifyAccountUsageHealth { plan?: string }
export interface CheckApifyTokenOpts { baseUrl?: string; timeoutMs?: number; fetchImpl?: typeof fetch }

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Account health is actor-independent. The deadline covers headers and bounded body. */
export async function checkApifyToken(token: string, opts: CheckApifyTokenOpts = {}): Promise<ApifyTokenHealth> {
  let httpStatus = 0;
  try {
    const { response, bytes } = await fetchBoundedHttpResponse(
      `${opts.baseUrl ?? "https://api.apify.com"}/v2/users/me/limits?token=${encodeURIComponent(token)}`,
      { method: "GET", headers: { accept: "application/json" } },
      { timeoutMs: opts.timeoutMs ?? 15_000, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) },
    );
    httpStatus = response.status;
    if (httpStatus !== 200) return { alive: false, httpStatus, error: `Apify account endpoint returned HTTP ${httpStatus}` };
    const data = object(object(decodeHttpJson(bytes))?.data);
    if (!data) return { alive: false, httpStatus, error: "Apify account metadata is missing limits data" };
    const monthlyUsageUsd = readApifyUsd(object(data.current)?.monthlyUsageUsd) ?? readApifyUsd(data.monthlyUsageUsd);
    const maxMonthlyUsageUsd = readApifyUsd(object(data.limits)?.maxMonthlyUsageUsd) ?? readApifyUsd(data.maxMonthlyUsageUsd);
    const cycleEndAt = readSourceTimestamp(object(data.monthlyUsageCycle)?.endAt);
    const planRaw = typeof data.plan === "string" ? data.plan : object(data.plan)?.id;
    const plan = typeof planRaw === "string" && planRaw.trim() ? planRaw.slice(0, 128) : undefined;
    return {
      alive: true, httpStatus,
      ...(monthlyUsageUsd !== undefined ? { monthlyUsageUsd } : {}),
      ...(maxMonthlyUsageUsd !== undefined ? { maxMonthlyUsageUsd } : {}),
      ...(monthlyUsageUsd !== undefined && maxMonthlyUsageUsd !== undefined
        ? { remainingUsd: Math.max(0, maxMonthlyUsageUsd - monthlyUsageUsd) } : {}),
      ...(cycleEndAt ? { cycleEndAt } : {}), ...(plan ? { plan } : {}),
    };
  } catch (error) {
    const status = error instanceof HttpBodyError ? error.status ?? httpStatus : httpStatus;
    const detail = error instanceof HttpBodyError && error.code === "body_too_large"
      ? "exceeds the 4 MiB response limit" : error instanceof HttpBodyError && error.code === "timeout"
        ? "timed out" : error instanceof HttpBodyError && error.code === "invalid_json"
          ? "returned invalid JSON" : "request failed";
    return { alive: false, httpStatus: status, error: `Apify account check ${detail}` };
  }
}
