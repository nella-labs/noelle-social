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
        if (/^[a-z]{1,4}$/.test(core)) out.push(i);
        break;
      case "KEY_NEIGHBOR":
        // Needs an interior letter (never the first, which is the letter a
        // reader uses to recognise the word) that has a same-row neighbour.
        if (/^[a-z]{4,}$/.test(core) && [...core.slice(1)].some((ch) => KEY_NEIGHBORS[ch])) {
          out.push(i);
        }
        break;
      case "MISSING_SPACE":
        // Joins THIS token with the next one, so the next token must also be
        // safe and must not be the last (the last token is never touched).
        if (i + 1 <= tokens.length - 2) {
          const nextCore = coreOf(tokens[i + 1]!);
          // The join must stay readable as two run-together words, so both
          // sides are short and the raw tokens carry no punctuation between
          // them ("word, the" must not become "word,the").
          if (
            isSafeToken(nextCore) &&
            /^[a-z]{2,6}$/.test(core) &&
            /^[a-z]{2,6}$/.test(nextCore) &&
            tokens[i] === core &&
            tokens[i + 1] === nextCore
          ) {
            out.push(i);
          }
        }
        break;
      case "DOUBLE_LETTER":
        // A held key. The word must contain NO existing double anywhere: with
        // no double in it, no letter equals either of its neighbours, so
        // doubling any interior letter can never produce a triple ("aabc" ->
        // "aaabc" is the bug this guard exists for).
        if (/^(?!.*([a-z])\1)[a-z]{4,}$/.test(core)) out.push(i);
        break;
    }
  }
  return out;
}

/** Apply `kind` to token index `i`. Returns the new token list, or null on no-op. */
function mutate(tokens: string[], i: number, kind: TypoKind, rng: () => number): string[] | null {
  const raw = tokens[i]!;
  const lead = raw.match(TRIM_LEAD)?.[0] ?? "";
  const trail = raw.match(TRIM_TRAIL)?.[0] ?? "";
  const core = raw.slice(lead.length, raw.length - trail.length);
  const next = [...tokens];
  switch (kind) {
    case "DROP_WORD": {
      // A dropped word takes its own punctuation with it, which is what happens
      // when a thumb skips a word entirely.
      next.splice(i, 1);
      return next;
    }
    case "DROP_APOSTROPHE": {
      next[i] = `${lead}${core.replace("'", "")}${trail}`;
      return next[i] === raw ? null : next;
    }
    case "TRANSPOSE": {
      // Collect every adjacent pair of DIFFERENT letters, then pick one.
      const pairs: number[] = [];
      for (let k = 0; k < core.length - 1; k++) {
        if (core[k] !== core[k + 1]) pairs.push(k);
      }
      if (pairs.length === 0) return null;
      const k = pairs[Math.min(pairs.length - 1, Math.floor(rng() * pairs.length))]!;
      const swapped = `${core.slice(0, k)}${core[k + 1]}${core[k]}${core.slice(k + 2)}`;
      next[i] = `${lead}${swapped}${trail}`;
      return next;
    }
    case "DROP_LETTER": {
      // Prefer halving a doubled letter ("really" -> "realy") — the most common
      // real misspelling. Otherwise drop one interior letter.
      const dbl = core.search(/([a-z])\1/);
      const k = dbl >= 0 ? dbl : 1 + Math.min(core.length - 3, Math.floor(rng() * (core.length - 2)));
      const dropped = `${core.slice(0, k)}${core.slice(k + 1)}`;
      next[i] = `${lead}${dropped}${trail}`;
      return next;
    }
    case "DOUBLE_WORD": {
      // The classic scroll-past duplicate: "and and". The copy carries no
      // punctuation, so "so, so," never happens.
      next.splice(i, 0, core);
      return next;
    }
    case "KEY_NEIGHBOR": {
      // Every interior position whose letter has a same-row neighbour, then one
      // of them at random, then one of THAT letter's neighbours.
      const spots: number[] = [];
      for (let k = 1; k < core.length; k++) {
        if (KEY_NEIGHBORS[core[k]!]) spots.push(k);
      }
      if (spots.length === 0) return null;
      const k = spots[Math.min(spots.length - 1, Math.floor(rng() * spots.length))]!;
      const options = KEY_NEIGHBORS[core[k]!]!;
      const ch = options[Math.min(options.length - 1, Math.floor(rng() * options.length))]!;
      next[i] = `${lead}${core.slice(0, k)}${ch}${core.slice(k + 1)}${trail}`;
      return next[i] === raw ? null : next;
    }
    case "MISSING_SPACE": {
      // Eligibility already proved both tokens are bare lowercase words, so the
      // join is exactly the two cores with the space swallowed.
      next.splice(i, 2, `${core}${tokens[i + 1]}`);
      return next;
    }
    case "DOUBLE_LETTER": {
      // Prefer a letter a real thumb lingers on (a vowel or l/s/t), else any
      // interior letter. Eligibility already excluded words with an existing
      // double, so this can never produce a triple.
      const spots: number[] = [];
      const preferred: number[] = [];
      for (let k = 1; k < core.length; k++) {
        spots.push(k);
        if ("aeioults".includes(core[k]!)) preferred.push(k);
      }
      const pool = preferred.length > 0 ? preferred : spots;
      if (pool.length === 0) return null;
      const k = pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))]!;
      next[i] = `${lead}${core.slice(0, k)}${core[k]}${core.slice(k)}${trail}`;
      return next;
    }
  }
}

