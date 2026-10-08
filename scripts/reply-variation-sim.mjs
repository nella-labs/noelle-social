#!/usr/bin/env node
// Reply-variation simulator — the BEFORE/AFTER measurement behind #557.
//
// It does NOT call a model. It replays the DIRECTIVE ASSIGNMENT that the
// drafters perform per lead — which shape, which register, which opening move,
// which gen-z marker, which typo — over the same seeded sequence of leads under
// the OLD rules and the NEW ones, and reports the distributions.
//
// That is the honest thing to measure here. Every one of these changes is a
// change to what the drafter is TOLD, so the spread of instructions is the
// spread the feed can possibly have. A sample of generated replies would show
// less, not more: it would confound the rules with one run's luck.
//
// The OLD side is re-implemented here rather than imported, because it no
// longer exists in the codebase. Each old rule is annotated with the commit
// that changed it so the reimplementation can be checked against the diff.
//
// IMPORTANT — WHICH WORLD THIS MEASURES. Every lead here is given a post
// ENERGY. In production that requires NOELLE_DRAFTER_ENERGY, which defaults
// OFF and is absent from the live ecosystem config, so `postEnergy` is null and
// the tone-first lane does not exist at all: every lead takes an ordinary shape
// and no register. The tone-first rows below therefore describe the stack WITH
// energy detection on. The rotation-memory, marker-rate and typo rows do not
// depend on it and hold either way.
//
// Requires the runtime to be built (pnpm --filter @noelle/runtime build): it
// imports the compiled dist directly, because the repo root is not a workspace
// package and cannot resolve the @noelle/* specifiers.
//
// Usage: node scripts/reply-variation-sim.mjs [leads]

import {
  X_FORM_VARIANTS,
  LIGHT_EXCLUDED_VARIANT_IDS,
  TONE_FIRST_SHAPE_SHARE,
  DEFAULT_ROTATION_MEMORY,
  shapesExcludedForEnergy,
  createFormVariantRotation,
  pickFormVariant,
  X_OPENING_MOVES,
  pickOpeningMove,
  SHAPES_WITH_FREE_OPENER,
  SHAPES_BANNING_QUESTIONS,
  createGenZMarkerRotation,
  DEFAULT_MARKER_RATE,
  humanizeTypos,
  TYPO_VARIANTS,
  DEFAULT_TYPO_RATE,
} from "../packages/runtime/dist/index.js";
import { pickRegisterForEnergy } from "../packages/runtime/dist/register.js";

const N = Number(process.argv[2] ?? 400);

// ---------------------------------------------------------------------------
// Deterministic RNG, so the two sides see the SAME sequence of leads and the
// same stream of random draws. Comparing them under different noise would make
// the whole table meaningless.
// ---------------------------------------------------------------------------
const makeLcg = (seed) => () => {
  // Math.imul, NOT `*`: seed * 1103515245 exceeds Number.MAX_SAFE_INTEGER,
  // so the state is ROUNDED before the modulus and the stream collapses —
  // 16403 distinct values in 20000 draws instead of 20000.
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  seed %= 2 ** 31;
  return seed / 2 ** 31;
};

// The energy mix. Roughly what the classifier labels across a real week: most
// posts are ordinary substantive ones, with a long tail of jokes, wins, vents,
// hot takes and questions.
const ENERGY_MIX = [
  ["analytical", 0.44],
  ["joke", 0.13],
  ["celebration", 0.12],
  ["hot_take", 0.11],
  ["vent", 0.11],
  ["question", 0.09],
];
const TONE_FIRST = new Set(["joke", "celebration", "vent", "hot_take"]);

function drawEnergy(r) {
  let c = 0;
  for (const [e, w] of ENERGY_MIX) {
    c += w;
    if (r < c) return e;
  }
  return "analytical";
}

