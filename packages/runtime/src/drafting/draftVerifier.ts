// Post-draft VERIFIER. After the drafter produces variants, but before they are
// queued for human approval, a judge grades them against the grounding context
// (the original post, the voice anchors, the operator's product knowledge, and
// the watchlist person's profile) on four dimensions:
//
//   - voice:     does it sound like the operator (per the voice anchors)?
//   - grounding: are its claims supported by the post / knowledge (no invented facts)?
//   - relevance: does it actually engage THIS post (vs a generic platitude)?
//   - format:    length caps, em-dashes, banned tics — computed DETERMINISTICALLY,
//                no LLM needed (cheaper + more reliable than asking a model to count).
//
// The LLM judge is injected as a `VerifierCall` closure, so this module is pure
// and unit-testable offline (mirrors how runDrafterTick injects `runner`). The
// worker decides which model/routing/budget the closure uses, and runs the
// regenerate loop. Tiered cost lives in `verifyTiered` (1 cheap judge by default,
// N adversarial judges with majority vote for high-value watchlist leads).

import { houseSkeletonHits } from "../houseSkeleton.js";
import { WRITING_STRUCTURE_GUIDANCE } from "../writingStructure.js";
import { evaluateJevBooleans, type JevRun } from "../jev.js";
import { compileLearnedPattern, type LearnedPattern } from "../patternBreaker/regex.js";
import type { ConversationBrief } from "../conversationBlock.js";

export interface DraftToVerify {
  kind: "reply" | "dm" | "repost" | "post";
  angle: string | null;
  body: string;
}

export interface VerifyContext {
  platform: "x" | "linkedin" | "reddit";
  postText: string;
  authorHandle?: string | null;
  /** Voice snippets the drafts should match in TONE (not topics to force). */
  voiceAnchors?: string[];
  /**
   * Voice evidence from a writer the operator explicitly pinned in faithful
   * mode. The drafter is told to adopt this voice, so the verifier must grade
   * against the same target instead of rejecting it for differing from the
   * operator's base reply history. Content and factual claims still come only
   * from the post and knowledge anchors.
   */
  faithfulVoiceAnchors?: string[];
  /** Operator product/positioning facts the drafts must stay grounded in. */
  knowledgeAnchors?: string[];
  /** Operator-supplied identity and product facts, excluding voice or directives. */
  operatorFacts?: string[];
  /** Observed thread turns supplied to the writer, treated as source data. */
  conversation?: ConversationBrief | null;
  /** Rendered watchlist-person profile (who they are / how to engage). */
  personProfile?: string | null;
  /** Per-kind hard character cap for the format check (e.g. X reply 250). */
  charLimit?: number;
  /**
   * Description of the post's image(s), when it has any (from the vision pass).
   * Folded into the judge prompt so the judge can grade `relevance` lower when an
   * image is central to the post but the reply ignores it. Absent on text-only
   * posts → no change.
   */
  imageCaption?: string | null;
  /**
   * Learned anti-pattern rules from the Pattern Breaker (noelle.pattern_rules).
   * These are DISCOVERED from the operator's last-N corpus, not hardcoded — the
   * dynamic sibling of SLOP_PHRASES. A 'phrase' rule with a regex is a
   * deterministic hard-zero (like a SLOP_PHRASES entry); a 'structure' rule's
   * instruction is injected into the LLM judge prompt so it penalizes the shape.
   */
  dynamicBannedPatterns?: DynamicPattern[];
  /**
   * Celebration reply (LIGHT path): a win/launch/milestone post whose whole job
   * is a short, warm congrats. When set, the deterministic format check does NOT
   * hard-zero the celebration-closer phrases ("congrats on the launch", "love
   * this", "this is huge") — those ARE the intended content here, not tacked-on
   * slop. All other slop tells (insight-bait, filler closers, em dashes, garbled
   * text) still apply. Substantial replies leave this off and stay fully strict.
   */
  allowCelebration?: boolean;
  /**
   * The recent replies the operator has ALREADY sent to THIS person (newest
   * first), from getRecentRepliesToAuthor. When present, the judge grades a
   * `novelty` dimension: does the new draft repeat a point/angle/phrasing
   * already used with this person? A redundant draft scores low and regenerates
   * with a "say something new to them" fix. Empty/omitted → novelty is forced to
   * 1.0 (no first-contact penalty), so behavior is unchanged when there's no
   * history. This is the per-person sibling of the cross-post Pattern Breaker.
   */
  priorRepliesToPerson?: string[];
  /**
   * The operator's most recent replies across the WHOLE feed (any author, newest
   * first), from getRecentReplyPhrasings. When present, a DETERMINISTIC
   * `diversity` dimension grades whether THIS reply is too structurally alike the
   * recent ones — same opener, same phrasing, same shape. Too similar scores low
   * and regenerates with a "take a different shape" fix, so the last ~20 replies
   * stay varied (operator: "make sure the 20 last replies are nothing alike").
   * Empty/omitted → diversity is forced to 1.0 (mirrors `novelty`), so behavior
   * is unchanged when there's no history. The global sibling of `novelty` (which
   * is per-person) and the enforcement leg of the drafter's recent-phrasings
   * avoid-list. Reply-kind drafts only (DMs/reposts are exempt).
   */
  recentReplies?: string[];
}

