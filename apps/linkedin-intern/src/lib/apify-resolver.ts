import type { Sql } from "postgres";
import { withApifyCredentialDb } from "@noelle/runtime/apify-pool-db";
import {
  createApifyLinkedInClient,
  checkApifyToken,
  type ApifyLinkedInClient,
} from "@noelle/linkedin-apify";
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
  client: ApifyLinkedInClient;
  /** The connections row id the token came from (null on the env/SM fallback). */
  credentialId: string | null;
}

interface ResolverDeps {
  sql: Sql;
  secrets: { get: (id: string) => Promise<string> };
  apifyTokenSecretId: string;
  profilePostsActorId?: string;
  log: { warn: (obj: Record<string, unknown>, msg: string) => void };
}

/** Only a successful empty read permits the legacy credential fallback. */
function readTokenPool(deps: ResolverDeps, orgId: string) {
  return withApifyCredentialDb(deps.sql, sql => listApifyTokens(sql, orgId));
}

/**
 * Days to cool down a token that 401'd on ONE actor call but a health-check just
 * proved alive — almost certainly a transient blip (a flaky proxy / a single bad
 * actor run), not a dead account. Far shorter than the monthly exhaustion cooldown:
 * we just want to skip it for the rest of this short window, not retire it.
 */
const TRANSIENT_401_COOLDOWN_DAYS = 1;

/**
 * Slack added past the probed cycle end before a 403'd token is retried, to absorb
 * clock skew and any Apify-side lag in actually refilling the monthly cap.
 */
const CYCLE_RESET_BUFFER_MS = 60 * 60 * 1000;

/**
 * Probe a token's REAL monthly-cycle reset (free, no spend) so a token that hit its
 * usage cap is benched until it actually refills rather than a flat +30d guess.
 * Returns the reset instant (cycle end + buffer), or null when the probe can't
 * report a cycle (caller falls back to the default cooldown). Never throws.
 */
async function probeCycleResetAt(token: string): Promise<Date | null> {
  const health = await checkApifyToken(token).catch(() => null);
  if (!health?.cycleEndAt) return null;
  const end = Date.parse(health.cycleEndAt);
  return Number.isNaN(end) ? null : new Date(end + CYCLE_RESET_BUFFER_MS);
}

