import type { Bus } from "@noelle/runtime";
import type { Logger } from "../lib/logger.js";
import type { ActiveInstance } from "../lib/activation.js";
import type { WatchlistSubreddit } from "../lib/watchlist-db.js";
import type { ApifyRedditClient, RedditPost } from "@noelle/reddit-apify";
import type { SpendRecorder } from "@noelle/runtime";
import { withMeteredApifyCall } from "@noelle/runtime/apify-metering";
import { windowSinceISO, laterISO } from "../lib/discovery-config.js";
import { AllApifyTokensExhaustedError } from "../lib/apify-rotating.js";
import { readSourceCount, readSourceVoteScore, readSourceTimestamp } from "@noelle/runtime/source-values";

export interface RunDiscoveryTickArgs {
  log: Logger;
  instance: ActiveInstance;
  /** Subreddits the intern sweeps for grading — the targeting model. */
  watchlistSubreddits: WatchlistSubreddit[];
  /** Apify-backed posts source (no Reddit login). */
  postsSource: Pick<ApifyRedditClient, "subredditPosts" | "drainLastRunUsd" | "drainRunReceipts" | "isolateOperation">;
  /** Records the Apify spend of each subredditPosts run (engine='apify'). Omit to skip. */
  recorder?: SpendRecorder;
  /** noelle.connections id of the token used, stamped on spend rows for per-token attribution. */
  credentialId?: string | null;
  /** Posts to fetch per subreddit this tick. Small + gentle (Apify bills per post). */
  discoveryLimit: number;
  /**
   * How many top comments to fetch + keep per post (REDDIT_COMMENTS_PER_POST). The
   * actor returns them alongside the posts; they ride the lead payload so the
   * drafter can read the room + target the most-upvoted comment. Omit → client default.
   */
  commentsPerPost?: number;
  /**
   * The tailored-run time window (resolved run_config over the saved default).
   * Posts older than (now − timeWindowHours) are dropped before they become
   * leads. Absent/null = no window (only the per-subreddit added_at floor applies).
   */
  timeWindowHours?: number | null;
  /**
   * Daily extract cap (REDDIT_DAILY_EXTRACT_CAP). Once the instance has already
   * extracted this many posts today, discovery stops inserting. The caller passes
   * how many were ALREADY extracted today (`alreadyExtractedToday`); this tick
   * adds to it and stops the moment the running total reaches the cap, so a single
   * day never balloons the classifier backlog.
   */
  dailyExtractCap: number;
  /** Posts already extracted today for this instance (from countExtractedToday). */
  alreadyExtractedToday: number;
  /**
   * Per-subreddit re-poll cooldown (REDDIT_WATCHLIST_REPOLL_HOURS). The daily
   * extract cap only counts new LEADS, so without this every watched subreddit
   * was re-fetched every tick (~96×/day) — quiet subreddits burn full-price
   * Apify runs returning nothing. A subreddit not `due()` is skipped; every
   * attempted fetch is `stamp()`ed (success or failure). Omit = old
   * every-tick behaviour.
   */
  repollGate?: import("@noelle/runtime/repoll-cooldown").RepollGate;
  upsertLead: (args: {
    orgId: string;
    agentInstanceId: string;
    platform: "reddit";
    externalId: string;
    authorHandle: string;
    authorId: string | null;
    payload: Record<string, unknown>;
    postedAt: string | null;
    priority?: boolean;
  }) => Promise<{ id: string; inserted: boolean }>;
  /** Shared-memory bus (optional). Emits a `lead.discovered` event per new lead. */
  bus?: Bus;
}

/**
 * One discovery tick over the subreddit watchlist. For each watched subreddit we
 * fetch its recent posts via Apify (sort='new'), drop posts below the subreddit's
 * score floor, and upsert the rest as NEW, UNCLASSIFIED reddit leads
 * (status='new', priority=false) that the classifier then scores.
 *
 * Posts before a subreddit's added_at are not backfilled (we fetch only posts
 * on/after added_at via sinceISO), and a tailored time window narrows further.
 *
 * Enforces the DAILY EXTRACT CAP: we count newly-inserted leads on top of
 * `alreadyExtractedToday` and stop the moment the running total reaches
 * `dailyExtractCap`, iterating subreddits until then.
 */
