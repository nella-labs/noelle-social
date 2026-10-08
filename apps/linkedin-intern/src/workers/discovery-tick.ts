import type { Bus } from "@noelle/runtime";
import type { Logger } from "../lib/logger.js";
import type { ActiveInstance } from "../lib/activation.js";
import type { WatchlistPerson } from "../lib/watchlist-db.js";
import type { ApifyLinkedInClient, LinkedInPost, CandidateProfile } from "@noelle/linkedin-apify";
import type { SpendRecorder } from "@noelle/runtime";
import { withMeteredApifyCall } from "@noelle/runtime/apify-metering";
import { windowSinceISO, laterISO, type LinkedinDiscoveryFilters } from "../lib/discovery-config.js";
import { AllApifyTokensExhaustedError } from "../lib/apify-rotating.js";
import { qualifyByHeadline } from "../lib/icp-gate.js";
import { readSourceTimestamp } from "@noelle/runtime/source-values";
import {
  type IcpConfig,
  ICP_DEFAULT_MIN_REACTIONS,
  ICP_DEFAULT_TIME_WINDOW_HOURS,
  ICP_DEFAULT_MAX_PROFILES,
} from "@noelle/contracts";

export interface RunDiscoveryTickArgs {
  log: Logger;
  instance: ActiveInstance;
  /** People whose posts the intern extracts for grading — the targeting model. */
  watchlistPeople: WatchlistPerson[];
  /**
   * Apify-backed posts source (no LinkedIn cookies). `profilePosts` drives the
   * watch lane; `searchPosts` (optional) drives the keyword lane — absent in
   * tests that only exercise the watch lane.
   */
  postsSource: Pick<ApifyLinkedInClient, "profilePosts" | "drainLastRunUsd" | "drainRunReceipts" | "isolateOperation"> &
    Partial<Pick<ApifyLinkedInClient, "searchPosts" | "searchProfiles">>;
  /**
   * Profile-first ICP (0043). When set, it (a) gates the keyword SEARCH lane on
   * the post AUTHOR's headline — only the right kind of person becomes a lead,
   * marked priority=true — and (b) enables Feeder A: profile-search for ICP
   * people, then their recent engaged posts as priority leads. Absent = the
   * lanes run exactly as before (no author gate, priority=false).
   */
  icp?: IcpConfig | null;
  /**
   * SEARCH-lane keywords (noelle.linkedin_watchlist). For each, discovery searches
   * LinkedIn-wide for high-engagement posts from people OUTSIDE the watchlist that
   * match the objective. Empty (or watchlist-only mode) = the search lane is
   * skipped this tick; the watched-connections lane is unaffected either way.
   */
  keywords?: string[];
  /** Keyword-lane tuning. Absent = no search lane runs (keywords ignored). */
  keywordConfig?: {
    /** maxPosts per keyword search (Apify bills per result). */
    searchLimit: number;
    /** Reaction floor — drop search posts below this (the lane's whole purpose). */
    minReactions: number;
    /** Coarse recency hint for the actor ("day" | "week" | "month"). */
    postedLimit: string;
    /** Keep company-authored posts (default false: the objective targets people). */
    includeCompanies?: boolean;
  };
  /** Records the Apify spend of each profilePosts run (engine='apify'). Omit to skip. */
  recorder?: SpendRecorder;
  /** noelle.connections id of the token used, stamped on spend rows for per-token attribution. */
  credentialId?: string | null;
  /** Posts to fetch per person this tick. Small + gentle (Apify bills per post). */
  discoveryLimit: number;
  /**
   * The tailored-run filters (resolved run_config over the saved default). The
   * time window narrows the Apify fetch + drops older posts; the reaction/comment
   * floors drop low-engagement posts before they become leads. Absent = no
   * tailoring (only postsPerSource, carried by discoveryLimit, applies).
   */
  filters?: Pick<LinkedinDiscoveryFilters, "timeWindowHours" | "minReactions" | "minComments">;
  /**
   * Daily extract cap (LINKEDIN_DAILY_EXTRACT_CAP). Once the instance has already
   * extracted this many posts today, discovery stops inserting. The caller passes
   * how many were ALREADY extracted today (`alreadyExtractedToday`); this tick
   * adds to it and stops the moment the running total reaches the cap, so a single
   * day never balloons the classifier backlog.
   */
  dailyExtractCap: number;
  /** Posts already extracted today for this instance (from countExtractedToday). */
  alreadyExtractedToday: number;
  /**
   * WATCH-lane per-person re-poll cooldown (LINKEDIN_WATCHLIST_REPOLL_HOURS).
   * The daily extract cap only counts new LEADS, so without this every watched
   * person was re-fetched every tick (~96×/day) — mostly zero-result runs that
   * still burn Apify credit. A person not `due()` is skipped; every attempted
   * fetch is `stamp()`ed (success or failure). Omit = old every-tick behaviour.
   */
  repollGate?: import("@noelle/runtime/repoll-cooldown").RepollGate;
  upsertLead: (args: {
    orgId: string;
    agentInstanceId: string;
    platform: "linkedin";
    externalId: string;
    authorHandle: string;
    authorId: string | null;
    payload: Record<string, unknown>;
    postedAt: string | null;
    priority?: boolean;
  }) => Promise<{ id: string; inserted: boolean }>;
  /** Shared-memory bus (optional). Emits a `lead.discovered` event per new lead. */
  bus?: Bus;
  /**
   * Persist a qualified discovered person (noelle.linkedin_discovered_people).
   * Called for every candidate that passes the ICP gate in either feeder, so the
   * extracted profile is retained even when it yields no lead. Best-effort — the
   * tick swallows its errors. Omit to skip persistence.
   */
  recordDiscoveredPerson?: (p: {
    publicId: string;
    fsdProfileId: string | null;
    name: string | null;
    headline: string | null;
    source: "profile_search" | "post_search";
  }) => Promise<void>;
}