/**
 * A learned anti-pattern rule, as the verifier + drafter consume it. Mirrors a
 * row of noelle.pattern_rules (minus the bookkeeping columns).
 */
export interface DynamicPattern {
  kind: "phrase" | "structure";
  label: string;
  instruction: string;
  /**
   * The positive "do this instead" mirror of `instruction`. Not used by the
   * verifier's scoring — carried so the drafter prompt can append it to the ban
   * ("- <ban> → instead: <suggestion>"). Optional for back-compat.
   */
  suggestion?: string | null;
  /** Deterministic catch for kind='phrase'. Pre-validated to compile upstream. */
  regex?: string | null;
  /**
   * How the rule was created: 'auto' (the Pattern Breaker detected it), 'refined'
   * (operator hit Refine), 'manual' (operator hand-typed it). Auto phrase rules
   * are a SOFT penalty in the format check — the operator wanted variety nudges,
   * not forever-bans, so an occasional reuse is allowed and the rolling-window
   * `diversity` check does the real anti-repetition work. Operator-confirmed
   * rules ('refined'/'manual') AND undefined (back-compat) stay a HARD ZERO.
   */
  source?: "auto" | "refined" | "manual";
}

/** Compile a stored regex string safely; returns null on a bad pattern so one
 * malformed rule never crashes verification. */
function compilePattern(src: string): LearnedPattern | null {
  return compileLearnedPattern(src);
}

/** Deterministic hits for the learned 'phrase' rules (regex). Returns the matched
 * rules so the caller can weight by `source` (auto = soft, confirmed = hard).
 * Structure rules have no regex and are handled by the judge prompt instead. */
function dynamicPatternHits(body: string, patterns?: DynamicPattern[]): DynamicPattern[] {
  if (!patterns?.length) return [];
  const hits: DynamicPattern[] = [];
  for (const p of patterns) {
    if (p.kind !== "phrase" || !p.regex) continue;
    const re = compilePattern(p.regex);
    if (re && re.test(body)) hits.push(p);
  }
  return hits;
}

// ---- Feed-wide reply diversity --------------------------------------------
// Deterministic "is this reply too much like the recent ones" score — no LLM.
// Compares a draft against the operator's recent replies (any author) on the two
// axes a reader clocks instantly: the OPENER (first few words) and overall
// PHRASING overlap (shared word-trigrams). similarity is 0..1; the diversity
// score is 1 - the max similarity to any recent reply, so a near-verbatim or
// same-opener reply scores low and regenerates with a different shape. Operator:
// "make sure the 20 last replies are nothing alike or at least try."

function normalizeWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function wordTrigrams(words: string[]): Set<string> {
  const grams = new Set<string>();
  for (let i = 0; i + 2 < words.length; i++) grams.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  // Bodies under 3 words have no trigrams; fall back to the words themselves so a
  // short echo ("ship it", "love this") still registers.
  if (grams.size === 0) for (const w of words) grams.add(w);
  return grams;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Similarity 0..1 of two reply bodies: opener overlap blended with phrasing
 * overlap; a near-verbatim repeat (high trigram overlap) dominates on its own. */
function replySimilarity(aWords: string[], bWords: string[]): number {
  const opener = jaccard(new Set(aWords.slice(0, 5)), new Set(bWords.slice(0, 5)));
  const phrasing = jaccard(wordTrigrams(aWords), wordTrigrams(bWords));
  return Math.max(phrasing, 0.35 * opener + 0.65 * phrasing);
}

/**
 * Diversity of one reply vs the recent feed. 1.0 = distinct (or no history);
 * lower = it echoes a recent reply's opener/phrasing/shape. `mostSimilar` is the
 * recent reply it most resembles, for the regenerate fix. Empty history → 1.0.
 */
export function replyDiversityScore(
  body: string,
  recentReplies?: string[],
): { score: number; mostSimilar: string | null } {
  const recent = (recentReplies ?? []).map((r) => r.trim()).filter(Boolean);
  if (recent.length === 0) return { score: 1, mostSimilar: null };
  const words = normalizeWords(body);
  if (words.length === 0) return { score: 1, mostSimilar: null };
  let maxSim = 0;
  let mostSimilar: string | null = null;
  for (const r of recent) {
    const sim = replySimilarity(words, normalizeWords(r));
    if (sim > maxSim) {
      maxSim = sim;
      mostSimilar = r;
    }
  }
  return { score: clamp01(1 - maxSim), mostSimilar };
}

export interface DimensionScores {
  voice: number;
  grounding: number;
  relevance: number;
  format: number;
  /**
   * Per-person novelty (0..1): is the draft fresh vs the replies already sent to
   * THIS person? 1.0 = nothing repeated (or no prior history). Low = it rehashes
   * a point/angle already made to them and should be rewritten.
   */
  novelty: number;
  /**
   * Feed-wide diversity (0..1): is the draft structurally UNLIKE the operator's
   * recent replies across all authors? 1.0 = distinct (or no recent history).
   * Low = it reuses an opener / phrasing / shape from the recent window and
   * should be rewritten with a different shape. Deterministic (not judge-scored),
   * like `format`.
   */
  diversity: number;
}

export interface DraftVerdict {
  /** All dimensions cleared the pass threshold. */
  pass: boolean;
  /** 0..1 per dimension. `format` is deterministic; the rest are the judge's. */
  scores: DimensionScores;
  /** Human-readable reasons (judge reasons + any deterministic format failures). */
  reasons: string[];
  /** Actionable critique to append to the drafter prompt on a regenerate. */
  fix: string | null;
  /** Did the LLM judge genuinely return a parseable verdict? false = it errored/parse-failed and the content dims were passed OPEN. Consumers that must fail CLOSED (unattended auto-send) require this === true; undefined is treated as not-ok. Manual/queue behavior ignores it. */
  judgeOk?: boolean;
  /** Which model actually returned the semantic verdict. `none` means fail-open. */
  judgeProvider?: "jev" | "legacy" | "mixed" | "none";
}

/** Injected judge: (system, prompt) → raw model text. The worker wires the
 * model/routing/budget; tests pass a stub. */
export type VerifierCall = (system: string, prompt: string) => Promise<string>;

const EM_DASH = /[—–―]|--/;
// Raised from 0.6: a 0.62 "voice" slop draft used to squeak through. The bar for
// sounding human is higher now; borderline drafts regenerate.
const DEFAULT_PASS_THRESHOLD = 0.7;

// Soft penalty for an AUTO-detected Pattern Breaker phrase rule (operator wanted
// variety nudges, not forever-bans). Sized so a SINGLE hit on an otherwise-clean
// reply still clears the threshold (1 - 0.3 = 0.7) — an occasional reuse is fine
// — while a pile-up (2+) or a hit alongside other tells drops below and
// regenerates. Operator-confirmed ('refined'/'manual') rules stay a hard zero.
const AUTO_PATTERN_PENALTY = 0.3;

// Soft penalty for the "honestly" filler tic on strict-voice platforms. Same
// sizing and rationale as AUTO_PATTERN_PENALTY: one use clears the bar, a
// pile-up does not. See the call site in scoreFormat for why this stopped being
// a hard zero.
const HONESTLY_PENALTY = 0.3;

// Named AI-slop tells — deterministic catch (no LLM, 100% reliable). These are
// the formulaic phrasings operators flag most: the "hits different" reaction,
// the "the gap between X is where most…" insight-bait template, and the
// "curious to hear how it lands" filler closer. Any hit tanks the format score
// so the draft regenerates. Keep this in sync with the drafter prompt NEVER-DO.
// `celebration: true` marks a warm win/launch reaction. These ARE the intended
// content of a LIGHT reply (a short congrats on a win), so they're exempt when
// the verify context sets allowCelebration. On the substantial path they stay
// banned (a substantive comment shouldn't end on a tacked-on "congrats!").
const SLOP_PHRASES: Array<{ re: RegExp; label: string; celebration?: boolean; standaloneReaction?: boolean }> = [
  { re: /\bhits?\s+(different|home|hard|deep)\b/i, label: "'hits different/home/hard' cliché" },
  { re: /\b(lands?|landed)\s+(well|hard|different)\b/i, label: "'lands well' cliché" },
  { re: /\bthe gap between\b/i, label: "'the gap between…' insight-bait template" },
  { re: /\bis where (most|the)\b/i, label: "'…is where most orgs…' insight-bait template" },
  { re: /\bcurious to (hear|see|know)\b/i, label: "'curious to hear…' filler closer" },
  { re: /\bcurious(?:\s*[:,]\s*|\s+)(?:how|what|why|whether|when|where|which|who)\b/i, label: "'curious how/what…' question preamble — ask the actual question directly" },
  { re: /\b(would|i'?d) love to hear how\b/i, label: "'would love to hear how…' filler closer" },
  { re: /\bkeen to (hear|see) how\b/i, label: "'keen to see how…' filler closer" },
  { re: /\bhow (it|this|that|the conversation) (lands|plays out|unfolds|shakes out)\b/i, label: "'how it plays out' filler closer" },
  { re: /\bbabysit/i, label: "'babysit' (use a synonym: hand-hold, shepherd, nurse along)" },
  // Generic tacked-on CLOSERS — the "[real sentence]. [tiny filler phrase]." AI
  // two-beat (operator: "sentence. small phrase." repeats SO much). On the
  // substantial path these add nothing; cut them and end on the actual point.
  // The warm win-reactions are tagged `celebration` (allowed on the LIGHT path).
  { re: /\bcongrats on (shipping|launching|the launch|building|the win|the milestone|this)\b/i, label: "'congrats on shipping/launching…' generic closer", celebration: true },
  { re: /\bcongrats[!.]/i, label: "'Congrats!' tacked-on closer — say something specific about the win", celebration: true },
  { re: /\bexcited to (see|watch) (where|how) (this|it)\b/i, label: "'excited to see where this goes' filler closer", celebration: true },
  { re: /\b(love|loving) (this|that|it)[!.\s]*$/im, label: "'love this' generic closer — name the SPECIFIC thing you love", celebration: true },
  { re: /\bwell said[!.]/i, label: "'well said' generic agreement closer" },
  { re: /\b(great|solid|strong) (point|take|call|stuff|insight|design call)[!.]/i, label: "'great point/strong call' generic agreement" },
  { re: /\bso (true|real|good)[!.]/i, label: "'so true/so real' generic agreement closer", standaloneReaction: true },
  { re: /\bkeep (it up|crushing|going|pushing|shipping|building)\b/i, label: "'keep it up' generic cheerleader closer" },
  { re: /\bnicely done\b|\bamazing work\b|\bgreat work\b/i, label: "'nicely done / amazing work' generic closer", celebration: true },
  { re: /\b(this|that)('?s| is) (huge|fire|gold|massive)[!.]/i, label: "'this is huge/fire' generic hype closer", celebration: true },
  // Lazy referential / filler phrasings (operator: stop pointing vaguely BACK at
  // the post — "the part where…", "the stuff", "something of the post" — and stop
  // the "this slaps" reaction tic). Name the SPECIFIC thing instead of gesturing.
  { re: /\bthe part (where|about|of|that)\b/i, label: "'the part where/about…' — name the specific thing, don't point back at the post" },
  { re: /\b(?:the|that)\s+(?:part|bit|line|detail|thing|piece)\s+i\s+(?:keep|kept)\s+(?:thinking|getting stuck|coming back|returning|chewing|re[ -]?reading)\b/i, label: "'the part I keep thinking about…' significance framing — react to the detail itself" },
  { re: /\b(?:the|that)\s+(?:part|bit|line|detail|thing|piece)(?:\s+that)?\s+(?:stuck|stayed)\s+with me\b/i, label: "'the line that stuck with me…' significance framing — react to the detail itself" },
  { re: /\b(or\s+)?the stuff\b/i, label: "'the stuff / or the stuff' vague filler — say what you actually mean" },
  { re: /\bsomething of (the|your|his|her|their)\b/i, label: "'something of the post/your take…' vague referencing — be specific" },
  { re: /\bslaps\b/i, label: "'this slaps / slaps' reaction cliche" },
];

function slopPhraseHits(body: string, allowCelebration = false): string[] {
  const standaloneReaction = /^so\s+(true|real|good)[.!?…]*$/i.test(body.trim());
  return SLOP_PHRASES.filter((p) =>
    !(allowCelebration && p.celebration) && !(standaloneReaction && p.standaloneReaction) && p.re.test(body),
  ).map((p) => p.label);
}

// ---- anti-ai skill: reader-mode tells --------------------------------------
// Sourced from the operator's `anti-ai` skill (SKILL.md constraint 14 +
// references/tells.md §1). These are the families that skill contributes which
// SLOP_PHRASES above did NOT already cover. Gated to the strict-voice platforms
// (LinkedIn/Lyra) via scoreFormat's `strictVoice` flag — Lyra is draft-only, so
// she is the safe place to tighten first; flipping these on for Vega/Orion is a
// one-line change at the call site.
//
// Deliberately NOT included here, and left as prompt-only guidance: words with a
// legitimate technical sense in the operator's domain (robust, ecosystem,
// trajectory, navigate, harness) and shape-level tells a regex can't judge in a
// 100-char comment (rule of three, invented concept labels, low burstiness).

// Constraint 14 — sentences whose only job is to tell the reader what ANOTHER
// sentence meant. The skill's cleanest single-variable result: a rant that
// satisfied every other check scored 100% AI; deleting exactly two of these
// sentences and changing nothing else flipped it to 100% Human. The fix is
// DELETION, not rewording — a real person re-hits the detail instead of
// announcing that it mattered.
const SIGNIFICANCE_MARKERS: Array<{ re: RegExp; label: string }> = [
  // "that's the part that…" is deliberately absent: SLOP_PHRASES already bans
  // "the part (where|about|of|that)" on every platform, so listing it here only
  // emitted a duplicate reason that crowded the 8-slot approval card.
  { re: /\bthat'?s the bit (that|which)\b/i, label: "'that's the bit that…' significance-marker" },
  { re: /\bthat'?s the (uncomfortable|disgusting|weird|funny|wild|crazy|scary|interesting|tricky|annoying|frustrating|sad|depressing|real|whole) part\b/i, label: "'that's the [adjective] part' significance-marker" },
  // RETROSPECTIVE form only. "what got me was X" narrates back at a story you
  // already told, which is the tell the skill names. "what gets me is X" is a
  // present-tense opinion frame that CARRIES the content rather than labelling
  // another sentence — the skill's own definition ("a sentence whose only job is
  // to tell the reader what ANOTHER sentence meant") does not cover it, and both
  // drafts it caught in the live corpus were approved and sent by the operator.
  { re: /\bwhat (got|killed|scared|bugged|surprised) me (was|were)\b/i, label: "'what got me was…' significance-marker" },
  { re: /\b(that'?s|that is) what (kills?|gets|got|scares?|worries) me\b/i, label: "'that's what kills me' significance-marker" },
  // Contraction-agnostic. The regenerate prompt hands the drafter the CONTRACTED
  // phrase verbatim ("here's the thing"), which nudges it straight at the
  // un-contracted near-miss ("here is the thing"); every variant must close.
  { re: /\b(here'?s|here is) the thing\b/i, label: "'here's the thing' significance-marker" },
  { re: /\bthe thing is\b/i, label: "'the thing is…' significance-marker" },
  { re: /\b(and\s+)?(that'?s|that is) (exactly\s+|precisely\s+|really\s+)?the (whole\s+|real\s+)?(point|problem|issue)\b/i, label: "'and that's the point' significance-marker" },
  // Narrowed to the noun form only. "which is exactly why <cause>" is an ordinary
  // causal connective, not a significance-marker, and the broad version fired on a
  // real draft that was making a substantive point ("…which is exactly why a night
  // with no one to push back matters").
  { re: /\bwhich is exactly the (problem|point|issue|thing)\b/i, label: "'which is exactly the problem' significance-marker" },
  { re: /\blet that sink in\b/i, label: "'let that sink in' significance-marker" },
];

// references/tells.md §1 — the highest-value constructions Lyra's NEVER-DO list
// did not already name: copula dodge, participial tail, vague authority, false
// suspense, grandiosity.
const READER_TELLS: Array<{ re: RegExp; label: string; exemptWhenGroup1?: boolean }> = [
  // 'serving' is EXCLUDED: "serving as head of eng" is the single most common
  // legitimate phrase on the platform Lyra actually works, and role/promotion
  // posts are exactly what she comments on. The copula dodge is "X serves as Y".
  // 'serve/serves as' dropped for the same reason as 'serving': LinkedIn role
  // posts are Lyra's core content ("happy to serve as a reference", "he will
  // serve as interim CTO"). Only the 'stands as' form stays deterministic; the
  // prompt still bans the whole family.
  { re: /\b(stands?|standing)\s+as\b/i, label: "copula dodge ('stands as') — just write 'is'" },
  // 'functions as' needs a pronoun subject — code-writing accounts use this phrase legitimately
  // ("we index nested functions as separate scopes" is a plural noun, not a
  // copula). 'represents' is dropped to prompt-only entirely: it is not in the
  // skill's wordbank at all, and it is the literally correct verb for a mapping
  // ("each node represents a symbol").
  { re: /\b(it|this|that|which|he|she|they|one)\s+functions\s+as\b/i, label: "copula dodge ('functions as') — just write 'is'" },
  { re: /\bboasts\b/i, label: "copula dodge ('boasts') — just write 'has'" },
  // Anchored to the comma: what makes this a TAIL is that it hangs off a finished
  // clause. Without the anchor it fired on ordinary present progressives ("the
  // counter is reflecting the old value").
  { re: /,\s*(highlighting|underscoring|showcasing|emphasizing|demonstrating|reflecting)\s+(the|its|how|a)\b/i, label: "participial tail ('…, underscoring its role') — delete it or make it a real claim" },
  // Inflected forms matter: "experts noted" / "the data showed" are the same tell,
  // and the bare-stem alternation missed both (\bnote\b does not match "noted").
  // The possessive lookbehind exempts OWNED, sourced data ("our benchmark data
  // shows a 3x speedup") — naming your source is the fix this rule asks for, so
  // firing on it contradicted the reason string.
