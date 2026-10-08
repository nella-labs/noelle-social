// Account Feeder — per-reply FORM VARIANTS for faithful-voice drafting.
//
// PROBLEM: when the operator pins a faithful voice, renderStyleBlock's faithful
// branch used to prescribe ONE fixed shape ("open with a 3-8 word hook, then one
// line, one or two short sentences") — so every reply in the feed came out the
// same length (~110-235 chars), the same 1-2 sentence rhythm, the same
// hook-then-line skeleton. Registers/opening moves couldn't fix it because the
// faithful recipe overrode them.
//
// FIX: a curated set of SHAPE variants (micro one-liner → single short
// sentence → question-only → run-on → a fuller 2-3 beat take). Per reply the
// drafter picks ONE by weighted random choice, EXCLUDING the variant used for
// the previous pick (the rotation never picks the same shape twice in a row),
// and the faithful style block renders the picked variant's directive IN PLACE
// of the old fixed recipe. Voice stays the pinned writer's; only the shape
// rotates.
//
// Pure + unit-testable: pickFormVariant takes an injectable rng and an optional
// excludeId (the previous reply's variant). Shared via @noelle/runtime: Lyra
// rotates FORM_VARIANTS, Vega rotates X_FORM_VARIANTS (same machinery, lengths
// retuned for X's 280-char ceiling — see X_FORM_VARIANTS).

/** One shape variant as the faithful style block renders it. */
export interface FormVariant {
  id: string;
  /** Weight in (0,1]; the weights across all variants sum to 1. */
  weight: number;
  /** The "ASSIGNED SHAPE" directive rendered into the faithful style block. */
  directive: string;
  /** The platform permits a complete brief reaction without explanatory padding. */
  allowStandaloneReaction?: boolean;
}

/** The subset of FormVariant that travels inside StyleForPrompt. */
export interface FormVariantForPrompt {
  id: string;
  directive: string;
  allowStandaloneReaction?: boolean;
}

// Lyra's (LinkedIn) variant set. Weights sum to 1.00 exactly. Lengths spread
// from ~30 chars to ~320 chars so the feed stops reading as one band:
//   MICRO .07 + ONE_SHORT .10 + HOOK_THEN_LINE .10 + QUESTION_ONLY .09 +
//   OBSERVE_ASK .09 + TWO_FLAT .09 + RUN_ON .11 + ASIDE .07 + THREE_BEAT .08 +
//   DETAIL_ZOOM .06 + SELF_STORY .09 + AGREE_EXTEND .05 = 1.00
// The shorter shapes are weighted DOWN relative to Vega's set and the
// self-referential ones UP: a bare one-word reply is native on X and reads as a
// drive-by on LinkedIn.
// Every directive stays inside the NEVER-DO rules (no staccato fragments, no
// echoing the post, no em dashes) — a variant changes shape, never discipline.
export const FORM_VARIANTS: FormVariant[] = [
  {
    id: "MICRO",
    weight: 0.07,
    directive:
      "One tiny reaction, 3 to 8 words total, lowercase, on a single line. No second line, no question. It should read like a quick real-person aside, not a summary.",
  },
  {
    id: "ONE_SHORT",
    weight: 0.1,
    directive:
      "Exactly ONE short full sentence (subject and verb), under 80 characters: a flat, specific take. No question, no second clause bolted on.",
  },
  {
    id: "HOOK_THEN_LINE",
    weight: 0.1,
    directive:
      "Open with a short punchy reaction (3 to 8 words), then ONE line that actually adds something. Two beats total, nothing more.",
  },
  {
    id: "QUESTION_ONLY",
    weight: 0.09,
    directive:
      "The whole reply is ONE genuine, specific question the post actually raises for you, under ~120 characters. No preamble before it, no take after it.",
  },
  {
    id: "OBSERVE_ASK",
    weight: 0.09,
    directive:
      "One concrete observation about a specific detail, then a short follow-up question. Two sentences, ~150 to 220 characters total.",
  },
  {
    id: "TWO_FLAT",
    weight: 0.09,
    directive:
      "Two plain sentences with no question anywhere: your take, then the reason you hold it. ~120 to 200 characters, glue clauses with connectors (and, but, so) so it reads spoken, not clipped.",
  },
  {
    id: "RUN_ON",
    weight: 0.11,
    directive:
      "ONE longer run-on sentence, ~180 to 260 characters, clauses glued with commas and connectors (and, but, so), thinking out loud the way people actually type. No question mark.",
  },
  {
    id: "ASIDE",
    weight: 0.07,
    directive:
      "One or two sentences where a (parenthetical aside) carries the humor or the sharpest point. Keep the aside short and let it do the work.",
  },
  {
    id: "THREE_BEAT",
    weight: 0.08,
    directive:
      "Two to three sentences, ~220 to 320 characters, the fullest form: a reaction, one concrete point, and a closing thought or question. Weave connectors (and, but, so, because) into at least two of the sentences so it flows like talk, never staccato.",
  },
  {
    id: "DETAIL_ZOOM",
    weight: 0.06,
    directive:
      "Zoom in on ONE small, specific detail from the post (a number, a choice, something in the image), name it in your own words, then say what it would MEAN or COST in practice. Do NOT make the detail the subject of a verdict about itself ('the X line is the part that stuck with me', 'X is doing a lot of work'), because that is the house skeleton. Put yourself or the consequence in the predicate. One to two sentences, no question.",
  },
  // --- LinkedIn-only shapes -------------------------------------------------
  // Lyra and Vega were running the SAME ten skeletons with different length
  // bands, which is a large part of why the two feeds read as one writer. These
  // two exist only here because they are what the LinkedIn room actually
  // rewards: a peer volunteering their own experience, and plain agreement that
  // adds something rather than performing a take.
  {
    id: "SELF_STORY",
    weight: 0.09,
    directive:
      "Two sentences about what YOU did in the same spot, or what it cost you. You are the subject of both sentences and their post is never the subject of either. ~150 to 260 characters, glued with connectors so it reads spoken. No question, no verdict on their post. Only if it is TRUE, and never invent an experience to fit.",
  },
  {
    id: "AGREE_EXTEND",
    weight: 0.05,
    directive:
      "Agree in four words or fewer, then add ONE concrete thing from your side that they did not have: a number, a constraint, what broke. Two beats, ~90 to 170 characters. No question. The agreement must be flat and specific, never 'so true' / 'this' / 'love this'.",
  },
];

