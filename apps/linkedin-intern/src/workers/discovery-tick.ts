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
    }

    // Re-poll cooldown: skip a person attempted within the window. Stamp BEFORE
    // the fetch so a throwing profile also cools down instead of being
    // re-hammered every tick.
    if (repollGate) {
      if (!repollGate.due(person.publicId)) {
        cooledDown++;
        continue;
      }
      repollGate.stamp(person.publicId);
    }

    let posts: LinkedInPost[] = [];
    try {
      posts = await metered("linkedin-profile-posts", operation => operation.profilePosts({
        publicId: person.publicId!,
        maxPosts: discoveryLimit,
        // Only ingest posts from the day the person was added forward; their
        // older history belongs to the profiler, not the comment pipeline. When a
        // tailored-run time window is set, narrow further to the later of the two
        // bounds so Apify doesn't return posts the window would just drop.
        sinceISO: laterISO(person.addedAt, windowSince),
      }));
    } catch (err) {
      // Every token spent → the rest of the watchlist will 403 identically.
      // Propagate so the worker records the error + pings the operator instead
      // of silently completing with inserted:0 (which reads as "idle").
      if (err instanceof AllApifyTokensExhaustedError) throw err;
      log.error(
        { publicId: person.publicId, err: (err as Error).message },
        "apify profilePosts failed for watchlist person",
      );
      continue;
    }
    scanned += posts.length;

    for (const post of posts) {
      const postedAt = readSourceTimestamp(post.postedAt);
      if (extractedToday >= dailyExtractCap) {
        log.info(
          { extractedToday, dailyExtractCap },
          "daily extract cap reached mid-person; stopping",
        );
        break;
      }
      // Tailored-run filters: drop posts that don't clear the engagement floors
      // or fall outside the time window BEFORE they become leads. Missing
      // engagement counts as 0, so a floor > 0 also drops posts Apify returned
      // without counts. The window is a client-side backstop to the narrowed
      // sinceISO above.
      if (
        (minReactions != null && minReactions > 0 && (post.reactions ?? 0) < minReactions) ||
        (minComments != null && minComments > 0 && (post.comments ?? 0) < minComments) ||
        (windowSince != null && postedAt != null && postedAt < windowSince)
      ) {
        filtered++;
        continue;
      }
      seen.add(post.id);
      try {
        const res = await upsertLead({
          orgId: instance.org_id,
          agentInstanceId: instance.id,
          platform: "linkedin",
          externalId: post.id,
          authorHandle: person.publicId,
          authorId: person.fsdProfileId,
          payload: {
            text: post.text,
            url: post.url,
            postedAt,
            authorName: person.name ?? post.author.name,
            authorHeadline: person.headline ?? post.author.headline,
            authorPublicId: person.publicId,
            reactions: post.reactions,
            comments: post.comments,
            // Post media image URLs for a downstream vision-caption step. Only
            // present on posts that actually have media (omitted otherwise).
            ...(post.images && post.images.length > 0 ? { images: post.images } : {}),
          },
          postedAt,
          // WATCH lane = hand-picked connections. Mark them priority so the
          // classifier never HARD-skips one of the operator's own people: a
          // 'skip' verdict is clamped to 'light' (a short supportive reply). The
          // person is the gate, not the post — the operator chose to watch them,
          // so every post they make earns at least a peer note (wins/launches
          // especially). The keyword/search lane keeps the full skip filter.
          priority: true,
        });
        // Only a genuinely NEW lead counts toward the daily extract cap; a
        // re-seen post (inserted=false) is a no-op and shouldn't burn budget.
        if (res.inserted) {
          inserted++;
          extractedToday++;
          await bus?.emit({
            topic: "lead.discovered",
            worker: "discovery",
            summary: `discovered ${person.publicId}`,
            payload: {
              lead_id: res.id,
              external_id: post.id,
              handle: person.publicId,
              reactions: post.reactions ?? null,
            },
            correlationId: res.id,
          });
        }
      } catch (err) {
        log.error({ activityId: post.id, err: (err as Error).message }, "lead upsert failed");
      }
    }
  }

  if (cooledDown > 0) {
    log.info(
      { cooledDown, watchlistPeople: watchlistPeople.length },
      "watch lane: people skipped by re-poll cooldown (fetched again once their window elapses)",
    );
  }

  // ── Keyword (SEARCH) lane ──────────────────────────────────────────────────
  // Search LinkedIn-wide for high-engagement posts matching the operator's
  // keywords, from people OUTSIDE the watchlist. Unlike X's native search, the
  // Apify post-search actor can't sort by engagement, filter language, or exclude
  // authors — so we over-fetch by recency and filter client-side: skip company
  // pages, drop posts below the reaction floor, drop posts outside the window.
  // Skipped entirely when the caller passes no keywords/keywordConfig (paused or
  // watchlist-only). Search posts carry their OWN author (a stranger), so the
  // lead's author_handle is the post author's public id and author_id is null.
  const searchPosts = postsSource.searchPosts;
  if (keywordConfig && keywords.length > 0 && searchPosts) {
    const keywordMin = keywordConfig.minReactions;
    for (const keyword of keywords) {
      if (extractedToday >= dailyExtractCap) {
        log.info({ extractedToday, dailyExtractCap }, "daily extract cap reached; stopping keyword lane");
        break;
      }
      let posts: LinkedInPost[] = [];
      try {
        posts = await metered("linkedin-post-search", operation => operation.searchPosts!({
          queries: [keyword],
          maxPosts: keywordConfig.searchLimit,
          postedLimit: keywordConfig.postedLimit,
          sinceISO: windowSince ?? undefined,
        }));
      } catch (err) {
        if (err instanceof AllApifyTokensExhaustedError) throw err;
        log.error({ keyword, err: (err as Error).message }, "apify searchPosts failed for keyword");
        continue;
      }
      scanned += posts.length;

      for (const post of posts) {
        const postedAt = readSourceTimestamp(post.postedAt);
        if (extractedToday >= dailyExtractCap) break;
        if (seen.has(post.id)) continue;
        seen.add(post.id);
        // Company pages post promo, not the peer-builder content the objective
        // targets ("SKIP: corporate boilerplate ... pure promo"). Skip by default.
        if (!keywordConfig.includeCompanies && post.author.type === "company") {
          filtered++;
          continue;
        }
        // High-engagement floor + time window — the whole point of the search lane.
        // Missing counts read as 0, so any floor > 0 also drops countless posts.
        if (
          (keywordMin > 0 && (post.reactions ?? 0) < keywordMin) ||
          (windowSince != null && postedAt != null && postedAt < windowSince)
        ) {
          filtered++;
          continue;
        }
        // A reply needs a target author; the search actor occasionally returns a
        // post with no resolvable public id (no publicIdentifier / universalName).
        const handle = post.author.publicId;
        if (!handle) {
          log.warn({ activityId: post.id }, "search post has no author public id; skipping");
          continue;
        }
        // Profile-first AUTHOR gate: when an ICP is set, only keep the post if
        // its author is the right kind of person (headline match). This is the
        // "correct people, not the post" filter — a keyword can surface anyone,
        // so we vet the author before drafting. Qualified authors' leads are
        // priority=true (the classifier won't hard-skip them).
        if (icp) {
          const q = qualifyByHeadline(post.author.headline, icp);
          if (!q.qualified) {
            filtered++;
            continue;
          }
          // Retain the qualified person (best-effort) so the profile is stored,
          // not just used to mint this lead.
          if (recordDiscoveredPerson) {
            await recordDiscoveredPerson({
              publicId: handle,
              fsdProfileId: null,
              name: post.author.name,
              headline: post.author.headline,
              source: "post_search",
            }).catch(() => {});
          }
        }
        try {
          const res = await upsertLead({
            orgId: instance.org_id,
            agentInstanceId: instance.id,
            platform: "linkedin",
            externalId: post.id,
            authorHandle: handle,
            // No fsd_profile_id for a stranger from search (only watched people
            // have one). The profiler/drafter fall back to the public id.
            authorId: null,
            payload: {
              text: post.text,
              url: post.url,
              postedAt,
              authorName: post.author.name,
              authorHeadline: post.author.headline,
              authorPublicId: handle,
              reactions: post.reactions,
              comments: post.comments,
              // Post media image URLs for the downstream vision-caption step.
              // Mirrors the watch lane — only present when the post has media so
              // the drafter can react to charts/screenshots/memes, not just text.
              ...(post.images && post.images.length > 0 ? { images: post.images } : {}),
              // Lane + matched keyword, for observability + downstream debugging.
              source: "keyword",
              keyword,
            },
            postedAt,
            // A vetted author (ICP gate passed) is a priority lead — never hard-skipped.
            priority: Boolean(icp),
          });
          if (res.inserted) {
            inserted++;
            extractedToday++;
            await bus?.emit({
              topic: "lead.discovered",
              worker: "discovery",
              summary: `discovered ${handle} (kw: ${keyword})`,
              payload: {
                lead_id: res.id,
                external_id: post.id,
                handle,
                reactions: post.reactions ?? null,
                source: "keyword",
                keyword,
              },
              correlationId: res.id,
            });
          }
        } catch (err) {
          log.error({ activityId: post.id, err: (err as Error).message }, "keyword lead upsert failed");
        }
      }
    }
  }

  // ── Profile-first (PROFILE-SEARCH) lane — Feeder A ─────────────────────────
  // The unit is the PERSON: find people matching the ICP via the profile-search
  // actor, keep only those whose headline qualifies, then turn each one's recent
  // (≤ icp.timeWindowHours) and engaged (≥ icp.minReactions) posts into PRIORITY
  // leads. Skipped entirely when no ICP is set or the client can't searchProfiles.
  let profilesFound = 0;
  let profilesQualified = 0;
  const searchProfiles = postsSource.searchProfiles;
  if (icp && searchProfiles && extractedToday < dailyExtractCap) {
    const icpMinReactions = icp.minReactions ?? ICP_DEFAULT_MIN_REACTIONS;
    const icpWindowSince = windowSinceISO(
      tickNow,
      icp.timeWindowHours ?? ICP_DEFAULT_TIME_WINDOW_HOURS,
    );
    let profiles: CandidateProfile[] = [];
    try {
      profiles = await metered("linkedin-profile-search", operation => operation.searchProfiles!({
        ...(icp.searchQuery ? { searchQuery: icp.searchQuery } : {}),
        ...(icp.currentJobTitles ? { currentJobTitles: icp.currentJobTitles } : {}),
        ...(icp.locations ? { locations: icp.locations } : {}),
        ...(icp.seniorityLevelIds ? { seniorityLevelIds: icp.seniorityLevelIds } : {}),
        ...(icp.yearsOfExperienceIds ? { yearsOfExperienceIds: icp.yearsOfExperienceIds } : {}),
        ...(icp.industryIds ? { industryIds: icp.industryIds } : {}),
        ...(icp.schools ? { schools: icp.schools } : {}),
        maxItems: icp.maxProfiles ?? ICP_DEFAULT_MAX_PROFILES,
      }));
    } catch (err) {
      // A dry token pool propagates (the worker surfaces it); any other
      // profile-search failure is non-fatal — the watch + keyword lanes already
      // ran, so we just skip Feeder A this tick.
      if (err instanceof AllApifyTokensExhaustedError) throw err;
      log.error({ err: (err as Error).message }, "apify searchProfiles failed");
      profiles = [];
    }
    profilesFound = profiles.length;

    for (const prof of profiles) {
      if (extractedToday >= dailyExtractCap) break;
      if (!prof.publicId) continue;
      // The PERSON gate: only harvest people whose headline matches the ICP.
      if (!qualifyByHeadline(prof.headline, icp).qualified) {
        filtered++;
        continue;
      }
      profilesQualified++;
      // Retain every qualified person, even if they yield no lead this tick.
      if (recordDiscoveredPerson) {
        await recordDiscoveredPerson({
          publicId: prof.publicId,
          fsdProfileId: prof.fsdProfileId,
          name: prof.name,
          headline: prof.headline,
          source: "profile_search",
        }).catch(() => {});
      }

      let posts: LinkedInPost[] = [];
      try {
        posts = await metered("linkedin-profile-posts", operation => operation.profilePosts({
          publicId: prof.publicId!,
          maxPosts: discoveryLimit,
          sinceISO: icpWindowSince ?? undefined,
        }));
      } catch (err) {
        if (err instanceof AllApifyTokensExhaustedError) throw err;
        log.error(
          { publicId: prof.publicId, err: (err as Error).message },
          "apify profilePosts failed for icp profile",
        );
        continue;
      }
      scanned += posts.length;

      for (const post of posts) {
        const postedAt = readSourceTimestamp(post.postedAt);
        if (extractedToday >= dailyExtractCap) break;
        if (seen.has(post.id)) continue;
        seen.add(post.id);
        // Engagement + recency gate — the whole point of profile-first leads.
        if (
          (icpMinReactions > 0 && (post.reactions ?? 0) < icpMinReactions) ||
          (icpWindowSince != null && postedAt != null && postedAt < icpWindowSince)
        ) {
          filtered++;
          continue;
        }
        try {
          const res = await upsertLead({
            orgId: instance.org_id,
            agentInstanceId: instance.id,
            platform: "linkedin",
            externalId: post.id,
            authorHandle: prof.publicId,
            // fsd_profile_id when the actor returned it (often absent in short
            // mode); the drafter/profiler fall back to the public id.
            authorId: prof.fsdProfileId,
            payload: {
              text: post.text,
              url: post.url,
              postedAt,
              authorName: prof.name ?? post.author.name,
              authorHeadline: prof.headline ?? post.author.headline,
              authorPublicId: prof.publicId,
              reactions: post.reactions,
              comments: post.comments,
              ...(post.images && post.images.length > 0 ? { images: post.images } : {}),
              source: "profile_search",
            },
            postedAt,
            // A profile-first lead is always from a vetted person → priority.
            priority: true,
          });
          if (res.inserted) {
            inserted++;
            extractedToday++;
            await bus?.emit({
              topic: "lead.discovered",
              worker: "discovery",
              summary: `discovered ${prof.publicId} (icp)`,
              payload: {
                lead_id: res.id,
                external_id: post.id,
                handle: prof.publicId,
                reactions: post.reactions ?? null,
                source: "profile_search",
              },
              correlationId: res.id,
            });
          }
        } catch (err) {
          log.error({ activityId: post.id, err: (err as Error).message }, "icp lead upsert failed");
        }
      }
    }
  }

  log.info(
    {
      inserted,
      scanned,
      filtered,
      extractedToday,
      dailyExtractCap,
      people: watchlistPeople.length,
      keywords: keywordConfig ? keywords.length : 0,
      icp: Boolean(icp),
      profilesFound,
      profilesQualified,
    },
    "discovery tick complete",
  );
  return inserted;
}
