import { describe, it, expect } from "vitest";
import {
  FORM_VARIANTS,
  X_FORM_VARIANTS,
  REDDIT_FORM_VARIANTS,
  TONE_FIRST_ENERGIES,
  STANCE_SHAPE_IDS,
  LIGHT_EXCLUDED_VARIANT_IDS,
  SHAPES_WITH_FREE_OPENER,
  DEFAULT_ROTATION_MEMORY,
  ENERGY_SHAPE_IDS,
  TONE_FIRST_SHAPE_SHARE,
  shapesForEnergy,
  shapesExcludedForEnergy,
  pickFormVariant,
  createFormVariantRotation,
  renderAssignedShapeBlock,
} from "./formVariants.js";
import { renderStyleBlock, type StyleForPrompt } from "./styleBlock.js";

// Deterministic LCG so frequency/rotation tests are stable but walk the range.
const makeLcg = (seed: number) => () => {
  // Math.imul, NOT `*`: seed * 1103515245 exceeds Number.MAX_SAFE_INTEGER,
  // so the state is ROUNDED before the modulus and the stream collapses —
  // 16403 distinct values in 20000 draws instead of 20000.
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  seed %= 2 ** 31;
  return seed / 2 ** 31;
};

describe("FORM_VARIANTS", () => {
  it("has exactly 12 variants with unique ids and non-empty directives", () => {
    expect(FORM_VARIANTS).toHaveLength(12);
    const ids = FORM_VARIANTS.map((v) => v.id);
    expect(new Set(ids).size).toBe(12);
    for (const v of FORM_VARIANTS) {
      expect(v.directive.trim().length).toBeGreaterThan(20);
      expect(v.weight).toBeGreaterThan(0);
      expect(v.weight).toBeLessThanOrEqual(1);
    }
  });

  it("weights sum to 1.00", () => {
    const sum = FORM_VARIANTS.reduce((acc, v) => acc + v.weight, 0);
    expect(sum).toBeCloseTo(1.0, 10);
  });

  it("spreads lengths: at least one micro form and at least one 300+ char form", () => {
    expect(FORM_VARIANTS.some((v) => v.directive.includes("3 to 8 words"))).toBe(true);
    expect(FORM_VARIANTS.some((v) => v.directive.includes("320"))).toBe(true);
  });

  it("no directive models banned punctuation (em/en dashes, double hyphen)", () => {
    // The style block bans em dashes two lines below where the directive
    // renders, and the verifier hard-zeros any draft containing one — a
    // directive that models the banned char invites the model to echo it.
    for (const v of FORM_VARIANTS) {
      expect(v.directive).not.toMatch(/[—–―]|--/);
    }
  });
});

