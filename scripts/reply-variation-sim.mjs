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
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  return -counts
    .filter((c) => c > 0)
    .reduce((h, c) => h + (c / total) * Math.log2(c / total), 0);
}

function measure(rows) {
  const noShape = rows.filter((r) => !r.shape).length;
  const shapeCounts = new Map();
  for (const r of rows) shapeCounts.set(r.shape ?? "(none)", (shapeCounts.get(r.shape ?? "(none)") ?? 0) + 1);

  // A/B/A/B alternations: x,y,x,y in four consecutive leads. Reported per
  // 20,000 picks by alternationRate() below rather than over this run's few
  // hundred leads — the event is rare enough (~9 per 1000 at memory 1) that a
  // 400-lead sample routinely shows zero on BOTH sides and reads as "no
  // difference" when there is a total one.
  let alternations = 0;
  for (let i = 3; i < rows.length; i++) {
    if (rows[i].shape && rows[i].shape === rows[i - 2].shape && rows[i - 1].shape === rows[i - 3].shape) {
      alternations++;
    }
  }

  // Distinct full directive stacks — the real combinatorial variety.
  const stacks = new Set(rows.map((r) => `${r.shape ?? "R:" + r.register}|${r.move ?? "-"}|${r.marker ?? "-"}`));

  // Length bands: midpoint of whatever the lead was told to write.
  const mids = rows.map((r) => {
    const [lo, hi] = r.shape ? BANDS[r.shape] : NO_SHAPE_BAND;
    return (lo + hi) / 2;
  });
  const sorted = [...mids].sort((a, b) => a - b);
  const mean = mids.reduce((a, b) => a + b, 0) / mids.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  const sd = Math.sqrt(mids.reduce((a, m) => a + (m - mean) ** 2, 0) / mids.length);

  // How concentrated is the feed in one 40-char window?
  const buckets = new Map();
  for (const m of mids) {
    const b = Math.floor(m / 40) * 40;
    buckets.set(b, (buckets.get(b) ?? 0) + 1);
  }
  const biggestBucket = Math.max(...buckets.values());

  // Tone-first leads specifically: how many of them got any form direction?
  const toneRows = rows.filter((r) => TONE_FIRST.has(r.energy));
  const toneShaped = toneRows.filter((r) => r.shape).length;

  return {
    noShape,
    noShapePct: pct(noShape, rows.length),
    distinctShapes: [...shapeCounts.keys()].filter((k) => k !== "(none)").length,
    shapeEntropy: shannon([...shapeCounts.values()]).toFixed(2),
    alternations,
    stacks: stacks.size,
    mean: mean.toFixed(0),
    median: median.toFixed(0),
    sd: sd.toFixed(0),
    biggestBucketPct: pct(biggestBucket, rows.length),
    toneShapedPct: pct(toneShaped, toneRows.length),
    markerPct: pct(rows.filter((r) => r.marker).length, rows.length),
    distinctMarkers: new Set(rows.filter((r) => r.marker).map((r) => r.marker)).size,
  };
}

// ---------------------------------------------------------------------------
// Typo pass, measured separately: it runs on the finished body, not on the
// prompt. The OLD variant list is inlined because it no longer exists.
// ---------------------------------------------------------------------------
const OLD_TYPO_RATE = 0.1;
const OLD_TYPO_KIND_COUNT = 5; // DROP_WORD, DROP_APOSTROPHE, TRANSPOSE, DROP_LETTER, DOUBLE_WORD

const BODIES = [
  "the migration ran clean but the rollback still scares me honestly",
  "i kept the queue at ten and it still fell over on the second batch",
  "we shipped it on friday which was a choice, and monday proved it",
  "the agent re-read the whole repo every single time, that was the bill",
  "nobody told me the retry was infinite until the invoice showed up",
  "spent four hours on a config flag that was already set correctly",
];

/**
 * Share of bodies that come out with a slip applied, at a given nominal rate.
 *
 * This measures the RATE change only, and it runs the CURRENT engine on both
 * sides on purpose. An earlier version ran the current engine at the old rate
 * and then discarded any slip of a newly-added kind, which quietly understated
 * the before side (6.7% against a nominal 10%) by dropping 27% of the weight
 * on the floor instead of redistributing it. The kind COUNT is reported
 * separately, straight from the constants, where it is not a sampling result.
 *
 * The applied share sits below the nominal rate on both sides for a real
 * reason: humanizeTypos declines bodies under MIN_WORDS/MIN_CHARS and declines
 * any body where no kind finds an eligible token.
 */
