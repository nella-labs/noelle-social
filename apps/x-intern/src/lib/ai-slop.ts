// Configured style and spam heuristics for incoming X posts.
// The classifier uses this deterministic score alongside its model verdict.
// Scores measure matched patterns; weights require several weak signals to
// cross the cutoff, while mass tagging and hashtag stuffing carry more weight.

export interface AiSlopResult {
  /** 0..1, increasing with configured style and spam signals. */
  score: number;
  /** True when `score >= AI_SLOP_CUTOFF`: drop the lead. */
  isSlop: boolean;
  /** Human-readable tells that fired, for auditing on the lead. */
  reasons: string[];
}

/** Score at/above which a post is treated as slop and dropped. */
export const AI_SLOP_CUTOFF = 0.5;

// Strongest hype / AI-buzzword vocabulary from writing-rules.md §4A. Kept to the
// high-signal subset — generic words ("important", "great") are deliberately absent.
const HYPE_WORDS = [
  "seamless", "robust", "leverage", "unlock", "supercharge", "game-changer",
  "game-changing", "revolutionize", "revolutionary", "cutting-edge", "frictionless",
  "paradigm", "delve", "harness", "elevate", "empower", "streamline", "scalable",
  "transformative", "groundbreaking", "innovative", "synergy", "holistic",
  "disruptive", "reimagine", "unprecedented", "state-of-the-art", "turnkey",
  "future-proof", "10x", "next-level", "best-in-class", "mission-critical",
  "tapestry", "intricate", "meticulous", "pivotal", "crucial",
];

// Bloated copular verbs that dodge plain "is/has" (writing-rules §4B).
const BLOATED_VERBS = [
  "serves as", "stands as", "marks a", "represents a", "boasts a", "plays a role",
  "designed to", "aims to", "seeks to", "strives to",
];

// Dead openings and transitions (writing-rules §4C/§4D).
const DEAD_PHRASES = [
  "in today's", "let's dive in", "let's explore", "let's unpack",
  "it is worth noting", "it's worth noting", "it is important to note",
  "at the end of the day", "moving forward", "furthermore", "moreover",
  "additionally", "that being said", "in this article", "to put this in perspective",
];

// Engagement bait + signature launch tells (writing-rules §4E/§4F).
const BAIT_PHRASES = [
  "let that sink in", "read that again", "this changes everything",
  "you are not ready", "you're not ready", "building in public",
  "are you paying attention", "nobody is talking about", "most people don't realize",
];

// Significance inflation (writing-rules §8A).
const INFLATION_PHRASES = [
  "pivotal moment", "key turning point", "major shift", "broader implications",
  "setting the stage", "a testament to",
];

