// The HOUSE SKELETON — the one sentence shape both reply drafters converge on,
// and the deterministic check that catches it.
//
// WHAT IT IS: take a detail out of the post, make it the grammatical subject,
// and attach a verdict to it.
//
//   "the $0/hour line is doing a lot of work here"
//   "the brothers-as-cofounders line is the one i keep chewing on"
//   "clipboard history is the one store that keeps every api key"
//   "gm posts are the part i'd cut"
//   "the trust ranking is the bit i'd fight"
//
// WHY IT MATTERS: measured over 30 days of live drafts (688 replies), ~55% of
// Lyra's and ~49% of Vega's opened on this shape, and one narrow sub-frame of
// it — "is the <one|part|bit|line|detail|step> i/nobody <verb>" — accounted for
// 10.6% of Lyra's feed and 6.1% of Vega's on its own. That is a bot signature:
// the two interns read as the same writer because they are running the same
// skeleton with different nouns in it.
//
// TWO LAYERS, on purpose:
//   1. NO_HOUSE_SKELETON_RULE — the prompt ban. Structural, so it covers the
//      whole family; only a language model can judge "is this sentence grading
//      their material or adding mine?".
//   2. houseSkeletonHits() — a deliberately NARROW deterministic check, wired
//      into the verifier's format score. It catches only the canned sub-frames,
//      where a regex can be confident. Broad structural detection is the LLM
//      judge's job; a wide regex here would fire on legitimate sentences.
//
// Shared by Lyra and Vega via @noelle/runtime so the ban is worded once. Orion
// (Reddit) can adopt it unchanged — the wording is platform-neutral.

/**
 * The prompt-side ban. Injected into both reply drafters' system prompts.
 *
 * Deliberately gives the POSITIVE alternative as well as the ban: a NEVER-DO
 * with no "do this instead" just pushes the model to the next-nearest cliche
 * (the same lesson the Pattern Breaker's `suggestion` column encodes).
 */
export const NO_HOUSE_SKELETON_RULE = `NEVER GRADE THEIR DETAIL (the house skeleton — applies to the public reply/comment only, never a DM; check it LAST, before you output)
The single most repeated shape in this account's replies is: lift a detail out of their post, make it the subject of your sentence, and attach your verdict to it. "the $0/hour line is doing a lot of work here", "the trust ranking is the bit i'd fight", "clipboard history is the one store that keeps every api key", "gm posts are the part i'd cut". Across the last 30 days it was roughly HALF of every reply. It is banned.
The tell is STRUCTURAL, so swapping the noun does not fix it. The pattern is: subject = something they said; predicate = your assessment OF that thing. Every variant is banned, including "is the one/part/bit/line/detail/step/thing i…", "is doing a lot of the work", "is the real/whole/only/hardest/least…", "says more about X than Y", "only holds if…", and "is where…". Any sentence whose job is to rank, label, or grade their material rather than add your own is this shape.
Write the OTHER sentence instead. Make yourself, the reader, or the world the subject: what you did in that spot, what it cost you, what you'd do differently, what you doubt and why, or the question you actually have. If your first clause would survive being pasted under any other post in the category with one noun swapped, you wrote the skeleton — delete it and start from your own side of the story.`;

// Fixed lexical frames with a narrow exception for factual staffing history.
// Broader assessment remains with the semantic review.
const HOUSE_SKELETON_FRAMES: Array<{ re: RegExp; label: string; staffingFact?: boolean }> = [
  {
    // "is the one i keep chewing on" / "are the part i'd cut" / "is the bit i'd fight"
    re: /\b(?:is|are|was|were)\s+(?:the|a|my)\s+(?:one|part|bit|line|detail|step|thing|piece|move|knob|habit|number|question)\b/gi,
    label:
      "\"… is the one/part/bit/line/detail i …\" — the house skeleton (grading a detail from their post instead of adding your own). Rewrite with YOU as the subject: what you did, what it cost, what you'd do differently",
  },
  {
    // "is doing a lot of the work" / "is doing most of the lifting"
    re: /\b(?:is|are|was|were)\s+(?:doing|carrying)\s+(?:a\s+lot|most|all)\s+of\s+(?:the\s+)?(?:work|lifting|weight)\b/gi,
    label:
      "\"… is doing a lot of the work\" — a canned verdict-on-their-detail frame. Say what the thing actually implies or costs, in your own words",
  },
  {
    // "is the whole job" / "is the real bottleneck" / "is the hardest part"
    re: /\b(?:is|are|was|were)\s+the\s+(?:whole|real|only|least|most|hardest|rarest|rare|scariest|scary)\s+\w+/gi,
    staffingFact: true,
    label:
      "\"… is the whole/real/only/hardest …\" — a portable superlative verdict that fits under any post in the category. Replace it with something true about your own side",
  },
  {
    // "says more about X than Y" — the comparative-verdict frame
    re: /\bsays?\s+more\s+about\s+.{1,40}\s+than\b/gi,
    label:
      "\"… says more about X than Y\" — a verdict frame. State the thing you actually think, without ranking their material",
  },
];

function isStaffingFact(body: string, match: RegExpMatchArray): boolean {
  const index = match.index!;
  return /(?:^|[.!?;\n])\s*(?:i|we)\s+$/i.test(body.slice(0, index))
    && /^(?:was|were)\s+the\s+only\s+(?:engineer|developer|person|team)\b/i.test(match[0])
    && /^\s+(?:on\s+call\b|assigned\s+to\b|working\s+on\b|covering\b)/i
      .test(body.slice(index + match[0].length));
}

/**
 * Return the labels of every canned house-skeleton frame present in `body`.
 * Empty array = clean. Pure; safe to call on any string.
 */
export function houseSkeletonHits(body: string): string[] {
  return HOUSE_SKELETON_FRAMES.filter((frame) =>
    [...body.matchAll(frame.re)].some((match) => !frame.staffingFact || !isStaffingFact(body, match)),
  ).map((frame) => frame.label);
}