/**
 * One discovery tick across BOTH lanes, each upserting NEW, UNCLASSIFIED LinkedIn
 * leads (status='new', priority=false) that the classifier then scores:
 *   1. WATCH lane — for each watchlist person, fetch their recent posts via Apify
 *      profilePosts. Posts before a person's added_at are owned by the profiler
 *      (deep history), so we fetch only posts on/after added_at (sinceISO) and
 *      never backfill.
 *   2. SEARCH lane — for each keyword (when keywordConfig + keywords are passed),
 *      search LinkedIn-wide via Apify post-search for high-engagement posts from
 *      people OUTSIDE the network, filtered client-side (engagement floor, window,
 *      skip companies). The caller omits keywords to run watch-only (paused tick).
 *
 * Enforces the DAILY EXTRACT CAP: we count newly-inserted leads on top of
 * `alreadyExtractedToday` and stop the moment the running total reaches
 * `dailyExtractCap`, iterating people until then.
 *
 * Apify takes a profile URL / public slug, so each person needs a public_id
 * (people without one are skipped + logged — there is no fsd-id lookup path).
 */
export async function runDiscoveryTick(args: RunDiscoveryTickArgs): Promise<number> {
  const {
    log,
    instance,
    watchlistPeople,
    postsSource,
    discoveryLimit,
    dailyExtractCap,
    alreadyExtractedToday,
    repollGate,
    upsertLead,
    recorder,
    credentialId,
    bus,
    filters,
    keywordConfig,
    keywords = [],
    icp,
    recordDiscoveredPerson,
  } = args;
  const metered = <T>(actor: string, call: (operation: typeof postsSource) => Promise<T>) =>
    withMeteredApifyCall({ client: postsSource, recorder, log, orgId: instance.org_id,
      instanceId: instance.id, agentRole: "linkedin_intern", worker: "discovery", actor,
      startedAt: new Date(), credentialId: credentialId ?? null }, call);
  let inserted = 0;
  let scanned = 0;
  let filtered = 0;
  // Watch-lane people skipped this tick by the re-poll cooldown (logged once).
  let cooledDown = 0;
  // Running total of posts extracted today, including this tick's inserts.
  let extractedToday = alreadyExtractedToday;
  // Post ids already processed this tick — dedupes a post that both a watched
  // person made AND a keyword search surfaced, so it never becomes two leads.
  const seen = new Set<string>();

  // Tailored-run window: posts older than (now − timeWindowHours) are skipped.
  // Computed once per tick so every person uses the same lower bound.
  const tickNow = new Date();
  const windowSince = windowSinceISO(tickNow, filters?.timeWindowHours ?? null);
  const minReactions = filters?.minReactions ?? null;
  const minComments = filters?.minComments ?? null;

  // Already at/over the cap before we start — don't fetch anything.
  if (extractedToday >= dailyExtractCap) {
    log.info(
      { extractedToday, dailyExtractCap },
      "daily extract cap already reached; skipping discovery tick",
    );
    return 0;
  }

  for (const person of watchlistPeople) {
    if (extractedToday >= dailyExtractCap) {
      log.info(
        { extractedToday, dailyExtractCap },
        "daily extract cap reached; stopping discovery tick early",
      );
      break;
    }

    if (!person.publicId) {
      log.warn(
        { fsdProfileId: person.fsdProfileId },
        "watchlist person has no public_id; cannot query Apify — skipping",
      );
      continue;
