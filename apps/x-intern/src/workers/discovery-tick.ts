import {
  qualifyByProfileText,
  icpGateConfigured,
  type Bus,
  type SpendRecorder,
  type IcpHeadlineGate,
} from "@noelle/runtime";
import { X_SCRAPER_ACTOR, type ApifyXClient, type XTweet, type ApifyXRunResult } from "@noelle/x-apify";
import type { Logger } from "../lib/logger.js";
import type { ActiveInstance } from "../lib/activation.js";
import type { Watchlist, WatchlistPerson } from "../lib/watchlist.js";
import type { RateBucket } from "../lib/rate-bucket.js";
import { resolveDiscoveryConfig, sinceFromWindow, buildSearchQuery, laterISO } from "../lib/discovery-config.js";
import { AllApifyTokensExhaustedError } from "../lib/apify-rotating.js";
import { mergeDiscoveryTweets } from "../lib/discovery-merge.js";
import { withMeteredApifyCall } from "../lib/apify-receipts.js";
import { readSourceTimestamp } from "@noelle/runtime/source-values";

export interface RunDiscoveryTickArgs {
  log: Logger;
  instance: ActiveInstance;
  watchlist: Watchlist;
  /** People the intern must always reply to — drives the priority flag. */
  watchlistPeople: WatchlistPerson[];
  /** Read-only X client backed by Apify (see X_SCRAPER_ACTOR_ID in @noelle/x-apify). */
  xClient: ApifyXClient;
  upsertLead: (args: {
    orgId: string;
    agentInstanceId: string;
    platform: "x";
    externalId: string;
    authorHandle: string;
    authorId: string;
    payload: Record<string, unknown>;
    postedAt: string | null;
    priority: boolean;
  }) => Promise<{ id: string; inserted: boolean }>;
  rateBucket: RateBucket;
  /** Disable only Apify reply-lead sourcing after browser discovery is proven. */
  apifyReplyLeadsEnabled?: boolean;
  /** Injectable clock for the time-window math; defaults to wall-clock now. */
  now?: Date;
  /** Shared-memory bus (optional). Emits a `lead.discovered` event per new lead. */
  bus?: Bus;
  /**
   * Watchlist-lane mode: poll ONLY the watchlist-person handles and skip the
   * keyword search entirely. Used when the instance is paused — the keyword
   * lane is off, but the always-reply watched accounts must still be polled so
   * their newest posts become priority leads. Targeting handles + keywords are
   * the keyword lane and are skipped here.
   */
  watchlistOnly?: boolean;
  /** Records Apify per-result spend (engine='apify'). Best-effort; no-op if absent. */
  recorder?: SpendRecorder;
  /** noelle.connections row id of the Apify token that paid, for per-token spend. */
  credentialId?: string | null;
  /**
   * PERSON-FIRST lane. Handles of people previously retained as ICP-qualified
   * candidates (noelle.x_discovered_people). They join the SAME source ring as
   * the watchlist handles, so they inherit the tick budget, the rate bucket, the
   * cursor rotation and the re-poll cooldown rather than needing a parallel
   * loop. They are NOT watchlist people, so their posts become ordinary
   * non-priority leads and the engagement floor still applies to them.
   * Empty/omitted ⇒ the lane is off and the ring is unchanged.
   */
  discoveredHandles?: string[];
  /** Stamp a candidate as polled (drives their cooldown). Best-effort. */
  onPersonPolled?: (handle: string) => Promise<void>;
  /**
   * Retain an ICP-qualified author seen in the keyword lane. Without this the
   * author of every non-reply-worthy tweet is thrown away and has to be
   * re-discovered from scratch. Best-effort; errors are swallowed.
   */
  recordDiscoveredPerson?: (p: {
    handle: string;
    authorId: string | null;
    displayName: string | null;
    bio: string | null;
  }) => Promise<void>;
  /**
   * The ICP author gate. When configured, only authors whose BIO matches are
   * retained — retention is the point at which "who is this person" is decided,
   * so an unqualified author is simply not kept.
   */
  icpGate?: IcpHeadlineGate | null;
  /**
   * WATCH-lane per-person re-poll cooldown (X_WATCHLIST_REPOLL_HOURS). Every
   * watched handle is otherwise re-fetched every tick (~288×/day at the 5-min
   * default) — mostly zero-result Apify runs that still bill + burn rate-bucket
   * tokens. A watchlist-person handle not `due()` is skipped; every attempted
   * fetch is `stamp()`ed (success or failure). Targeting handles and the
   * keyword lane are NEVER gated (a dual-role handle keeps its targeting
   * coverage). Omit = old every-tick behaviour.
   */
  repollGate?: import("@noelle/runtime/repoll-cooldown").RepollGate;
  /**
   * Wall-clock budget (ms) for this tick's Apify runs. The handle + keyword loops
   * do one actor run each; on a pool of slow/queued free-tier tokens a single tick
   * would otherwise spend N × the per-run timeout (10+ min) and the worker looks
   * hung. Once the budget is spent, the loops stop issuing NEW runs and defer the
   * rest to the next tick. Omit ⇒ unbounded (legacy behaviour, used by tests).
   */
  budgetMs?: number;
  /** Injectable clock for the budget (tests). Defaults to Date.now. */
  clockNow?: () => number;
  /**
   * Rotation cursor over the tick's source ring (handles + keywords), held by
   * the worker across ticks. Without it a budget-truncated tick restarts at the
   * HEAD of the fixed source list every time, so with a slow token pool the
   * first few sources eat every tick's budget and the tail — plus the entire
   * keyword lane, which sits after the handles — never runs at all (#494's
   * blind spot). With a cursor, each tick resumes at the first source the
   * previous tick deferred, so coverage walks the whole ring across ticks.
   * Omit ⇒ legacy start-at-head behaviour (tests).
   */
  sourceCursor?: { get(): number; set(v: number): void };
}

