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