export interface HumanizeOptions {
  /** Share of bodies that get one slip. Default DEFAULT_TYPO_RATE (0.18). */
  rate?: number;
  /** Injectable RNG for deterministic tests. Defaults to Math.random. */
  rng?: () => number;
  /** Hard character ceiling (X = 280). A mutation that exceeds it is discarded. */
  maxLength?: number;
}

export interface HumanizeResult {
  body: string;
  /** The slip that landed, or null when the body was left untouched. */
  applied: TypoKind | null;
}

/**
 * Roll `rate` and, on a hit, apply exactly ONE believable typing slip to `body`.
 *
 * Returns the body unchanged (applied: null) when the roll misses, when the body
 * is too short to carry a slip, or when no kind found an eligible token — the
 * pass NEVER fails the draft, it just declines to touch it. A body with no safe
 * token (all handles, links, and proper nouns) simply ships clean.
 */
export function humanizeTypos(body: string, opts: HumanizeOptions = {}): HumanizeResult {
  const rate = opts.rate ?? DEFAULT_TYPO_RATE;
  const rng = opts.rng ?? Math.random;
  if (!(rate > 0)) return { body, applied: null };
  if (rng() >= rate) return { body, applied: null };

  // Replies are a single paragraph, so a plain space split round-trips exactly
  // (join(" ") rebuilds the original). A token that swallowed a newline fails
  // isSafeToken and is skipped, so a multi-line body degrades to "no slip"
  // rather than to mangled whitespace.
  const tokens = body.split(" ");
  if (
    tokens.filter((t) => t.trim().length > 0).length < MIN_WORDS ||
    [...body].length < MIN_CHARS
  ) {
    return { body, applied: null };
  }

  const tried: TypoKind[] = [];
  for (;;) {
    const kind = pickTypoKind(rng, tried);
    if (!kind) return { body, applied: null };
    tried.push(kind);
    const candidates = eligibleIndices(tokens, kind);
    if (candidates.length === 0) continue;
    const idx = candidates[Math.min(candidates.length - 1, Math.floor(rng() * candidates.length))]!;
    const mutated = mutate(tokens, idx, kind, rng);
    if (!mutated) continue;
    const next = mutated.join(" ");
    if (next === body) continue;
    // Never INVENT an offensive word. See NEVER_CREATE: "shot" -> "shit" is
    // reachable through a same-row key slip, and Orion auto-sends.
    if (inventsBannedWord(body, next)) continue;
    if (opts.maxLength != null && [...next].length > opts.maxLength) continue;
    return { body: next, applied: kind };
  }
}

/**
 * Read the typo-pass config off the environment.
 *
 * Enabled by default at 18%. `NOELLE_HUMAN_TYPOS=0` disables the pass;
 * `NOELLE_HUMAN_TYPO_RATE` (0..1) retunes the share. A malformed rate falls back
 * to the default rather than disabling the pass silently.
 */
export function typoRateFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  if (env["NOELLE_HUMAN_TYPOS"] === "0") return 0;
  const raw = env["NOELLE_HUMAN_TYPO_RATE"];
  if (raw == null || raw === "") return DEFAULT_TYPO_RATE;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return DEFAULT_TYPO_RATE;
  return n;
}
