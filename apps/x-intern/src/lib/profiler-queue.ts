import type { ProfilePerson } from "./profiles-db.js";

/**
 * The profiler's work queue: the watchlist FIRST, then anyone we've replied to
 * more than PROFILER_MIN_REPLIES times, capped at `batch`.
 *
 * Watchlist people lead because they are the deliberate list — starving them
 * behind a long reply tail would be a regression. Deduped on the lowercased
 * handle: X handles are case-preserving but case-insensitive, so the same person
 * reaches the two lanes as "ElonMusk" and "elonmusk" and would otherwise cost two
 * Apify fetches and two LLM calls for one profile row.
 */
export function mergeProfilerQueue(args: {
  watchlist: ProfilePerson[];
  replied: ProfilePerson[];
  batch: number;
}): ProfilePerson[] {
  if (args.batch <= 0) return [];
  const out: ProfilePerson[] = [];
  const seen = new Set<string>();
  for (const p of [...args.watchlist, ...args.replied]) {
    if (out.length >= args.batch) break;
    const key = p.handle.trim().toLowerCase().replace(/^@/, "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}