// Negative-parallelism / reframe — the hardest-banned, most machine-detected tell
// (writing-rules §5). "not X, it's Y" / "X is dead. Y is the future." etc.
const REFRAME_PATTERNS: RegExp[] = [
  /\b(?:it'?s|this is|that'?s) not\b[^.?!]{0,60}?\b(?:it'?s|it is)\b/i,
  /\bnot\s+(?:just\s+)?(?:a|an|about)\b[^.?!]{0,50}?\bit'?s\b/i,
  /\bthe (?:question|problem|answer|goal|point|issue) (?:is|isn'?t|is not)\b[^.?!]{0,50}?\bit'?s\b/i,
  /\bisn'?t\b[^.?!]{0,40}?\bit'?s\b/i,
  /\bis dead\b[^.?!]{0,40}?\bis the future\b/i,
  /\bstop\s+\w+ing\b[^.?!]{0,40}?\bstart\s+\w+ing\b/i,
  /\bless\s+\w+,?\s+more\s+\w+\b/i,
];

function countDistinct(text: string, terms: string[]): { hits: number; matched: string[] } {
  const lower = text.toLowerCase();
  const matched: string[] = [];
  for (const term of terms) {
    // word-boundary-ish: term may contain spaces/hyphens, so guard the edges manually.
    const re = new RegExp(`(?:^|[^a-z0-9])${escapeRe(term)}(?:[^a-z0-9]|$)`, "i");
    if (re.test(lower)) matched.push(term);
  }
  return { hits: matched.length, matched };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Grade a post's text for AI-slop tells. Returns a 0..1 score, an `isSlop` drop
 * decision, and the list of tells that fired.
 */
export function detectAiSlop(text: string): AiSlopResult {
  const reasons: string[] = [];
  let raw = 0;
  const t = (text ?? "").trim();
  if (!t) return { score: 0, isSlop: false, reasons };

  // 1. Negative parallelism / reframe — heaviest. Each independent hit is damning.
  let reframeHits = 0;
  for (const re of REFRAME_PATTERNS) if (re.test(t)) reframeHits++;
  if (reframeHits > 0) {
    raw += Math.min(reframeHits, 2) * 0.45;
    reasons.push(`reframe/negative-parallelism x${reframeHits}`);
  }

  // 2. Em-dash over-use. One em-dash is human; the LLM tell is stacking them.
  const emDashes = (t.match(/—/g) ?? []).length;
  if (emDashes >= 2) {
    raw += Math.min(emDashes - 1, 3) * 0.18;
    reasons.push(`em-dash density x${emDashes}`);
  }

  // 3. Hype / buzzword vocabulary (distinct words, capped).
  const hype = countDistinct(t, HYPE_WORDS);
  if (hype.hits > 0) {
    raw += Math.min(hype.hits * 0.12, 0.6);
    reasons.push(`hype/buzzwords: ${hype.matched.slice(0, 6).join(", ")}`);
  }

  // 4. Bloated copular verbs.
  const bloated = countDistinct(t, BLOATED_VERBS);
  if (bloated.hits > 0) {
    raw += Math.min(bloated.hits * 0.12, 0.36);
    reasons.push(`bloated verbs: ${bloated.matched.join(", ")}`);
  }

  // 5. Dead openings / transitions.
  const dead = countDistinct(t, DEAD_PHRASES);
  if (dead.hits > 0) {
    raw += Math.min(dead.hits * 0.1, 0.3);
    reasons.push(`dead openings/transitions: ${dead.matched.join(", ")}`);
  }

  // 6. Engagement bait / launch tells.
  const bait = countDistinct(t, BAIT_PHRASES);
  if (bait.hits > 0) {
    raw += bait.hits * 0.2;
    reasons.push(`engagement bait: ${bait.matched.join(", ")}`);
  }

  // 7. Significance inflation.
  const inflation = countDistinct(t, INFLATION_PHRASES);
  if (inflation.hits > 0) {
    raw += Math.min(inflation.hits * 0.12, 0.3);
    reasons.push(`significance inflation: ${inflation.matched.join(", ")}`);
  }

  // 8. Emoji-as-bullets — 3+ emoji used as inline section markers (followed by a
  //    word or slash) is the launch-post signature.
  const emojiMarkers = (t.match(/\p{Extended_Pictographic}️?\s+[\/\p{L}]/gu) ?? []).length;
  if (emojiMarkers >= 3) {
    raw += 0.3;
    reasons.push(`emoji-as-bullets x${emojiMarkers}`);
  }

  // 9. Rule of three — "A, B, and C" packaging (low weight; legit lists exist).
  if (/[\w)]+,\s+[^,]{1,40},\s+and\s+\w+/i.test(t)) {
    raw += 0.15;
    reasons.push("rule-of-three list");
  }

  // 10. Mass @-mention tagging — engagement bait / spam (a genuine ICP question
  //     rarely tags 5 accounts). Count distinct handles.
  const mentions = new Set(
    [...t.matchAll(/(?:^|[^\w@])@(\w{1,15})/g)].map((m) => m[1]!.toLowerCase()),
  );
  if (mentions.size >= 5) {
    raw += 0.6;
    reasons.push(`mass-mention bait x${mentions.size}`);
  } else if (mentions.size === 4) {
    raw += 0.25;
    reasons.push("many mentions x4");
  }

  // 11. Hashtag stuffing — 3+ hashtags reads as promo/news/spam, not conversation.
  const hashtags = (t.match(/(?:^|\s)#\w+/g) ?? []).length;
  if (hashtags >= 3) {
    raw += 0.5 + Math.min(hashtags - 3, 3) * 0.1;
    reasons.push(`hashtag stuffing x${hashtags}`);
  }

  // 12. News / announcement headline emoji used as a lead-in (💥🚨🔴📢📰⚡🔥📈).
  //     On its own it's weak; it pushes a hashtag-stuffed news post over the line.
  if (/^\s*[💥🚨🔴📢📰⚡️🔥📈🗞️🆕]/u.test(t)) {
    raw += 0.15;
    reasons.push("news/announcement headline emoji");
  }

  const score = Math.min(1, raw);
  return { score, isSlop: score >= AI_SLOP_CUTOFF, reasons };
}
