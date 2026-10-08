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
  const clockNow = args.clockNow ?? Date.now;
  const deadline = args.budgetMs != null ? clockNow() + args.budgetMs : Infinity;
  const overBudget = () => clockNow() >= deadline;
  let deferredHandles = 0;
  let deferredKeywords = 0;

  const batches: XTweet[][] = [];
  let cooledDown = 0;
  // Ring index of the first source this tick could NOT actually poll — budget-
  // deferred or rate-starved. That's where the next tick resumes. Cooldown
  // skips and failed fetches DO advance the cursor: they were handled, and
  // re-hammering them next tick would be waste.
  let firstUnpolled: number | null = null;
  // Set when the Apify pool dies mid-ring. We stop polling immediately but still
  // persist whatever was already fetched (and paid for) before re-throwing, so a
  // dead pool costs the operator nothing twice.
  let exhausted: AllApifyTokensExhaustedError | null = null;
  for (let i = 0; i < ring.length; i++) {
    const src = ring[i]!;
    if (overBudget()) {
      firstUnpolled ??= i;
      if (src.kind === "handle") deferredHandles++;
      else deferredKeywords++;
      continue;
    }
    if (src.kind === "handle") {
      const handle = src.value;
      // Re-poll cooldown — WATCH-lane handles only. A handle that is also a
      // targeting handle is gated only in watchlist-only mode (with the keyword
      // lane on, its poll doubles as targeting coverage and must stay every-tick).
      const watchLaneOnly =
        peopleAddedAt.has(handle) && (args.watchlistOnly || !targetingHandles.has(handle));
      if (args.repollGate && watchLaneOnly && !args.repollGate.due(handle)) {
        cooledDown++;
        continue;
      }
      if (!rateBucket.tryTake()) {
        firstUnpolled ??= i;
        log.warn({ handle }, "rate bucket empty; skipping handle this tick");
        continue;
      }
      // Stamp BEFORE the fetch (but after the rate-bucket take, so a token-starved
      // skip retries next tick) — a throwing handle also cools down instead of
      // being re-hammered every tick.
      if (args.repollGate && watchLaneOnly) args.repollGate.stamp(handle);
      // Stamp a person-first candidate as polled BEFORE the fetch, so one whose
      // timeline errors cools down like everyone else instead of sitting at the
      // front of the never-polled queue and being retried every tick.
      const isCandidate = candidateHandles.includes(handle);
      if (isCandidate && args.onPersonPolled) {
        await args.onPersonPolled(handle).catch(() => {});
      }
      try {
        const { tweets } = await fetchTweets(operation => operation.userTweets({
          handle,
          limit,
          // Narrow to max(window, added_at). Posts from BEFORE a watchlist person
          // was added are dropped client-side a few lines below (their history
          // belongs to the profiler, not the reply pipeline) — and Apify bills
          // PER ITEM, so without this bound the lane pays for rows it is
          // guaranteed to discard. Only tightens the window, never widens it, and
          // a targeting-only handle (no added_at) keeps the plain window.
          // Gate on watchLaneOnly so this agrees with the backfill rule ~130
          // lines below: a DUAL-ROLE handle (both a watch person and a targeting
          // handle) deliberately keeps its pre-added_at posts as normal
          // non-priority leads, so narrowing its fetch to added_at would cut
          // exactly the targeting coverage that rule preserves.
          sinceISO:
            laterISO(sinceISO ?? "", watchLaneOnly ? peopleAddedAt.get(handle) : null) ||
            undefined,
          // Server-side operators: both would be billed then dropped client-side
          // otherwise. Reposts never become leads at all (dropped uncondition-
          // ally below), so retweets are always excluded server-side.
          excludeReplies: config.excludeReplies,
          excludeRetweets: true,
        }));
        batches.push(tweets);
      } catch (err) {
        // A DEAD POOL is systemic, not per-source: every remaining source would
        // fail the same way, and swallowing it made the worker's own
        // AllApifyTokensExhaustedError handler unreachable — discovery could sit
        // dead for a day with no errored run and no alert (#494). But do NOT
        // unwind straight out: tweets already fetched this tick were paid for
        // and metered, and their handles are already on the re-poll cooldown, so
        // throwing here would bin them and re-buy them later. Stop polling, fall
        // through to persistence, and re-throw after the leads are saved.
        if (err instanceof AllApifyTokensExhaustedError) {
          exhausted = err;
          break;
        }
        log.error({ handle, err: (err as Error).message }, "userTweets failed");
      }
    } else {
      const keyword = src.value;
      if (!rateBucket.tryTake()) {
        firstUnpolled ??= i;
        log.warn({ keyword }, "rate bucket empty; skipping keyword this tick");
        continue;
      }
      try {
        const query = buildSearchQuery(keyword, config, now);
        const { tweets } = await fetchTweets(operation => operation.searchTimeline({ query, limit, sinceISO }));
        batches.push(tweets);
      } catch (err) {
        // Systemic — see the handle lane above.
        if (err instanceof AllApifyTokensExhaustedError) {
          exhausted = err;
          break;
        }
        log.error({ keyword, err: (err as Error).message }, "searchTimeline failed");
      }
    }
  }
  // Advance the cursor to the first source this tick could not poll (budget-
  // deferred or rate-starved); a full pass wraps back to the head.
  const advance = firstUnpolled ?? ring.length;
  args.sourceCursor?.set(sources.length > 0 ? (offset + advance) % sources.length : 0);
  if (cooledDown > 0) {
    log.info(
      { cooledDown, watchlistPeople: watchlistPeople.length },
      "watch lane: handles skipped by re-poll cooldown",
    );
  }

  // Surface a budget-truncated tick — never a silent cap. The deferred sources
  // are the ring's tail, so the rotated next tick starts exactly there.
  if (deferredHandles > 0 || deferredKeywords > 0) {
    log.warn(
      { instance: instance.id, deferredHandles, deferredKeywords, budgetMs: args.budgetMs },
      "discovery tick hit its Apify time budget; deferring remaining sources to next tick",
    );
  }

  const all = mergeDiscoveryTweets(batches);
  for (const t of all) {
    try {
      // Reposts (native retweets) never become leads. The author is sharing
      // someone else's words verbatim, so a reply would land on a stranger's
      // tweet, not theirs. This runs BEFORE the priority/backfill checks so it
      // covers BOTH lanes — a watchlist person's repost is dropped even though
      // priority leads otherwise bypass the classifier + relevance gates.
      // Quote-tweets are NOT reposts (is_repost=false) and still flow through.
      if (t.is_repost) {
        skippedRepost++;
        continue;
      }
      // Replies (a post sitting under someone else's tweet) are dropped when
      // excludeReplies is on, so the agent answers ORIGINAL posts, not buried
      // comments. BOTH lanes also ask X to `-filter:replies` server-side now
      // (buildSearchQuery for keywords, the from: query for handle polls), but
      // those operators are best-effort — this client-side skip (on the
      // normaliser's is_reply flag) stays as the guarantee for BOTH lanes. Runs
      // before the priority/backfill checks so a watchlist person's replies are
      // dropped too (priority leads otherwise bypass the classifier gate).
      if (config.excludeReplies && t.is_reply) {
        skippedReply++;
        continue;
      }
      // PER-LANE ENGAGEMENT FLOOR. minFaves is a KEYWORD-lane heuristic: when
      // trawling strangers, engagement is the only cheap proxy for "is this
      // worth reading". It is the wrong instrument for the WATCH lane, where the
      // operator already hand-picked the person — "the person is the gate, not
      // the post" (#185). A watched founder's quiet 2-like question is exactly
      // what Vega should answer, and dropping it at discovery meant the operator
      // could add someone and still never see their posts.
      //
      // The old comment justified the blanket floor with "priority leads
      // otherwise bypass the classifier gate". That is no longer true: watchlist
      // leads are now classified like everything else, with the priority clamp's
      // off-topic floor (CLAMP_MIN_Q) dropping genuinely off-topic ones. So the
      // quality judgement happens where it belongs — on content, downstream —
      // instead of on a like count at ingest.
      //
      // Only drops when the like count is KNOWN to be below: an unknown (null)
      // count is never punished (mirrors author_followers), and for the search
      // lane the server-side operator already filters the unknowns out.
      const laneHandle = normHandle(t.author.handle);
      const isWatchPerson = peopleAddedAt.has(laneHandle);
      // PERSON-FIRST RETENTION. Decide "is this the right person" from their BIO
      // and keep the ones that qualify, whether or not this particular tweet
      // becomes a lead. Without it the author of every non-reply-worthy tweet is
      // discarded and has to be rediscovered from scratch next time.
      // Watchlist people are already retained by the watchlist itself, so they
      // are skipped. Fail-open on a missing bio would retain everyone, so here —
      // unlike the classifier's gate — an UNKNOWN bio does NOT qualify: this is
      // a speculative prospect list, and filling it with unvetted handles would
      // spend Apify budget polling strangers.
      if (
        args.recordDiscoveredPerson &&
        !isWatchPerson &&
        icpGateConfigured(args.icpGate) &&
        qualifyByProfileText(t.author.bio, args.icpGate!, "reject").qualified
      ) {
        await args
          .recordDiscoveredPerson({
            handle: laneHandle,
            authorId: t.author.id || null,
            displayName: null,
            bio: t.author.bio ?? null,
          })
          .catch(() => {});
      }
      if (
        !isWatchPerson &&
        config.minFaves != null &&
        t.likes != null &&
        t.likes < config.minFaves
      ) {
        skippedLowFaves++;
        continue;
      }
      // A watchlist person's posts from BEFORE they were added are NOT drafted —
      // their history is owned by the profiler (deep fetch + summary), not the
      // reply pipeline. Skip them so adding someone never backfills their old
      // posts into the approval queue. EXCEPT when the handle is also a targeting
      // handle: then its pre-added_at posts are still ingested as normal
      // (non-priority) leads, preserving the targeting coverage. Posts on/after
      // added_at from a watchlist person are priority ("from the day added").
      const handle = laneHandle;
      const addedAt = peopleAddedAt.get(handle);
      const postedAt = readSourceTimestamp(t.created_at);
      const beforeAdded =
        addedAt != null && postedAt != null && new Date(postedAt).getTime() < new Date(addedAt).getTime();
      if (beforeAdded && !targetingHandles.has(handle)) {
        skippedBackfill++;
        continue;
      }
      const priority = addedAt != null && !beforeAdded;
      const res = await upsertLead({
        orgId: instance.org_id,
        agentInstanceId: instance.id,
        platform: "x",
        externalId: t.id,
        authorHandle: t.author.handle,
        authorId: t.author.id,
        payload: {
          text: t.text,
          url: t.url,
          // `author_followers` is the canonical field the dashboard and the
          // classifier's follower-floor both read. (Was `followers` — a name
          // the UI never picked up.) null = unknown, never punished.
          author_followers: t.author.followers,
          // Author bio when the actor sent one (often absent). Feeds the ICP
          // author gate, which treats a missing bio as UNKNOWN and fails open.
          ...(t.author.bio ? { author_bio: t.author.bio } : {}),
          // Engagement counts when the scraper carried them (null = unknown).
          // The ideation worker reads these to rank a watchlist author's best
          // posts; the reply selector also uses them as observed activity signals.
          ...(t.likes != null ? { likes: t.likes } : {}),
          ...(t.reposts != null ? { reposts: t.reposts } : {}),
          ...(t.replies != null ? { replies: t.replies } : {}),
          // Post media image URLs for a downstream vision-caption step. Only
          // present on tweets that actually have media (omitted otherwise).
          ...(t.images && t.images.length > 0 ? { images: t.images } : {}),
          // Reply marker (kept for debugging/UI). When excludeReplies is on these
          // are filtered out above, so a stored is_reply only appears with the
          // filter off — but recording it makes the lane's behaviour auditable.
          ...(t.is_reply ? { is_reply: true } : {}),
          ...(t.conversation_id ? { conversation_id: t.conversation_id } : {}),
          ...(t.in_reply_to_id ? { in_reply_to_id: t.in_reply_to_id } : {}),
        },
        postedAt,
        priority,
      });
      if (res.inserted) {
        inserted++;
        await bus?.emit({
          topic: "lead.discovered",
          worker: "discovery",
          summary: `discovered @${t.author.handle}`,
          payload: {
            lead_id: res.id,
            external_id: t.id,
            handle: t.author.handle,
            followers: t.author.followers ?? null,
            priority,
          },
          correlationId: res.id,
        });
      }
    } catch (err) {
      log.error({ tweetId: t.id, err: (err as Error).message }, "lead upsert failed");
    }
  }
  log.info(
    {
      inserted,
      scanned: all.length,
      duplicates: batches.reduce((count, batch) => count + batch.length, 0) - all.length,
      skippedBackfill,
      skippedRepost,
      skippedReply,
      skippedLowFaves,
      windowHours: config.timeWindowHours,
      limit,
      minFaves: config.minFaves,
      minReplies: config.minReplies,
    },
    "discovery tick complete",
  );
  // The pool died mid-ring. Everything fetched before that point is now saved,
  // so surfacing the failure costs nothing — and it is what makes the worker's
  // handler mark the run errored and page the operator.
  if (exhausted) throw exhausted;
  return inserted;
}