// The X-tuned variant set (Vega). Same ten shapes, three deliberate deltas from
// the LinkedIn set because X is a different room:
//   1. X hard-caps a reply at 280 chars, so the long shapes are pulled in
//      (THREE_BEAT 220-320 → 200-260, RUN_ON 180-260 → 160-230) — a Lyra-length
//      THREE_BEAT would simply be truncated on X.
//   2. MICRO goes down to ONE word. A bare "facts", "same", or "brutal" is a
//      completely native X reply and reads as a real person; on LinkedIn it
//      reads as a drive-by.
//   3. Weights lean shorter overall (MICRO/ONE_SHORT/HOOK_THEN_LINE = .32 vs
//      Lyra's .27, THREE_BEAT down to .06) because X replies skew short.
//   4. Two shapes Lyra does not have (RIFF, FLAT_DISAGREE) in place of her
//      SELF_STORY / AGREE_EXTEND, so the two feeds no longer draw from one
//      skeleton list.
// Weights sum to 1.00 exactly:
//   MICRO .12 + ONE_SHORT .10 + HOOK_THEN_LINE .10 + QUESTION_ONLY .09 +
//   OBSERVE_ASK .08 + TWO_FLAT .08 + RUN_ON .09 + ASIDE .07 + THREE_BEAT .06 +
//   DETAIL_ZOOM .06 + RIFF .08 + FLAT_DISAGREE .07 = 1.00
export const X_FORM_VARIANTS: FormVariant[] = [
  {
    id: "MICRO",
    weight: 0.12,
    allowStandaloneReaction: true,
    directive:
      "One tiny reaction, between ONE and 8 words total, lowercase, on a single line. Even a single word is a good reply here when it fits the moment ('brutal', 'same', 'so real', 'skill issue'). No second line, no question, no explanation after it. Do not pad a complete reaction just to name a detail from the post.",
  },
  {
    id: "ONE_SHORT",
    weight: 0.1,
    allowStandaloneReaction: true,
    directive:
      "Exactly ONE short full sentence (subject and verb), under 80 characters: a direct reaction or take. No question, no second clause bolted on. Do not add an explanation just to make a complete reaction sound more specific.",
  },
  {
    id: "HOOK_THEN_LINE",
    weight: 0.1,
    directive:
      "Open with a short punchy reaction (3 to 8 words), then ONE line that actually adds something. Two beats total, nothing more.",
  },
  {
    id: "QUESTION_ONLY",
    weight: 0.09,
    directive:
      "The whole reply is ONE genuine, specific question the post actually raises for you, under ~120 characters. No preamble before it, no take after it.",
  },
  {
    id: "OBSERVE_ASK",
    weight: 0.08,
    directive:
      "One concrete observation about a specific detail, then a short follow-up question. Two sentences, ~120 to 200 characters total.",
  },
  {
    id: "TWO_FLAT",
    weight: 0.08,
    directive:
      "Two plain sentences with no question anywhere: your take, then the reason you hold it. ~100 to 180 characters, glue clauses with connectors (and, but, so) so it reads spoken, not clipped.",
  },
  {
    id: "RUN_ON",
    weight: 0.09,
    directive:
      "ONE longer run-on sentence, ~160 to 230 characters, clauses glued with commas and connectors (and, but, so), thinking out loud the way people actually type. No question mark.",
  },
  {
    id: "ASIDE",
    weight: 0.07,
    directive:
      "One or two sentences where a (parenthetical aside) carries the humor or the sharpest point. Keep the aside short and let it do the work.",
  },
  {
