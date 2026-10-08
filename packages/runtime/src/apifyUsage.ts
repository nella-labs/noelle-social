import { parseLimits, parseAccountId, parseMonthlyUsage } from "./apifyUsagePayload.js";
import { decodeHttpJson, fetchBoundedHttpResponse, HttpBodyError } from "./boundedHttp.js";

export interface ApifyDailyUsage {
  date: string;
  usageUsd: number;
}

export interface ApifyAccountUsageHealth {
  alive: boolean;
  httpStatus: number;
  monthlyUsageUsd?: number;
  maxMonthlyUsageUsd?: number;
  remainingUsd?: number;
  cycleStartAt?: string;
  cycleEndAt?: string;
  accountId?: string;
  dailyUsage?: ApifyDailyUsage[];
  fetchedAt?: string;
  error?: string;
}

export interface CheckApifyAccountUsageOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
  signal?: AbortSignal;
}

const APIFY_API = "https://api.apify.com/v2";

async function fetchJson(
  fetchImpl: typeof fetch,
  token: string,
  path: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ status: number; body: unknown }> {
  const { response, bytes } = await fetchBoundedHttpResponse(`${APIFY_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    ...(signal ? { signal } : {}),
  }, { timeoutMs, fetchImpl });
  // The HTTP status alone is the definitive rejection signal; malformed error bodies add no evidence.
  return { status: response.status, body: response.status === 200 ? decodeHttpJson(bytes) : {} };
}

function computeRemainingUsd(maxMonthlyUsageUsd: number, monthlyUsageUsd: number): number {
  return Number(Math.max(0, maxMonthlyUsageUsd - monthlyUsageUsd).toFixed(12));
}

function partialLimitsHealth(
  httpStatus: number,
  fetchedAt: string,
  limits: {
    monthlyUsageUsd: number;
    maxMonthlyUsageUsd: number;
    cycleStartAt: string;
    cycleEndAt: string;
  },
  error: string,
): ApifyAccountUsageHealth {
  return {
    alive: true,
    httpStatus,
    monthlyUsageUsd: limits.monthlyUsageUsd,
    maxMonthlyUsageUsd: limits.maxMonthlyUsageUsd,
    remainingUsd: computeRemainingUsd(limits.maxMonthlyUsageUsd, limits.monthlyUsageUsd),
    cycleStartAt: limits.cycleStartAt,
    cycleEndAt: limits.cycleEndAt,
    fetchedAt,
    error,
  };
}

export async function checkApifyAccountUsage(
  token: string,
  opts: CheckApifyAccountUsageOptions = {},
): Promise<ApifyAccountUsageHealth> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const fetchedAt = (opts.now ?? (() => new Date()))().toISOString();
  const deadline = performance.now() + timeoutMs;
  const request = (path: string) => {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining < 1) throw new Error("Apify account check timed out");
    return fetchJson(fetchImpl, token, path, remaining, opts.signal);
  };

  try {
    const limitsResponse = await request("/users/me/limits");
    if (limitsResponse.status !== 200) {
      return {
        alive: false,
        httpStatus: limitsResponse.status,
        fetchedAt,
        error: `apify limits request failed with HTTP ${limitsResponse.status}`,
      };
    }

    const limits = parseLimits(limitsResponse.body);
    let userResponse: { status: number; body: unknown };
    try {
      userResponse = await request("/users/me");
    } catch (err) {
      return partialLimitsHealth(
        200,
        fetchedAt,
        limits,
        err instanceof Error ? err.message : String(err),
      );
    }
    if (userResponse.status !== 200) {
      return partialLimitsHealth(
        200,
        fetchedAt,
        limits,
        `apify user request failed with HTTP ${userResponse.status}`,
      );
    }
    const accountId = parseAccountId(userResponse.body);
    if (!accountId) {
      return partialLimitsHealth(200, fetchedAt, limits, "apify user response missing account id");
    }
    let monthlyResponse: { status: number; body: unknown };
    try {
      monthlyResponse = await request("/users/me/usage/monthly");
    } catch (err) {
      return partialLimitsHealth(
        200,
        fetchedAt,
        limits,
        err instanceof Error ? err.message : String(err),
      );
    }
    if (monthlyResponse.status !== 200) {
      return partialLimitsHealth(
        200,
        fetchedAt,
        limits,
        `apify monthly usage request failed with HTTP ${monthlyResponse.status}`,
      );
    }
    let dailyUsage: ApifyDailyUsage[];
    try {
      dailyUsage = parseMonthlyUsage(monthlyResponse.body, limits.cycleStartAt, limits.cycleEndAt);
    } catch (err) {
      return partialLimitsHealth(
        200,
        fetchedAt,
        limits,
        err instanceof Error ? err.message : String(err),
      );
    }
    return {
      alive: true,
      httpStatus: 200,
      ...(accountId ? { accountId } : {}),
      monthlyUsageUsd: limits.monthlyUsageUsd,
      maxMonthlyUsageUsd: limits.maxMonthlyUsageUsd,
      remainingUsd: computeRemainingUsd(limits.maxMonthlyUsageUsd, limits.monthlyUsageUsd),
      cycleStartAt: limits.cycleStartAt,
      cycleEndAt: limits.cycleEndAt,
      dailyUsage,
      fetchedAt,
    };
  } catch (err) {
    return {
      alive: false,
      httpStatus: err instanceof HttpBodyError ? err.status ?? 0 : 0,
      fetchedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