/**
 * Route a token-fatal Apify error to the right DB flag, VERIFYING before we ever
 * mark a token invalid. The bug this fixes: a single 401 from one actor call used
 * to call markApifyTokenInvalid immediately, permanently retiring a token that was
 * actually fine (~11 live tokens with $0 spend got killed this way). Now:
 *
 *  - 401 -> health-check the token with checkApifyToken first.
 *      • health-check ALSO 401 (genuinely dead/banned) -> markApifyTokenInvalid.
 *      • health-check alive (transient 401) -> do NOT invalidate; give it a short
 *        retry_at cooldown (markApifyTokenExhausted) so it re-enters rotation soon.
 *      • health-check inconclusive (network/other) -> also short cooldown, never a
 *        permanent kill on a probe we couldn't trust.
 *  - 403 (monthly cap) -> markApifyTokenExhausted, retry aligned to the token's
 *    REAL billing-cycle reset (probed) so it isn't benched weeks past its refill.
 *  - 402 (payment) -> markApifyTokenExhausted with the default cooldown (a cycle
 *    reset won't clear a payment problem).
 *
 * Fire-and-forget: never throws (errors are swallowed so the worker tick proceeds).
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
      // Monthly usage cap. Bench until the token's actual cycle reset when we can
      // probe it; otherwise the default ~30d cooldown.
      const retryAt = await probeCycleResetAt(token);
      await markApifyTokenExhausted(deps.sql, credentialId, retryAt ? { retryAt } : {});
      return;
    }
    if (status !== 401) {
      // 402 payment / other token-fatal: default cooldown.
      await markApifyTokenExhausted(deps.sql, credentialId);
      return;
    }
    // 401: verify the token is REALLY dead before retiring it forever.
    const health = await checkApifyToken(token).catch(
      () => ({ alive: false, httpStatus: 0 }) as Awaited<ReturnType<typeof checkApifyToken>>,
    );
    if (!health.alive && health.httpStatus === 401) {
      // Confirmed bad/banned/deleted account -> drop from rotation until re-pasted.
      await markApifyTokenInvalid(deps.sql, { orgId, credentialId, token });
      return;
    }
    // Token is alive (or the probe was inconclusive): the actor 401 was transient.
    // Do NOT invalidate — short cooldown so it retries soon instead of dying.
    deps.log.warn(
      { credentialId, actorStatus: status, healthStatus: health.httpStatus, alive: health.alive },
      "apify 401 was transient (token still alive on health-check); cooling down instead of invalidating",
    );
    await markApifyTokenExhausted(deps.sql, credentialId, { cooldownDays: TRANSIENT_401_COOLDOWN_DAYS });
  } catch {
    // Fire-and-forget: never let flag bookkeeping break the worker tick.
  }
}

/**
 * Build a per-org Apify client resolver with hot-swap + multi-token fallback.
 * Each call reads the org's ACTIVE noelle.connections apify tokens (set/rotated in
 * the dashboard — the operator can stack several as fallbacks) and returns a
 * rotating client: it tries them in order and, when one hits its monthly usage
 * hard limit (403), marks it exhausted and rotates to the next — mid-tick, no
 * restart. Falls back to the env/SM token only after a successful empty read of
 * the active, in-use token pool. Database failures propagate. Returns null when
 * no token is available anywhere (caller skips the fetch rather than crashing). When every token is
 * spent, the client throws AllApifyTokensExhaustedError, which the worker surfaces.
 *
 * The returned credentialId is the first (primary) candidate's id, stamped on
 * spend rows; on a rare mid-tick rotation later rows attribute to the prior token.
 */
export function createApifyResolver(deps: ResolverDeps): (orgId: string) => Promise<ApifyHandle | null> {
  const buildClient = (token: string): ApifyLinkedInClient =>
    createApifyLinkedInClient({
      token,
      ...(deps.profilePostsActorId ? { profilePostsActorId: deps.profilePostsActorId } : {}),
    });

  return async (orgId: string): Promise<ApifyHandle | null> => {
    const dbTokens = await readTokenPool(deps, orgId);

    // Successfully empty active, in-use pool → legacy env/SM fallback.
    // One token, no DB-backed exhaustion tracking.
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

    // DB pool: try only the AVAILABLE tokens (fresh + ones whose retry/billing
    // date has passed). Still-cooling tokens are skipped — but counted via
    // totalCount, so when none are available the rotating client raises
    // "all N exhausted" (→ worker error + Pushover) instead of silently wasting
    // 403 calls on dead tokens.
    const available: RotatingTokenCandidate[] = dbTokens
      .filter((t) => t.available)
      .map((t) => ({ credentialId: t.credentialId, token: t.token, wasExhausted: t.wasExhausted }));

    const client = createRotatingApifyClient({
      candidates: available,
      totalCount: dbTokens.length,
      buildClient,
      onTokenFatal: (id, status, token) => {
        // 401 = VERIFY (health-check) before invalidating — a transient 401 must
        // not permanently kill a good token. 402/403 = usage cap → exhausted.
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

/**
 * Build a per-org Apify POOL resolver for CONCURRENT discovery: instead of one
 * rotating client (tokens tried one-at-a-time on exhaustion), it returns one
 * handle PER AVAILABLE token, each a single-token client. The discovery worker
 * shards the watchlist people + keyword queries across these handles and fetches
 * them in parallel — N tokens = ~N× the search throughput, with each person/
 * keyword assigned to exactly one handle so no two tokens hit the same target.
