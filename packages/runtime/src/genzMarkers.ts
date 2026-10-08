// The gen-z MARKER lane — a measured amount of current spoken register in the
// reply drafters (Vega on X, Lyra on LinkedIn, Orion on Reddit).
//
// WHY IT IS A LANE AND NOT A PROMPT RULE: "write more like a 24-year-old" in a
// system prompt produces slang cosplay on EVERY reply, which reads as more
// artificial than no slang at all. The operator's exact framing was "don't
// overdo it, it looks more ai that way". Three properties make that concrete:
//
//   1. RATE-GATED. Only DEFAULT_MARKER_RATE of replies get a marker block at
//      all. The rest are drafted with no marker instruction, exactly as before.
//   2. EXACTLY ONE, AND OPTIONAL. A reply that gets the block gets ONE marker
//      and explicit permission to drop it when it does not fit. Two markers in
//      one reply is the tell; a forced marker is the other tell.
//   3. TIERED BY ENERGY. `plain` markers (ngl, tbh, idk, kinda, lowkey) are
//      ordinary spoken English and are safe under any post. `loud` markers
//      (cooked, peak, unserious, deadass, the "not me …" and "the way …"
//      constructions) are performative, and performing under someone's vent or
//      someone's genuine question is exactly the misfire the energy system
//      exists to prevent — so they are only reachable on a joke, a hot take, a
//      celebration, or an ordinary analytical post.
//
// WHAT IS DELIBERATELY ABSENT: the cringe tier — "no cap", "rizz", "it's
// giving", "fr fr", "based", "slay", "bussin", "ate". Those stay HARD BANNED in
// the drafter prompts (SLANG COSPLAY). They are the ones that read as an adult
// imitating a teenager, which is worse than corporate.
//
// Pure + unit-testable: every picker takes an injectable rng.

import type { PostEnergy } from "./register.js";

/** How performative a marker is, which decides where it may land. */
export type MarkerTier = "plain" | "loud";
export type PublicReplyPlatform = "x" | "linkedin" | "reddit";

export interface GenZMarker {
  id: string;
  tier: MarkerTier;
  /** Weight in (0,1]; renormalized at pick time over whatever pool remains. */
  weight: number;
  /** The marker as the prompt names it, plus how it is actually used. */
  directive: string;
  /** Omit for universal markers; list platforms for scoped spoken moves. */
  platforms?: readonly PublicReplyPlatform[];
}

// The `loud` tier is unreachable under these energies. Someone venting or
// asking a real question gets plain spoken English or nothing; a performance
// there reads as not listening.
//
// An UNKNOWN energy (null) is blocked too, and that is the load-bearing case
// rather than an edge one: `postEnergy` is null whenever NOELLE_DRAFTER_ENERGY
// is off, which is its default and its state in the live ecosystem config. A
// gate that only fires on a KNOWN vent is therefore a gate that never fires in
// production, and "cooked" would land under someone's layoff post — auto-sent,
// on Reddit. Without a signal we cannot know we are NOT under a vent, so the
// absence of the signal has to mean the same thing as the signal.
export const LOUD_BLOCKED_ENERGIES: readonly PostEnergy[] = ["vent", "question"];

