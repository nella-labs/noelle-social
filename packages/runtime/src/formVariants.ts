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
    id: "THREE_BEAT",
    weight: 0.06,
    directive:
      "Two to three sentences, ~190 to 240 characters, the fullest form this reply may take: a reaction, one concrete point, and a closing thought or question. Weave connectors (and, but, so, because) into at least two of the sentences so it flows like talk, never staccato. Stay under 240 characters.",
  },
  {
    id: "DETAIL_ZOOM",
    weight: 0.06,
    directive:
      "Zoom in on ONE small, specific detail from the post (a number, a choice, something in the image), name it in your own words, then say what it would MEAN or COST in practice. Do NOT make the detail the subject of a verdict about itself ('the X line is the part that stuck with me', 'X is doing a lot of work'), because that is the house skeleton. Put yourself or the consequence in the predicate. One to two sentences, no question.",
  },
  // --- X-only shapes ---------------------------------------------------------
  // The mirror of Lyra's SELF_STORY / AGREE_EXTEND: the two sets deliberately do
  // NOT share a full skeleton list any more, because they were producing the
  // same reply in two lengths. X rewards the two moves LinkedIn punishes — being
  // funny, and disagreeing flat in public.
  {
    id: "RIFF",
    weight: 0.08,
    directive:
      "Answer with the joke, and nothing else. A riff, a jab back, a one-line bit that is IN on whatever they are doing. Under ~90 characters. No analysis, no lesson, no question, no 'but seriously'. If the post is not funny and there is no honest bit to be made, this shape does not apply, so write one flat specific sentence instead.",
  },
  {
    id: "FLAT_DISAGREE",
    weight: 0.07,
    directive:
      "Disagree, flat, in your own words: contradict the claim, give the ONE reason, stop. ~60 to 140 characters. No question, no hedging, no 'I think', no softening clause at the end, and never assemble it out of phrasings from this prompt. Only if you genuinely disagree, because manufactured disagreement is worse than agreement.",
  },
];

// ---- Energy-scoped shape subsets -------------------------------------------
// The drafters treat four post energies as "tone first" (joke, celebration,
// vent, hot take) and hand those leads a REGISTER instead of a shape, on the
// grounds that mirroring the tone matters more than varying the form. The cost
// was not obvious until the feed was read end to end: those four energies are a
// large share of leads, and every one of them came out with no shape assigned
// at all, so they all landed in the drafter's default length band. Tone varied,
// form did not.
//
// These subsets are the fix. A tone-first lead can now be given a shape drawn
// only from the shapes that can actually CARRY its energy, while the separate
// energy HINT (renderEnergyHint) keeps doing the tone mirroring.
//
// It is an ALLOWLIST, so every shape not named is excluded and the notes below
// name only the exclusions that are DELIBERATE, not all of them. That matters
// when adding a shape: a new entry in a variant set is unreachable on every
// tone-first energy until it is added here too, and shapesForEnergy cannot tell
// "left out on purpose" from "forgotten". The test below asserts every energy
// still reaches MIN_ENERGY_POOL shapes; nothing can assert a NEW shape was
// considered, so consider it here. The deliberate ones:
//   • celebration excludes FLAT_DISAGREE and DETAIL_ZOOM — you cannot disagree
//     with someone's launch, and grading a detail of it is not a congrats.
//   • vent excludes RIFF (joking at someone venting), FLAT_DISAGREE, and
//     QUESTION_ONLY (they are not asking).
//   • joke keeps only the shapes that can be funny; an OBSERVE_ASK or a
//     THREE_BEAT under a shitpost is the bot tell the energy system exists for.
//   • hot_take keeps the flat, declarative shapes; that is what answering a
//     spicy opinion looks like.
// Ids are listed platform-neutrally and filtered against whatever variant set
// the caller passes, so Lyra's SELF_STORY/AGREE_EXTEND and Vega's
// RIFF/FLAT_DISAGREE each resolve against their own list.
/**
 * The energies the drafters treat as "tone first" — where mirroring the TONE
 * can matter more than varying the form, so the lead may take the register
 * instead of a shape (see TONE_FIRST_SHAPE_SHARE).
 *
 * Lives HERE, next to ENERGY_SHAPE_IDS, because the two must agree: a tone-first
 * energy with no entry in that table gets an unscoped rotation, since
 * shapesForEnergy fails open. It was a verbatim copy in each drafter, which is
 * the same shape of bug as Orion's drifted opening-move copy that this work
 * already had to fix once.
 */
export const TONE_FIRST_ENERGIES: ReadonlySet<string> = new Set([
  "joke",
  "celebration",
  "vent",
  "hot_take",
]);

export const ENERGY_SHAPE_IDS: Record<string, readonly string[]> = {
  // OBSERVE_ASK is here rather than nowhere: naming one concrete thing they did
  // and asking a genuine follow-up ("you did the migration solo? how long did
  // that take") is a warm, engaged congrats. It is not a bare question, which is
  // what LIGHT_EXCLUDED_VARIANT_IDS keeps off a win.
  celebration: ["MICRO", "ONE_SHORT", "HOOK_THEN_LINE", "ASIDE", "RUN_ON", "RIFF", "AGREE_EXTEND", "SELF_STORY", "OBSERVE_ASK"],
  joke: ["RIFF", "MICRO", "ONE_SHORT", "ASIDE", "HOOK_THEN_LINE"],
  vent: ["MICRO", "ONE_SHORT", "TWO_FLAT", "RUN_ON", "SELF_STORY", "AGREE_EXTEND", "ASIDE"],
  // QUESTION_ONLY lives here and nowhere else in this table. A bare, specific
  // question is a real answer to a spicy claim ("what's the failure rate that
  // made you say that?") in a way it is not to a launch, a vent, or a joke —
  // and without it the shape was unreachable on EVERY tone-first energy, which
  // was the sum of four separate choices rather than anyone's decision.
  // THREE_BEAT is the longest shape in every set, which is wrong under a joke or
  // a vent and right here: a spicy claim is the one tone-first post that earns a
  // full reaction-point-close counter.
  hot_take: ["FLAT_DISAGREE", "ONE_SHORT", "TWO_FLAT", "MICRO", "RUN_ON", "DETAIL_ZOOM", "QUESTION_ONLY", "THREE_BEAT"],
};

