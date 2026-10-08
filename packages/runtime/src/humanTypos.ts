// Human typo injection — the deliberate-imperfection pass on drafted replies.
//
// WHY: every reply that leaves Noelle is currently spelled and punctuated
// perfectly, which is itself a bot tell. A real operator typing on a phone drops
// a word, forgets an apostrophe, transposes two letters. So on a small share of
// replies (18% by default) we introduce EXACTLY ONE small, believable slip.
//
// Rules the design follows, because a typo pass that gets any of these wrong is
// worse than none at all:
//   - ONE mutation per body, never two. Two slips in a 150-char reply reads as
//     broken, not as human.
//   - REPLIES ONLY. A DM is a cold first touch; a typo there costs more than the
//     realism buys. The caller (outboundClient) enforces this by kind.
//   - Never touch a token that carries meaning that a typo would corrupt: an
//     @handle, a #hashtag, a URL, a domain, a number, or any capitalised word
//     (product and person names). isSafeToken() is an ALLOWLIST — lowercase
//     ASCII letters plus an apostrophe — so anything unusual is skipped by
//     default rather than mangled.
//   - Never the first or last token. A mangled opening word reads as a broken
//     bot; a slip in the middle of a sentence reads as a thumb.
//   - Never on a very short reply (see MIN_WORDS / MIN_CHARS). "brutal" ->
//     "brutla" is not a typo, it is a malfunction.
//   - Length-capped: X hard-rejects a reply over 280 chars, so a mutation that
//     grows the body past `maxLength` is discarded rather than shipped.
//
// Pure + unit-testable: `rng` is injectable, so tests pin every branch and the
// workers pass Math.random.

/** The kinds of slip a real person actually makes when typing fast. */
export type TypoKind =
  | "DROP_WORD"
  | "DROP_APOSTROPHE"
  | "TRANSPOSE"
  | "DROP_LETTER"
  | "DOUBLE_WORD"
  // Added in the reply-variation pass: five kinds all produced slips of the
  // same FAMILY (something is missing, or something is duplicated), so a reader
  // scanning the feed saw the same class of imperfection over and over. These
  // three are the phone-specific ones — a thumb landing one key off, two words
  // run together when the space bar is missed, a letter held a beat too long.
  | "KEY_NEIGHBOR"
  | "MISSING_SPACE"
  | "DOUBLE_LETTER";

export interface TypoVariant {
  kind: TypoKind;
  /** Weight in (0,1]; the weights across all variants sum to 1. */
  weight: number;
}

// Weights sum to 1.00. Mix skipped words and keyboard slips so the pass does
// not introduce the same mutation shape into every selected reply.
export const TYPO_VARIANTS: readonly TypoVariant[] = [
  { kind: "DROP_WORD", weight: 0.24 },
  { kind: "DROP_APOSTROPHE", weight: 0.16 },
  { kind: "KEY_NEIGHBOR", weight: 0.13 },
  { kind: "TRANSPOSE", weight: 0.12 },
  { kind: "DROP_LETTER", weight: 0.12 },
  { kind: "DOUBLE_WORD", weight: 0.09 },
  { kind: "MISSING_SPACE", weight: 0.08 },
  { kind: "DOUBLE_LETTER", weight: 0.06 },
];

/** Nominal share of replies receiving one slip; short-reply guards lower the effective rate. */
export const DEFAULT_TYPO_RATE = 0.18;

// Below this a reply is a MICRO / ONE_SHORT shape where every word carries
// weight, so a dropped word reads as broken rather than as a thumb slip
// ("eaten by wolves is wild" -> "eaten by wolves wild"). Both floors must clear.
const MIN_WORDS = 7;
const MIN_CHARS = 40;

// Function words a reader's eye skips over, so dropping one reads as a typing
// slip rather than as a missing thought. Deliberately no content words: dropping
// "shipped" changes what the reply says, dropping "the" does not.
const DROPPABLE_WORDS = new Set([
  "the", "a", "an", "to", "of", "in", "on", "at", "is", "it",
  "that", "and", "my", "was", "for", "be", "are", "as", "with",
]);

// QWERTY horizontal neighbours, for KEY_NEIGHBOR. Only the LEFT/RIGHT
// neighbours on the same row, never the row above or below: a thumb on a phone
// keyboard slides sideways far more often than it jumps rows, and a vertical
// miss ("hello" -> "hetlo") reads as a corrupted string rather than as typing.
// Every value is a lowercase ASCII letter, so a substitution can never turn a
// safe token into an unsafe one.
const KEY_NEIGHBORS: Record<string, string> = {
  q: "w", w: "qe", e: "wr", r: "et", t: "ry", y: "tu", u: "yi", i: "uo", o: "ip", p: "o",
  a: "s", s: "ad", d: "sf", f: "dg", g: "fh", h: "gj", j: "hk", k: "jl", l: "k",
  z: "x", x: "zc", c: "xv", v: "cb", b: "vn", n: "bm", m: "n",
};

