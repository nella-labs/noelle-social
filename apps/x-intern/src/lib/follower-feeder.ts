import type { Sql } from "postgres";
import { qualifyByProfileText, type IcpHeadlineGate } from "@noelle/runtime";
import type { XCandidatePerson, ApifyResultCoverage } from "@noelle/x-apify";

// FOLLOWER FEEDER — person DISCOVERY for Vega.
//
// Lyra finds people with a LinkedIn profile-search actor. X has no keyword→user
// search actor we can trust on a free Apify plan (the one that fits best is from
// the publisher this repo migrated off for silently serving demo data to
// free-plan tokens), so Vega discovers people a different way: it harvests the
// FOLLOWERS of seed accounts and keeps the ones whose bio matches the ICP.
//
// That is arguably the better signal. A keyword match on a bio finds people who
// describe themselves a certain way; the follower list of an account the ICP
// already reads finds the audience itself.
//
// This module is deliberately pure-ish — the Apify call, the DB writes and the
// clock are all injected — because the thing most worth testing is the SPEND
// GUARD, and that must be testable without spending anything.

/** Where seed accounts come from, in priority order. */
export interface SeedSource {
  /** Explicit seeds from icp_config.seedHandles, when the operator set them. */
  configured: string[];
  /**
   * Fallback: the operator's watchlist PEOPLE — accounts they already chose to
   * follow, so their audiences are the closest thing to a known-good ICP pool.
   * Note this is x_watchlist_people, NOT the targeting-handle list, which is
   * empty on the live instance and would leave the feeder seedless.
   */
  watchlist: string[];
}

/**
 * Pick which seeds this run harvests.
 *
 * Configured seeds win outright: an operator who named accounts meant those.
 * Otherwise fall back to the watchlist, which is the best available proxy for
 * "an account whose audience looks like our ICP" — the operator already decided
 * these people are worth listening to.
 *
 * Rotates by `cursor` so a multi-seed list is covered over successive runs
 * instead of re-harvesting seed 0 forever, and returns at most `perRun` because
 * every seed costs a paid actor run.
 */
export function pickSeeds(
  source: SeedSource,
  perRun: number,
  cursor: number,
): string[] {
  const pool = (source.configured.length > 0 ? source.configured : source.watchlist)
    .map((h) => h.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
  const unique = Array.from(new Set(pool));
  if (unique.length === 0 || perRun <= 0) return [];
  const take = Math.min(perRun, unique.length);
  const start = ((cursor % unique.length) + unique.length) % unique.length;
  return Array.from({ length: take }, (_, i) => unique[(start + i) % unique.length]!);
}

/** Read seedHandles off icp_config, tolerating any shape. */
export function readSeedHandles(cfg: unknown): string[] {
  if (!cfg || typeof cfg !== "object") return [];
  const raw = (cfg as { seedHandles?: unknown }).seedHandles;
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
}

export interface FollowerFeederArgs {
  sql: Sql;
  orgId: string;
  agentInstanceId: string;
  /** The ICP gate. Required: with no "right person" test this would retain everyone. */
  icpGate: IcpHeadlineGate;
  seeds: string[];
  maxUsers: number;
  /** Injected Apify call — throws on a dead pool, which the caller surfaces. */
  scrapeFollowers: (args: {
    seedHandles: string[];
    maxUsers: number;
  }) => Promise<{ people: XCandidatePerson[] } & ApifyResultCoverage>;
  /** Retain one qualified person. Best-effort; errors are swallowed per person. */
  recordPerson: (p: XCandidatePerson) => Promise<void>;
  log: { info: (o: Record<string, unknown>, m: string) => void };
}

export interface FollowerFeederResult {
  seeds: string[];
  /** How many people the actor returned (what we PAID for). */
  scanned: number;
  resultCountComplete?: boolean;
  fetchedResultCount?: number;
  /** How many cleared the ICP bio gate and were retained. */
  qualified: number;
  /** Returned with no bio at all — invisible to the gate, so never retained. */
  noBio: number;
}

/**
 * Harvest one batch of seeds and retain the qualified people.
 *
 * The bio gate here fails CLOSED (`reject` on a missing bio), unlike the
 * classifier's ICP gate which fails open. Opposite trades: the classifier
 * dropping a lane because the actor stopped sending bios would be catastrophic,
 * whereas retaining unvetted handles here just fills a prospect list with
 * strangers we will then pay to poll. `noBio` is reported so an actor that
 * quietly stops returning descriptions is visible in the logs rather than
 * silently yielding zero qualified people.
 */
export async function runFollowerFeeder(
  args: FollowerFeederArgs,
): Promise<FollowerFeederResult> {
  const empty: FollowerFeederResult = { seeds: [], scanned: 0, qualified: 0, noBio: 0 };
  if (args.seeds.length === 0 || args.maxUsers <= 0) return empty;

  const { people, resultCount, ...coverage } = await args.scrapeFollowers({
    seedHandles: args.seeds,
    maxUsers: args.maxUsers,
  });

  let qualified = 0;
  let noBio = 0;
  for (const p of people) {
    if (!p.bio) {
      noBio++;
      continue;
    }
    if (!qualifyByProfileText(p.bio, args.icpGate, "reject").qualified) continue;
    qualified++;
    await args.recordPerson(p).catch(() => {});
  }

  args.log.info(
    { seeds: args.seeds, scanned: resultCount, returned: people.length, qualified, noBio },
    "follower feeder: harvested seed audience",
  );
  return { seeds: args.seeds, scanned: resultCount, qualified, noBio, ...coverage };
}

/**
 * Throttle: has this instance's feeder run inside the window?
 *
 * Persisted on the shared memory bus rather than in process memory, because the
 * worker restarts on every deploy tick and an in-memory stamp would let a
 * restart re-trigger a PAID run immediately. Fail-safe direction: if the stamp
 * cannot be read we treat the feeder as recently-run and SKIP, so a bus outage
 * costs nothing instead of spending on every tick.
 */
export function isFeederDue(lastRunIso: string | null | undefined, intervalHours: number, now: Date): boolean {
  if (!lastRunIso) return true; // never run
  const last = new Date(lastRunIso).getTime();
  if (!Number.isFinite(last)) return false; // unparseable ⇒ assume recent, skip
  return now.getTime() - last >= intervalHours * 3_600_000;
}