/**
 * The smallest energy-scoped pool worth using. Below this there is barely a
 * choice, and a subset of one would be a fixed shape for that whole energy —
 * the exact failure this table exists to remove. Falls back to the full set.
 */
const MIN_ENERGY_POOL = 3;

/**
 * The shapes that may carry `energy`, filtered against `variants`.
 *
 * Fails OPEN: an unknown energy, or a subset that resolves to fewer than
 * MIN_ENERGY_POOL shapes against this platform's variant list, returns the full
 * set. A too-narrow subset is worse than none.
 */
export function shapesForEnergy(
  energy: string | null | undefined,
  variants: readonly FormVariant[] = FORM_VARIANTS,
): readonly FormVariant[] {
  const all = variants.length > 0 ? variants : FORM_VARIANTS;
  if (!energy) return all;
  const ids = ENERGY_SHAPE_IDS[energy];
  if (!ids) return all;
  const pool = all.filter((v) => ids.includes(v.id));
  return pool.length >= MIN_ENERGY_POOL ? pool : all;
}

/**
 * The ids to EXCLUDE so a rotation pick lands inside `energy`'s subset.
 *
 * Expressed as an exclusion rather than as a pool so callers can keep using
 * their single long-lived rotation — and therefore its no-repeat memory —
 * instead of constructing a throwaway rotation per energy, which would have no
 * memory at all and would happily repeat a shape every tick.
 *
 * Returns [] when shapesForEnergy fell open, so an unknown energy excludes
 * nothing rather than everything.
 */
export function shapesExcludedForEnergy(
  energy: string | null | undefined,
  variants: readonly FormVariant[] = FORM_VARIANTS,
): string[] {
  const all = variants.length > 0 ? variants : FORM_VARIANTS;
  const pool = shapesForEnergy(energy, all);
  if (pool.length === all.length) return [];
  const keep = new Set(pool.map((v) => v.id));
  return all.filter((v) => !keep.has(v.id)).map((v) => v.id);
}

/**
 * Share of tone-first leads that get an energy-scoped SHAPE instead of a
 * register. The two remain mutually exclusive — each claims authority over
 * reply length, and two contradicting length rules in one prompt is how drafts
 * get squeezed — so this splits the lane rather than combining them.
 *
 * At 0.5 a joke lead is as likely to be shaped as to be registered, which is
 * what breaks the single length band, while half of them still get the louder
 * tone directive (HYPE's CAPS, DEADPAN's dryness) that a shape cannot express.
 */
export const TONE_FIRST_SHAPE_SHARE = 0.5;

// Orion's (Reddit) variant set. Derived from the X set, with ONE deliberate
// difference, and it exists because of a difference in CONSEQUENCE rather than
// in taste: a Reddit reply that reaches the approvals queue is treated as
// approved and AUTO-SENT by the actuator (Skip is the veto). There is no human
// between the draft and the subreddit.
//
// MICRO on X licenses a one-word reply, and a bare "brutal" is genuinely native
// there. Auto-posted to r/programming it is a drive-by: automod removes it, it
// gets downvoted, and it costs the account standing, with nobody in the loop to
// catch it. It was also the single heaviest weight in the X set (.12), so it
// would have been the most common thing Orion said.
//
// So Reddit's MICRO keeps the shape but takes a floor of three words, and its
// weight drops from .12 to .05. The freed weight goes to the mid-length shapes
// Reddit actually rewards. Everything else is X's, because both rooms reward
// being funny (RIFF) and disagreeing flat (FLAT_DISAGREE), which LinkedIn
// punishes. Weights sum to 1.00 exactly:
//   MICRO .05 + ONE_SHORT .10 + HOOK_THEN_LINE .10 + QUESTION_ONLY .09 +
//   OBSERVE_ASK .10 + TWO_FLAT .10 + RUN_ON .09 + ASIDE .07 + THREE_BEAT .08 +
//   DETAIL_ZOOM .07 + RIFF .08 + FLAT_DISAGREE .07 = 1.00
const REDDIT_WEIGHTS: Record<string, number> = {
  MICRO: 0.05,
  ONE_SHORT: 0.1,
  HOOK_THEN_LINE: 0.1,
  QUESTION_ONLY: 0.09,
  OBSERVE_ASK: 0.1,
  TWO_FLAT: 0.1,
  RUN_ON: 0.09,
  ASIDE: 0.07,
  THREE_BEAT: 0.08,
  DETAIL_ZOOM: 0.07,
  RIFF: 0.08,
  FLAT_DISAGREE: 0.07,
};

const REDDIT_MICRO_DIRECTIVE =
  "One tiny reaction, between THREE and 10 words, lowercase, on a single line. It must still carry a reaction to something specific in the post ('that retry loop is genuinely cursed', 'eaten by wolves is wild'). NEVER a single word, and never bare agreement with no content ('true', 'same', '100%', 'exactly') — this comment is posted without a human reading it first, and a one-word drive-by is what automod removes. No second line, no question.";

/** Orion's set: X's shapes, with MICRO floored at three words and down-weighted. */
export const REDDIT_FORM_VARIANTS: FormVariant[] = X_FORM_VARIANTS.map((v) => ({
  ...v,
  allowStandaloneReaction: false,