describe("pickFormVariant", () => {
  it("maps a swept rng over the full set when nothing is excluded", () => {
    const seen = new Set<string>();
    for (let r = 0.001; r < 1; r += 0.002) {
      seen.add(pickFormVariant(() => r).id);
    }
    expect(seen.size).toBe(12);
  });

  it("never returns the excluded id, and the other 11 all stay reachable", () => {
    for (const excluded of FORM_VARIANTS.map((v) => v.id)) {
      const seen = new Set<string>();
      for (let r = 0.001; r < 1; r += 0.002) {
        seen.add(pickFormVariant(() => r, excluded).id);
      }
      expect(seen.has(excluded)).toBe(false);
      expect(seen.size).toBe(11);
    }
  });

  it("respects weights: observed frequencies track the declared weights", () => {
    const rng = makeLcg(7);
    const counts = new Map<string, number>();
    const N = 20000;
    for (let i = 0; i < N; i++) {
      const id = pickFormVariant(rng).id;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    for (const v of FORM_VARIANTS) {
      const freq = (counts.get(v.id) ?? 0) / N;
      // A uniform pick would put every variant at 0.10; the 0.02 tolerance
      // separates 0.08 and 0.12 weights from that, so a weight-ignoring
      // regression fails this test.
      expect(Math.abs(freq - v.weight)).toBeLessThan(0.02);
    }
  });

  it("accepts a list of exclusions (light lane) and never returns any of them", () => {
    for (let r = 0.001; r < 1; r += 0.002) {
      const picked = pickFormVariant(() => r, LIGHT_EXCLUDED_VARIANT_IDS);
      expect(LIGHT_EXCLUDED_VARIANT_IDS).not.toContain(picked.id);
    }
  });

  it("falls back to the last candidate on a pathological rng (r >= 1)", () => {
    const picked = pickFormVariant(() => 1.5);
    expect(picked.id).toBe(FORM_VARIANTS[FORM_VARIANTS.length - 1]!.id);
  });

  it("samples the full set when excludeId matches nothing", () => {
    const seen = new Set<string>();
    for (let r = 0.001; r < 1; r += 0.002) {
      seen.add(pickFormVariant(() => r, "NOT_A_VARIANT").id);
    }
    expect(seen.size).toBe(12);
  });
});

describe("REDDIT_FORM_VARIANTS", () => {
  it("has the same shapes as X with weights summing to 1.00", () => {
    expect(REDDIT_FORM_VARIANTS.map((v) => v.id)).toEqual(X_FORM_VARIANTS.map((v) => v.id));
    expect(REDDIT_FORM_VARIANTS.reduce((a, v) => a + v.weight, 0)).toBeCloseTo(1.0, 10);
  });

  it("never licenses a ONE-WORD comment, because Reddit auto-sends", () => {
    // X's MICRO explicitly permits a single word and is its heaviest weight.
    // A Reddit reply reaching the approvals queue is treated as approved and
    // auto-sent (Skip is the veto), so a one-word drive-by ships with nobody
    // in the loop — and that is what automod removes.
    const micro = REDDIT_FORM_VARIANTS.find((v) => v.id === "MICRO")!;
    const xMicro = X_FORM_VARIANTS.find((v) => v.id === "MICRO")!;
    expect(xMicro.directive).toContain("ONE and 8 words");
    expect(micro.directive).toContain("THREE and 10 words");
    expect(micro.directive).toContain("NEVER a single word");
    expect(micro.directive).not.toContain("Even a single word is a good reply");
  });

  it("down-weights MICRO well below X's, so it is not the most common shape", () => {
    const micro = REDDIT_FORM_VARIANTS.find((v) => v.id === "MICRO")!;
    const xMicro = X_FORM_VARIANTS.find((v) => v.id === "MICRO")!;
    expect(micro.weight).toBeLessThan(xMicro.weight);
    const heaviest = Math.max(...REDDIT_FORM_VARIANTS.map((v) => v.weight));
    expect(micro.weight).toBeLessThan(heaviest);
  });

  it("does not mutate X_FORM_VARIANTS", () => {
    // Built with .map + spread; a shared object reference would retune Vega.
    expect(X_FORM_VARIANTS.find((v) => v.id === "MICRO")!.weight).toBe(0.12);
    expect(REDDIT_FORM_VARIANTS.every((v, i) => v !== X_FORM_VARIANTS[i])).toBe(true);
  });

  it("still resolves every energy subset with room for the rotation", () => {
    for (const energy of TONE_FIRST_ENERGIES) {
      const pool = shapesForEnergy(energy, REDDIT_FORM_VARIANTS);
      expect(pool.length).toBeGreaterThanOrEqual(3);
      expect(pool.length).toBeLessThan(REDDIT_FORM_VARIANTS.length);
    }
  });
});

describe("STANCE_SHAPE_IDS", () => {
  it("names exactly the shapes whose directive dictates a STANCE", () => {
    const all = [...FORM_VARIANTS, ...X_FORM_VARIANTS];
    for (const id of STANCE_SHAPE_IDS) {
      const v = all.find((x) => x.id === id);
      expect(v, `${id} is not a real shape`).toBeDefined();
    }
    // The distinction is content vs form: these decide WHAT the reply argues.
    expect(STANCE_SHAPE_IDS).toContain("RIFF");           // "answer with the joke"
    expect(STANCE_SHAPE_IDS).toContain("FLAT_DISAGREE");  // "contradict the claim"
    expect(STANCE_SHAPE_IDS).toContain("AGREE_EXTEND");   // "agree in four words"
    // …and these are form-only, so they compose with any assigned angle.
    for (const id of ["MICRO", "ONE_SHORT", "RUN_ON", "THREE_BEAT", "TWO_FLAT", "ASIDE"]) {
      expect(STANCE_SHAPE_IDS).not.toContain(id);
    }
  });

  it("leaves a usable pool on every set after exclusion", () => {
    // A multi-angle lead excludes all of these at once, on top of the rotation
    // memory. If that starved the pool, pickFormVariant would fall back to the
    // FULL set and hand back the very shapes just excluded.
    for (const set of [FORM_VARIANTS, X_FORM_VARIANTS, REDDIT_FORM_VARIANTS]) {
      const rotation = createFormVariantRotation(set);
      const rng = makeLcg(3);
      for (let i = 0; i < 200; i++) {
        expect(STANCE_SHAPE_IDS).not.toContain(rotation.next(rng, STANCE_SHAPE_IDS).id);
      }
    }
  });
});

describe("TONE_FIRST_ENERGIES", () => {
  it("has a shape subset for every tone-first energy", () => {
    // shapesForEnergy fails OPEN, so a tone-first energy with no entry here
    // does not error — it silently returns the FULL set, and a shaped
    // celebration could be handed FLAT_DISAGREE. Nothing else catches that,
    // which is exactly why the two constants now live in the same file.
    for (const energy of TONE_FIRST_ENERGIES) {