// Weights sum to 1.00 exactly across the whole catalog. Existing markers keep
// their relative distribution inside .68 of the weight. The three scoped
// conversational moves share .32, so the unchanged .22 outer gate lands them
// on roughly 7-10% of eligible X and LinkedIn public replies.
export const GENZ_MARKERS: readonly GenZMarker[] = [
  // --- plain: ordinary spoken register, safe under any post ---------------
  {
    id: "NGL",
    tier: "plain",
    weight: 0.0952,
    directive: '"ngl" (not gonna lie) as a hedge-free lead-in to something honest, e.g. "ngl the second one is the harder problem".',
  },
  {
    id: "TBH",
    tier: "plain",
    weight: 0.0748,
    directive: '"tbh" attached to an opinion, usually at the end of the clause rather than the start.',
  },
  {
    id: "IDK",
    tier: "plain",
    weight: 0.068,
    directive: '"idk" as genuine uncertainty, not as a softener bolted onto a confident claim.',
  },
  {
    id: "KINDA",
    tier: "plain",
    weight: 0.0612,
    directive: '"kinda" or "sorta" doing real work in the sentence, e.g. "kinda the whole reason I stopped".',
  },
  {
    id: "LOWKEY",
    tier: "plain",
    weight: 0.0612,
    directive: '"lowkey" (or "highkey", rarer) in front of an admission, e.g. "lowkey never got this to work".',
  },
  {
    id: "WHY_IS",
    tier: "plain",
    weight: 0.0612,
    directive: 'the "why is X like this" / "why does X always" construction, as a real reaction and not as a rhetorical setup.',
  },
  {
    id: "GROUNDED_AGREEMENT",
    tier: "plain",
    weight: 0.12,
    directive: "a short spoken acknowledgement only when the same thought names a post-specific reason or referent. It cannot stand alone as portable praise or fit unchanged under another post.",
    platforms: ["x", "linkedin"],
  },
  {
    id: "CONTEXT_SUPPORTED_ADDRESS",
    tier: "plain",
    weight: 0.1,
    directive: "natural direct address only when the supplied name, profile, post, or conversation supports the exact words. Never guess identity, gender, relationship, or a pet name.",
    platforms: ["x", "linkedin"],
  },
  {
    id: "RELATIONAL_TAG",
    tier: "plain",
    weight: 0.1,
    directive: "a short tag question only when the preceding words name a clear person or thing as its referent. Drop it when the reference could be ambiguous, and never use it as engagement bait.",
    platforms: ["x", "linkedin"],
  },
  // --- loud: performative, needs a post that can carry it ------------------
  {
    id: "COOKED",
    tier: "loud",
    weight: 0.0544,
    directive: '"cooked" meaning finished or doomed, e.g. "yeah that pipeline is cooked".',
  },
  {
    id: "PEAK",
    tier: "loud",
    weight: 0.0476,
    directive: '"peak" as a flat verdict on a whole category, e.g. "peak dependabot behaviour".',
  },
  {
    id: "UNSERIOUS",
    tier: "loud",
    weight: 0.0408,
    directive: '"unserious" applied to a thing, not a person, e.g. "genuinely unserious pricing page".',
  },
  {
    id: "DEADASS",
    tier: "loud",
    weight: 0.0408,
    directive: '"deadass" as a sincerity marker in front of a claim people would assume is a joke.',
  },
  {
    id: "NOT_ME",
    tier: "loud",
    weight: 0.0408,
    directive: 'the "not me …ing" self-own construction, e.g. "not me shipping the same bug twice". Only when the self-own is TRUE.',
  },
  {
    id: "THE_WAY",
    tier: "loud",
    weight: 0.034,
    directive: 'the "the way X …" construction as an amused reaction, e.g. "the way it just silently retries forever".',
  },
];

/**
 * Share of replies that receive a marker block at all. The rest are drafted
 * with no marker instruction, unchanged.
 *
 * 22% is the "don't overdo it" number: roughly one reply in five carries a
 * visible marker, which is what a real feed looks like. Note the block is a
 * PERMISSION, not an order — the drafter is told to drop the marker when it
 * does not fit — so the share of replies that actually ship one is lower still.
 */
export const DEFAULT_MARKER_RATE = 0.22;

/**
 * Options that narrow the pool for reasons other than the post's energy.
 */
export interface MarkerPoolOpts {
  /** Opt in to moves scoped to one public-reply platform. */
  platform?: PublicReplyPlatform;

  /**
   * Restrict to the plain tier regardless of energy. Set by a PLATFORM, not by
   * a post: LinkedIn is a professional network where "deadass" and "cooked"
   * cost more than they buy, so Lyra takes plain markers only while Vega and
   * Orion get the full set.
   */
  plainOnly?: boolean;
}

/**
 * The markers reachable under a given post energy and platform policy.
 *
 * Fails SAFE on a null/unknown energy: no signal is treated exactly like a
 * blocked signal, so the performative tier needs a POSITIVE reading that the
 * room can carry it. See LOUD_BLOCKED_ENERGIES for why that is the important
 * case and not the edge one.
 */
export function markersForEnergy(
  energy: PostEnergy | null,
  opts: MarkerPoolOpts = {},
): readonly GenZMarker[] {
  const platformPool = GENZ_MARKERS.filter(
