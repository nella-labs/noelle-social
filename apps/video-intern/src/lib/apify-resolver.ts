import type { Sql } from "postgres";
import { createApifyVideoClient, checkApifyToken, type ApifyVideoClient } from "@noelle/video-apify";
import {
  listApifyTokens,
  markApifyTokenExhausted,
  markApifyTokenInvalid,
  clearApifyTokenExhausted,
} from "./connections-db.js";
import {
  createRotatingApifyClient,
  type RotatingTokenCandidate,
} from "./apify-rotating.js";

export interface ApifyHandle {
  client: ApifyVideoClient;
  /** The connections row id the token came from (null on the env/SM fallback). */
  credentialId: string | null;
}

interface ResolverDeps {
  sql: Sql;
  secrets: { get: (id: string) => Promise<string> };
  apifyTokenSecretId: string;
  /** Override the Instagram actor (default apify~instagram-scraper). */
  instagramActorId?: string;
  /** Override the TikTok actor (default clockworks~tiktok-scraper). */
  tiktokActorId?: string;
  log: { warn: (obj: Record<string, unknown>, msg: string) => void };
}

/** Days to cool down a token that 401'd once but a health-check proved alive. */
const TRANSIENT_401_COOLDOWN_DAYS = 1;
/** Slack past the probed cycle end before a 403'd token is retried. */
const CYCLE_RESET_BUFFER_MS = 60 * 60 * 1000;

/**
 * Probe a token's REAL monthly-cycle reset (free, no spend). Returns the reset
 * instant (cycle end + buffer), or null when the probe can't report a cycle.
 */
async function probeCycleResetAt(token: string): Promise<Date | null> {
  const health = await checkApifyToken(token).catch(() => null);
  if (!health?.cycleEndAt) return null;
  const end = Date.parse(health.cycleEndAt);
  return Number.isNaN(end) ? null : new Date(end + CYCLE_RESET_BUFFER_MS);
}

/**
 * Route a token-fatal Apify error to the right DB flag, VERIFYING before we ever
 * mark a token invalid. 401 → health-check first (only invalid when the probe
 * ALSO 401s); 403 (monthly cap) → exhausted with retry aligned to the real
 * billing-cycle reset; 402 (payment) → exhausted with default cooldown.
 * Fire-and-forget: never throws.
 */
export async function handleTokenFatal(
  deps: ResolverDeps,
  credentialId: string,
  status: number,
  token: string,
  orgId: string,
): Promise<void> {
  try {
    if (status === 403) {
      const retryAt = await probeCycleResetAt(token);
      await markApifyTokenExhausted(deps.sql, credentialId, retryAt ? { retryAt } : {});
      return;
    }
    if (status !== 401) {
      await markApifyTokenExhausted(deps.sql, credentialId);
      return;
    }
    const health = await checkApifyToken(token).catch(
      () => ({ alive: false, httpStatus: 0 }) as Awaited<ReturnType<typeof checkApifyToken>>,
    );
    if (!health.alive && health.httpStatus === 401) {
      await markApifyTokenInvalid(deps.sql, { orgId, credentialId, token });
      return;
    }
    deps.log.warn(
      { credentialId, actorStatus: status, healthStatus: health.httpStatus, alive: health.alive },
      "apify 401 was transient (token still alive on health-check); cooling down instead of invalidating",
    );
    await markApifyTokenExhausted(deps.sql, credentialId, { cooldownDays: TRANSIENT_401_COOLDOWN_DAYS });
  } catch {
    // Fire-and-forget: never let flag bookkeeping break the worker tick.
  }
}

function buildClientWith(deps: ResolverDeps): (token: string) => ApifyVideoClient {
  return (token: string): ApifyVideoClient =>
    createApifyVideoClient({
      token,
      ...(deps.instagramActorId ? { instagramActorId: deps.instagramActorId } : {}),
      ...(deps.tiktokActorId ? { tiktokActorId: deps.tiktokActorId } : {}),
    });
}

/**
 * Build a per-org Apify client resolver with hot-swap + multi-token fallback.
 * Reads the org's ACTIVE noelle.connections apify tokens and returns a rotating
 * client. Falls back to the env/SM token only when no DB tokens are set. Returns
 * null when no token is available anywhere (caller skips the fetch).
 */
export function createApifyResolver(deps: ResolverDeps): (orgId: string) => Promise<ApifyHandle | null> {
  const buildClient = buildClientWith(deps);

  return async (orgId: string): Promise<ApifyHandle | null> => {
    const dbTokens = await listApifyTokens(deps.sql, orgId).catch(() => []);

    if (dbTokens.length === 0) {
      const envToken = await deps.secrets.get(deps.apifyTokenSecretId).catch(() => null);
      if (!envToken) {
        deps.log.warn({ orgId }, "no apify token (no active connection + no env fallback); skipping apify fetch");
        return null;
      }
      const client = createRotatingApifyClient({
        candidates: [{ credentialId: null, token: envToken, wasExhausted: false }],
        totalCount: 1,
        buildClient,
        log: deps.log,
      });
      return { client, credentialId: null };
    }

    const available: RotatingTokenCandidate[] = dbTokens
      .filter((t) => t.available)
      .map((t) => ({ credentialId: t.credentialId, token: t.token, wasExhausted: t.wasExhausted }));

    const client = createRotatingApifyClient({
      candidates: available,
      totalCount: dbTokens.length,
      buildClient,
      onTokenFatal: (id, status, token) => {
        void handleTokenFatal(deps, id, status, token, orgId);
      },
      onRecovered: (id) => {
        void clearApifyTokenExhausted(deps.sql, id).catch(() => {});
      },
      log: deps.log,
    });

    return { client, credentialId: available[0]?.credentialId ?? null };
  };
}