export async function runDiscoveryTick(args: RunDiscoveryTickArgs): Promise<number> {
  const {
    log,
    instance,
    watchlistSubreddits,
    postsSource,
    discoveryLimit,
    commentsPerPost,
    timeWindowHours,
    dailyExtractCap,
    alreadyExtractedToday,
    repollGate,
    upsertLead,
    recorder,
    credentialId,
    bus,
  } = args;
  let inserted = 0;
  let scanned = 0;
  let filtered = 0;
  // Subreddits skipped this tick by the re-poll cooldown (logged once).
  let cooledDown = 0;
  // Running total of posts extracted today, including this tick's inserts.
  let extractedToday = alreadyExtractedToday;
  // Post ids already processed this tick — dedupes a post that two watched
  // subreddits both surfaced (crossposts), so it never becomes two leads.
  const seen = new Set<string>();

  // Tailored-run window: posts older than (now − timeWindowHours) are skipped.
  // Computed once per tick so every subreddit uses the same lower bound.
  const tickNow = new Date();
  const windowSince = windowSinceISO(tickNow, timeWindowHours ?? null);

  // Already at/over the cap before we start — don't fetch anything.
  if (extractedToday >= dailyExtractCap) {
    log.info(
      { extractedToday, dailyExtractCap },
      "daily extract cap already reached; skipping discovery tick",
    );
    return 0;
  }

  for (const w of watchlistSubreddits) {
    if (extractedToday >= dailyExtractCap) {
      log.info(
        { extractedToday, dailyExtractCap },
        "daily extract cap reached; stopping discovery tick early",
      );
      break;
    }

    if (!w.subreddit) {
      log.warn({ id: w.id }, "watchlist row has no subreddit; skipping");
      continue;
    }

    // Re-poll cooldown: skip a subreddit attempted within the window. Stamp
    // BEFORE the fetch so a throwing subreddit also cools down instead of being
    // re-hammered every tick (an exhausted token 403s the whole watchlist
    // identically — see the catch below).
    if (repollGate) {
      if (!repollGate.due(w.subreddit.toLowerCase())) {
        cooledDown++;
        continue;
      }
      repollGate.stamp(w.subreddit.toLowerCase());
    }

    let posts: RedditPost[] = [];
    try {
      posts = await withMeteredApifyCall({ client: postsSource, recorder, log,
        orgId: instance.org_id, instanceId: instance.id, agentRole: "reddit_intern", worker: "discovery",
        actor: "reddit-posts-comments-scraper", startedAt: new Date(), credentialId: credentialId ?? null },
        operation => operation.subredditPosts({
        subreddit: w.subreddit,
        sort: "new",
        maxItems: discoveryLimit,
        // Only ingest posts from the day the subreddit was added forward; older
        // history is out of scope. When a tailored-run time window is set, narrow
        // to the later of the two bounds so Apify doesn't return posts the window
        // would just drop.
        sinceISO: laterISO(w.addedAt, windowSince),
        // Fetch the top comments alongside the posts (omit → client default), so
        // the drafter can read the room + target the most-upvoted comment.
        ...(commentsPerPost != null ? { commentsPerPost } : {}),
      }));
    } catch (err) {
      // Every token spent → the rest of the watchlist will 403 identically.
      // Propagate so the worker records the error + pings the operator instead
      // of silently completing with inserted:0 (which reads as "idle").
      if (err instanceof AllApifyTokensExhaustedError) throw err;
      log.error(
        { subreddit: w.subreddit, err: (err as Error).message },
        "apify subredditPosts failed for watched subreddit",
      );
      continue;
    }
    scanned += posts.length;
    for (const post of posts) {
      if (extractedToday >= dailyExtractCap) {
        log.info(
          { extractedToday, dailyExtractCap },
          "daily extract cap reached mid-subreddit; stopping",
        );
        break;
      }
      if (seen.has(post.id)) continue;
      const score = readSourceVoteScore(post.score);
      const numComments = readSourceCount(post.numComments);
      // Per-subreddit score floor: drop low-engagement posts before they become
      // leads. A floor of 0 keeps everything.
      if (w.minScore > 0 && (score === null || score < w.minScore)) {
        filtered++;
        continue;
      }
      seen.add(post.id);
      const postedAt = readSourceTimestamp(post.createdAt);