// The length band each shape asks for, mirroring the directives in
// packages/runtime/src/formVariants.ts (X_FORM_VARIANTS). Kept as a table
// because the directives state their bands in prose, in several formats.
// Asserted complete below, so a new shape cannot silently skip the report.
const BANDS = {
  MICRO: [4, 45],
  ONE_SHORT: [30, 80],
  HOOK_THEN_LINE: [50, 130],
  QUESTION_ONLY: [40, 120],
  OBSERVE_ASK: [120, 200],
  TWO_FLAT: [100, 180],
  RUN_ON: [160, 230],
  ASIDE: [60, 160],
  THREE_BEAT: [190, 240],
  DETAIL_ZOOM: [90, 200],
  RIFF: [15, 90],
  FLAT_DISAGREE: [60, 140],
};
// The band a lead lands in when it gets NO shape: the drafter's own default
// budget in SYSTEM_X_BASE ("Target 40-120 characters. Hard ceiling 150.").
const NO_SHAPE_BAND = [40, 120];

for (const v of X_FORM_VARIANTS) {
  if (!BANDS[v.id]) {
    console.error(`shape ${v.id} has no band in the report table`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// The two rule sets.
// ---------------------------------------------------------------------------

/**
 * The opening move, shared by both sides because this rule did NOT change in
 * #557: a move is injected only for shapes that leave the opener free, and the
 * QUESTION move is filtered out for shapes whose directive forbids a question.
 * Modelling it on one side only would flatter that side.
 */
function openingMove(shape, rng) {
  if (shape && !SHAPES_WITH_FREE_OPENER.includes(shape.id)) return null;
  const pool =
    shape && SHAPES_BANNING_QUESTIONS.includes(shape.id)
      ? X_OPENING_MOVES.filter((m) => m.id !== "QUESTION")
      : X_OPENING_MOVES;
  return pickOpeningMove(rng, pool).id;
}

/**
 * BEFORE. Rotation memory 1 (only the previous shape excluded). A tone-first
 * energy gets a register and NO shape. No gen-z lane.
 */
function makeBefore() {
  let lastId = null;
  return (energy, rng, isLight) => {
    const toneFirst = TONE_FIRST.has(energy);
    let shape = null;
    if (!toneFirst) {
      const exclude = [...(isLight ? LIGHT_EXCLUDED_VARIANT_IDS : []), ...(lastId ? [lastId] : [])];
      shape = pickFormVariant(rng, exclude, X_FORM_VARIANTS);
      lastId = shape.id;
    }
    const register = shape ? null : pickRegisterForEnergy(energy, rng).id;
    const move = openingMove(shape, rng);
    return { shape: shape?.id ?? null, register, move, marker: null };
  };
}

/**
 * AFTER. Rotation memory 3. Half of the tone-first leads take an
 * energy-scoped shape. A separate rated gen-z marker lane.
 */
function makeAfter() {
  const rotation = createFormVariantRotation(X_FORM_VARIANTS);
  const markers = createGenZMarkerRotation(4, { platform: "x" });
  return (energy, rng, isLight) => {
    const toneFirst = TONE_FIRST.has(energy);
    const toneFirstShape = toneFirst && rng() < TONE_FIRST_SHAPE_SHARE;
    let shape = null;
    if (!toneFirst || toneFirstShape) {
      shape = rotation.next(rng, [
        ...(isLight ? LIGHT_EXCLUDED_VARIANT_IDS : []),
        ...(toneFirstShape ? shapesExcludedForEnergy(energy, X_FORM_VARIANTS) : []),
      ]);
    }
    const register = shape ? null : pickRegisterForEnergy(energy, rng).id;
    const move = openingMove(shape, rng);
    const marker = rng() < DEFAULT_MARKER_RATE ? (markers.next(rng, energy)?.id ?? null) : null;
    return { shape: shape?.id ?? null, register, move, marker };
  };
}

function run(makeRules, seed) {
  const rng = makeLcg(seed);
  const leadRng = makeLcg(seed + 7919);
  const rules = makeRules();
  const rows = [];
  for (let i = 0; i < N; i++) {
    const energy = drawEnergy(leadRng());
    const isLight = energy === "celebration";
    rows.push({ energy, ...rules(energy, rng, isLight) });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Measures.
// ---------------------------------------------------------------------------
const pct = (n, d) => `${((100 * n) / d).toFixed(1)}%`;

function shannon(counts) {
