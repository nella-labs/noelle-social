// The "right person" gate for profile-first discovery.
//
// The operator's lead model is person-first: a candidate qualifies on WHO they
// are (their LinkedIn headline, or their X bio), not on the content of any
// single post. Shared via @noelle/runtime so both interns gate on one
// implementation; the only difference is which profile field is passed in and
// what happens when it is MISSING (see qualifyByProfileText). This is
// a cheap, deterministic substring match — headlineKeywords qualify, any
// headlineExcludeKeywords disqualify — so it's free, testable, and never burns
// an LLM call on the hot discovery path. (An LLM fallback for ambiguous/empty
// headlines is a deliberate follow-up, not v1.)

export interface IcpHeadlineGate {
  /** Headline must contain ANY of these (case-insensitive substring). */
  headlineKeywords: string[];
  /** Headline containing ANY of these is rejected (takes precedence). */
  headlineExcludeKeywords?: string[];
}

export interface IcpGateResult {
  qualified: boolean;
  /** Short machine-readable reason: matched:<kw> | excluded:<kw> | no-headline | no-keyword-match. */
  reason: string;
}

/**
 * Decide whether a candidate person matches the ICP by their headline.
 *
 * Order: a missing/blank headline never qualifies (we can't vet an unknown
 * person — conservative, the opposite of the post classifier's fail-open); an
 * exclude-keyword hit rejects even if an include keyword also matches; otherwise
 * the first include-keyword hit qualifies. Matching is case-insensitive
 * substring on a normalised lowercased headline.
 */
export function qualifyByHeadline(
  headline: string | null | undefined,
  gate: IcpHeadlineGate,
): IcpGateResult {
  const h = (headline ?? "").toLowerCase().trim();
  if (!h) return { qualified: false, reason: "no-headline" };

  for (const raw of gate.headlineExcludeKeywords ?? []) {
    const kw = raw.toLowerCase().trim();
    if (kw && h.includes(kw)) return { qualified: false, reason: `excluded:${kw}` };
  }
  for (const raw of gate.headlineKeywords) {
    const kw = raw.toLowerCase().trim();
    if (kw && h.includes(kw)) return { qualified: true, reason: `matched:${kw}` };
  }
  return { qualified: false, reason: "no-keyword-match" };
}

/**
 * Platform-neutral wrapper over qualifyByHeadline.
 *
 * `onMissing` is the load-bearing difference between the two platforms:
 *
 *  - LinkedIn ('reject', the default): a Voyager profile ALWAYS carries a
 *    headline, so a blank one means we genuinely could not vet the person and
 *    the conservative call is to skip them.
 *  - X ('accept'): the scraper actor does not reliably return an author bio at
 *    all, so a missing bio usually means "the actor did not send it", not "this
 *    person has no bio". Failing closed there would silently drop the entire
 *    keyword lane the first time the actor changed its payload shape. So an
 *    unknown bio passes the gate and the downstream classifier (which grades
 *    content, follower count and AI-slop) remains the real filter.
 */
export function qualifyByProfileText(
  text: string | null | undefined,
  gate: IcpHeadlineGate,
  onMissing: "reject" | "accept" = "reject",
): IcpGateResult {
  const blank = !(text ?? "").trim();
  if (blank && onMissing === "accept") {
    return { qualified: true, reason: "no-profile-text-fail-open" };
  }
  return qualifyByHeadline(text, gate);
}

/** True when a gate is configured with at least one usable include keyword. */
export function icpGateConfigured(gate: IcpHeadlineGate | null | undefined): boolean {
  return Boolean(gate?.headlineKeywords?.some((k) => k.trim().length > 0));
}