// Words no typo may ever CREATE.
//
// KEY_NEIGHBOR is the first kind that SUBSTITUTES a letter rather than deleting
// or duplicating one, which makes real-word collisions reachable: with o -> i on
// the same row, "shot" becomes "shit", and "duck"/"dock" both become "dick"
// (enumerated, not hypothesised). Orion auto-sends, so there is no human between
// that mutation and the subreddit — and it would read as deliberate, because a
// reader has no way to know a typo pass exists.
//
// The check runs on the MUTATED word for every kind, not just KEY_NEIGHBOR:
// DROP_LETTER and TRANSPOSE can land on one of these too. A hit discards that
// mutation and the pass moves on, so the reply simply ships clean.
//
// Deliberately short and lexical rather than a general profanity library: the
// point is not to censor the operator's own words (a draft that already says
// "shit" is untouched), only to refuse to INVENT one.
const NEVER_CREATE = new Set([
  "shit", "piss", "crap", "dick", "cock", "tits", "fuck", "cunt", "slut",
  "whore", "rape", "nazi", "fag", "spic", "kike", "chink", "coon", "wop",
  "retard", "idiot", "dumb", "stupid", "ugly", "died", "dead", "kill",
]);

/** True when a mutation invented a word from NEVER_CREATE that was not there before. */
function inventsBannedWord(before: string, after: string): boolean {
  const words = (t: string) => (t.toLowerCase().match(/[a-z]+/g) ?? []);
  const had = new Set(words(before));
  return words(after).some((w) => NEVER_CREATE.has(w) && !had.has(w));
}

// Sentence punctuation that may sit around a word without changing what the word
// IS. Deliberately excludes sigils (@ #), path/domain characters (. / :) and
// digits: those make the token something a typo must never touch, so leaving
// them attached is what makes isSafeToken reject it.
const TRIM_LEAD = /^[("\u201c'\u2018]+/;
const TRIM_TRAIL = /[)"\u201d'\u2019,.!?;:]+$/;

/** Strip surrounding sentence punctuation, leaving the word itself. */
function coreOf(token: string): string {
  return token.replace(TRIM_LEAD, "").replace(TRIM_TRAIL, "");
}

/**
 * A token is safe to mutate only if it is pure lowercase ASCII letters (an
 * embedded apostrophe allowed). That single test excludes, by construction:
 * @handles, #hashtags, URLs, domains ("getnella.dev"), numbers, emoji, and every
 * capitalised proper noun ("Nella", "Claude") — the exact tokens a typo must
 * never touch. An allowlist, not a denylist, so a token shape nobody thought of
 * is skipped instead of corrupted.
 */
const NEGATIONS = new Set([
  "no", "not", "never", "none", "nobody", "nothing", "neither", "nor", "without", "cannot",
  "can't", "won't", "don't", "doesn't", "didn't", "isn't", "aren't", "wasn't", "weren't",
  "shouldn't", "wouldn't", "couldn't", "mustn't", "hasn't", "haven't", "hadn't", "needn't", "ain't",
]);

function isSafeToken(token: string): boolean {
  // All variants share this check, including both sides of a space removal.
  return !NEGATIONS.has(token) && /^[a-z]+(?:'[a-z]{1,2})?$/.test(token);
}

/**
 * Weighted pick over the typo kinds, walking TYPO_VARIANTS in order and taking
 * the first whose cumulative weight exceeds `r`. `exclude` lets the caller retry
 * with the kinds it has already found no eligible token for. Returns null when
 * every kind is excluded.
 */
export function pickTypoKind(
  rng: () => number = Math.random,
  exclude?: readonly TypoKind[] | null,
): TypoKind | null {
  const excluded = new Set(exclude ?? []);
  const pool = TYPO_VARIANTS.filter((v) => !excluded.has(v.kind));
  if (pool.length === 0) return null;
  const total = pool.reduce((acc, v) => acc + v.weight, 0);
  const r = rng() * total;
  let cumulative = 0;
  for (const v of pool) {
    cumulative += v.weight;
    if (r < cumulative) return v.kind;
  }
  return pool[pool.length - 1]!.kind;
}

/** Indices of `tokens` eligible for `kind`, never the first or last token. */
function eligibleIndices(tokens: string[], kind: TypoKind): number[] {
  const out: number[] = [];
  for (let i = 1; i < tokens.length - 1; i++) {
    const t = tokens[i]!;
    // Strip trailing punctuation for the eligibility test but mutate the raw
    // token, so "word," stays "word," minus its letter rather than losing the
    // comma. Leading punctuation ("(aside") is handled the same way.
    const core = coreOf(t);
    if (!isSafeToken(core)) continue;
    switch (kind) {
      case "DROP_WORD":
        if (DROPPABLE_WORDS.has(core)) out.push(i);
        break;
      case "DROP_APOSTROPHE":
        if (/^[a-z]+'[a-z]{1,2}$/.test(core)) out.push(i);
        break;
      case "TRANSPOSE":
        // Needs two ADJACENT DIFFERENT letters, else the swap is a no-op.
        if (/^[a-z]{3,}$/.test(core) && /([a-z])(?!\1)[a-z]/.test(core)) out.push(i);
        break;
      case "DROP_LETTER":
        if (/^[a-z]{5,}$/.test(core)) out.push(i);
        break;
      case "DOUBLE_WORD":
