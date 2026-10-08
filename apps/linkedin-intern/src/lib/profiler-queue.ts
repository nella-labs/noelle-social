import { resolveVanitySlug } from "@noelle/linkedin-apify";
import type { ProfilePerson, RepliedProfileCandidate } from "./watchlist-db.js";

/**
 * The profiler's work queue: the hand-curated watchlist FIRST, then anyone we've
 * actually replied to more than PROFILER_MIN_REPLIES times, capped at `batch`.
 *
 * Watchlist people lead because they are the deliberate list — a person the operator
 * added is a stated intent, and starving them behind a long reply tail would be
 * a regression. The reply lane then fills whatever budget is left over, which on
 * a normal tick is the whole batch (the watchlist is usually fully fresh).
 *
 * Dedupes on BOTH the fsd key and the resolved slug: the same human reaches the
 * two lanes under different ids (watchlist rows are keyed by member urn, leads by
 * whatever the discovery lane captured), and profiling them twice in one tick
 * would burn two Apify fetches and two LLM calls for one profile row.
 */
export function buildProfilerQueue(args: {
  watchlist: ProfilePerson[];
  replied: RepliedProfileCandidate[];
  batch: number;
}): ProfilePerson[] {
  if (args.batch <= 0) return [];
  const out: ProfilePerson[] = [];
  const seen = new Set<string>();

  const key = (s: string | null | undefined): string | null => {
    const t = s?.trim().toLowerCase();
    return t ? t : null;
  };
  const push = (p: ProfilePerson): void => {
    if (out.length >= args.batch) return;
    const keys = [key(p.fsdProfileId), key(p.publicId)].filter((k): k is string => k !== null);
    if (keys.some((k) => seen.has(k))) return;
    for (const k of keys) seen.add(k);
    out.push(p);
  };

  for (const p of args.watchlist) push(p);
  for (const c of args.replied) {
    // A urn in `publicId` is unusable as linkedin.com/in/<slug>; mine the real
    // slug out of the person's own post permalink before queuing them.
    push({
      fsdProfileId: c.fsdProfileId,
      publicId: resolveVanitySlug({ publicId: c.publicId, postUrl: c.postUrl }),
      name: c.name,
      headline: c.headline,
    });
  }
  return out;
}