function typoRun(rate) {
  let hit = 0;
  const N_T = 4000;
  for (let i = 0; i < N_T; i++) {
    const body = BODIES[i % BODIES.length];
    const out = humanizeTypos(body, { rate, rng: makeLcg(i + 1) });
    if (out.applied) hit++;
  }
  return pct(hit, N_T);
}


/**
 * A/B/A/B alternation rate per 20,000 picks, measured on the rotation directly.
 * This is the headline claim for the memory widening, and it needs a sample the
 * lead-level run does not have.
 */
function alternationRate(memory) {
  const rng = makeLcg(20260824);
  const ids = [];
  const N_A = 20000;
  if (memory === 1) {
    let last = null;
    for (let i = 0; i < N_A; i++) {
      const v = pickFormVariant(rng, last, X_FORM_VARIANTS);
      last = v.id;
      ids.push(v.id);
    }
  } else {
    const rotation = createFormVariantRotation(X_FORM_VARIANTS);
    for (let i = 0; i < N_A; i++) ids.push(rotation.next(rng).id);
  }
  let a = 0;
  for (let i = 3; i < ids.length; i++) if (ids[i] === ids[i - 2] && ids[i - 1] === ids[i - 3]) a++;
  return a;
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------
const before = measure(run(makeBefore, 20260824));
const after = measure(run(makeAfter, 20260824));
const tBefore = typoRun(OLD_TYPO_RATE);
const tAfter = typoRun(DEFAULT_TYPO_RATE);

const row = (label, b, a) => `| ${label} | ${b} | ${a} |`;

console.log(`\n### Vega (X), ${N} simulated leads, same seed on both sides`);
console.log("Energy detection assumed ON. It is OFF by default in prod (NOELLE_DRAFTER_ENERGY),");
console.log("where postEnergy is null and the tone-first rows do not apply.\n");
console.log("| measure | before | after |");
console.log("|---|---|---|");
console.log(row("leads with NO shape assigned", before.noShapePct, after.noShapePct));
console.log(row("tone-first leads given any form direction", before.toneShapedPct, after.toneShapedPct));
console.log(row("distinct shapes used", before.distinctShapes, after.distinctShapes));
console.log(row("shape entropy (bits, max 3.58)", before.shapeEntropy, after.shapeEntropy));
console.log(row("A/B/A/B alternations per 20k picks", alternationRate(1), alternationRate(3)));
console.log(row("distinct directive stacks", `${before.stacks} / ${N}`, `${after.stacks} / ${N}`));
console.log(row("target length: mean", `${before.mean} ch`, `${after.mean} ch`));
console.log(row("target length: median", `${before.median} ch`, `${after.median} ch`));
console.log(row("target length: spread (sd)", `${before.sd} ch`, `${after.sd} ch`));
console.log(row("biggest single 40-char band", before.biggestBucketPct, after.biggestBucketPct));
console.log(row("replies offered a gen-z marker", before.markerPct, after.markerPct));
console.log(row("distinct gen-z markers used", before.distinctMarkers, after.distinctMarkers));
console.log(row("replies that receive a typo", tBefore, tAfter));
console.log(row("typo kinds available", OLD_TYPO_KIND_COUNT, TYPO_VARIANTS.length));
console.log(`\nrotation memory: 1 -> ${DEFAULT_ROTATION_MEMORY}   tone-first shape share: 0 -> ${TONE_FIRST_SHAPE_SHARE}`);
console.log(`typo rate: ${OLD_TYPO_RATE} -> ${DEFAULT_TYPO_RATE}   typo kinds: ${OLD_TYPO_KIND_COUNT} -> ${TYPO_VARIANTS.length}\n`);

// ---------------------------------------------------------------------------
// Per-lead sample: what the drafter is actually TOLD, lead by lead, on each
// side. The aggregate table says the spread widened; this says what that looks
// like on the ground.
// ---------------------------------------------------------------------------
if (process.argv.includes("--samples")) {
  const b = run(makeBefore, 20260824).slice(0, 14);
  const a = run(makeAfter, 20260824).slice(0, 14);
  const stack = (r) => {
    const parts = [r.shape ? `shape:${r.shape}` : `register:${r.register}`];
    if (r.move) parts.push(`open:${r.move}`);
    if (r.marker) parts.push(`marker:${r.marker}`);
    return parts.join(" + ");
  };
  console.log("### Lead by lead, same 14 leads\n");
  console.log("| # | post energy | before | after |");
  console.log("|---|---|---|---|");
  for (let i = 0; i < b.length; i++) {
    console.log(`| ${i + 1} | ${b[i].energy} | ${stack(b[i])} | ${stack(a[i])} |`);
  }
  console.log("");
}