const normHandle = (h: string) => h.trim().toLowerCase().replace(/^@/, "");

export async function runDiscoveryTick(args: RunDiscoveryTickArgs): Promise<number> {
  if (args.apifyReplyLeadsEnabled === false) return 0;
  const { log, instance, watchlist, watchlistPeople, xClient, upsertLead, rateBucket, bus, recorder } =
    args;
  let inserted = 0;
  let skippedBackfill = 0;
  let skippedRepost = 0;
  let skippedReply = 0;
  let skippedLowFaves = 0;

  const fetchTweets = (call: (operation: ApifyXClient) => Promise<ApifyXRunResult>) =>
    withMeteredApifyCall({
      client: xClient, recorder, log,
      orgId: instance.org_id,
      instanceId: instance.id,
      agentRole: "x_intern",
      worker: "discovery",
      actor: X_SCRAPER_ACTOR,
      startedAt: new Date(),
      credentialId: args.credentialId ?? null,
    }, call);

  // Tailored-discovery config (0032): the active run override merged over the
  // saved default. `sinceISO` (time window) filters BOTH handle polls and
  // keyword search client-side; the keyword query also carries X's native
  // operators (engagement floor, post-type, lang, since_time) server-side.
  const now = args.now ?? new Date();
  const config = resolveDiscoveryConfig(instance);
  const sinceISO = sinceFromWindow(now, config.timeWindowHours);
  const limit = config.postsPerSource;

  // added_at by normalized handle — a tweet from one of these on/after the
  // person's added_at is flagged priority (always-reply, bypasses filters).
  const peopleAddedAt = new Map(watchlistPeople.map((p) => [normHandle(p.handle), p.addedAt]));
  // Targeting handles — a handle that is ALSO a targeting handle still gets its
  // pre-added_at posts ingested (as normal leads) so watchlisting someone never
  // removes existing targeting coverage of that handle.
  const targetingHandles = new Set(watchlist.handles.map(normHandle));

  // Poll targeting handles ∪ watchlist-person handles, each at most once so a
  // handle that is both doesn't burn two rate-bucket tokens. In watchlist-only
  // mode (paused instance) poll ONLY the watchlist-person handles — targeting
  // handles are part of the keyword lane, which is off.
  const handlesToPoll = args.watchlistOnly
    ? Array.from(new Set(watchlistPeople.map((p) => normHandle(p.handle))))
    : Array.from(
        new Set([
          ...watchlist.handles.map(normHandle),
          ...watchlistPeople.map((p) => normHandle(p.handle)),
        ]),
      );

  // The tick's source ring: handles first, then keywords (keyword lane only when
  // it's on). The cursor rotates the starting point so a budget-truncated tick
  // resumes where the previous one ran out, instead of restarting at the head
  // and starving the tail + the whole keyword lane (see sourceCursor docs).
  // Person-first candidates join the ring as ordinary handle sources. Only on a
  // full tick: watchlistOnly means the instance is PAUSED, where the always-on
  // watchlist lane is the whole point and speculative candidate polling would be
  // spending the operator's Apify budget on people they never chose.
  const candidateHandles = args.watchlistOnly
    ? []
    : Array.from(new Set((args.discoveredHandles ?? []).map(normHandle))).filter(
        (h) => h && !handlesToPoll.includes(h),
      );

  const sources: Array<{ kind: "handle" | "keyword"; value: string }> = [
    ...handlesToPoll.map((value) => ({ kind: "handle" as const, value })),
    ...candidateHandles.map((value) => ({ kind: "handle" as const, value })),
    ...(args.watchlistOnly
      ? []
      : watchlist.keywords.map((value) => ({ kind: "keyword" as const, value }))),
  ];
  const offset = sources.length > 0 ? (args.sourceCursor?.get() ?? 0) % sources.length : 0;
  const ring = offset > 0 ? [...sources.slice(offset), ...sources.slice(0, offset)] : sources;

  // Apify-time budget for this tick. Once `deadline` passes, the loop below stops
  // issuing NEW actor runs (an in-flight run still finishes under its own per-run
  // timeout) and defers the untouched sources to the next tick — so a pool of
  // slow/queued free-tier tokens can't make one tick run for 10+ minutes.
