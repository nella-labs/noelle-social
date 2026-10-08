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
      expect(Object.keys(ENERGY_SHAPE_IDS)).toContain(energy);
      for (const set of [FORM_VARIANTS, X_FORM_VARIANTS]) {
        expect(shapesForEnergy(energy, set).length).toBeLessThan(set.length);
      }
    }
  });

  it("every shape is reachable on at least one tone-first energy", () => {
    // ENERGY_SHAPE_IDS is an ALLOWLIST, so a shape added to a variant set and
    // not added here becomes silently unreachable on every tone-first energy.
    // shapesForEnergy cannot tell "left out on purpose" from "forgotten", so
    // this is the only place that notices.
    for (const set of [FORM_VARIANTS, X_FORM_VARIANTS, REDDIT_FORM_VARIANTS]) {
      for (const v of set) {
        const reachable = [...TONE_FIRST_ENERGIES].some((e) =>
          shapesForEnergy(e, set).some((x) => x.id === v.id),
        );
        expect(reachable, `${v.id} is unreachable on every tone-first energy`).toBe(true);
      }
    }
  });

  it("does not scope an energy that is NOT tone-first", () => {
    for (const energy of Object.keys(ENERGY_SHAPE_IDS)) {
      expect(TONE_FIRST_ENERGIES.has(energy)).toBe(true);
    }
  });
});

describe("shapesForEnergy", () => {
  const X_IDS = X_FORM_VARIANTS.map((v) => v.id);

  it("narrows every tone-first energy on both platforms", () => {
    for (const energy of ["celebration", "joke", "vent", "hot_take"]) {
      for (const set of [FORM_VARIANTS, X_FORM_VARIANTS]) {
        const pool = shapesForEnergy(energy, set);
        expect(pool.length).toBeGreaterThanOrEqual(3);
        expect(pool.length).toBeLessThan(set.length);
      }
    }
  });

  it("keeps the wrong shape out of the wrong room", () => {
    const ids = (energy: string) => shapesForEnergy(energy, X_FORM_VARIANTS).map((v) => v.id);
    // You cannot disagree with someone's launch, or grade a detail of it.
    expect(ids("celebration")).not.toContain("FLAT_DISAGREE");
    expect(ids("celebration")).not.toContain("DETAIL_ZOOM");
    // Joking at someone venting, or telling them they are wrong about it.
    expect(ids("vent")).not.toContain("RIFF");
    expect(ids("vent")).not.toContain("FLAT_DISAGREE");
    expect(ids("vent")).not.toContain("QUESTION_ONLY");
    // An earnest three-beat analysis under a shitpost is the bot tell.
    expect(ids("joke")).not.toContain("THREE_BEAT");
    expect(ids("joke")).not.toContain("OBSERVE_ASK");
    // A hot take is answered flat.
    expect(ids("hot_take")).toContain("FLAT_DISAGREE");
  });

  it("fails OPEN on an unknown energy, on null, and on analytical", () => {
    for (const energy of [null, undefined, "analytical", "question", "nonsense"]) {
      expect(shapesForEnergy(energy, X_FORM_VARIANTS)).toHaveLength(X_FORM_VARIANTS.length);
      expect(shapesExcludedForEnergy(energy, X_FORM_VARIANTS)).toEqual([]);
    }
  });

  it("fails OPEN when a subset resolves too narrowly against a platform's set", () => {
    // Every id in the table must exist on at least one platform, but a subset
    // that lands under the floor for THIS platform must return the full set
    // rather than a two-shape rut.
    // OBSERVE_ASK / TWO_FLAT / RUN_ON / ASIDE — only ASIDE is a joke shape, so
    // the subset resolves to 1, under the floor of 3.
    const narrow = X_FORM_VARIANTS.slice(4, 8);
    expect(narrow.filter((v) => ENERGY_SHAPE_IDS["joke"]!.includes(v.id)).length).toBeLessThan(3);
    expect(shapesForEnergy("joke", narrow)).toHaveLength(narrow.length);
    expect(shapesExcludedForEnergy("joke", narrow)).toEqual([]);
  });

  it("every id in the table exists on at least one platform", () => {
    const known = new Set([...FORM_VARIANTS, ...X_FORM_VARIANTS].map((v) => v.id));
    for (const [energy, ids] of Object.entries(ENERGY_SHAPE_IDS)) {
      for (const id of ids) {
        expect(known, `${energy} lists unknown shape ${id}`).toContain(id);
      }
    }
    expect(X_IDS.length).toBeGreaterThan(0);
  });

  it("shapesExcludedForEnergy is the exact complement of the pool", () => {
    for (const energy of ["celebration", "joke", "vent", "hot_take"]) {
      const pool = shapesForEnergy(energy, X_FORM_VARIANTS).map((v) => v.id);
      const excluded = shapesExcludedForEnergy(energy, X_FORM_VARIANTS);
      expect([...pool, ...excluded].sort()).toEqual([...X_IDS].sort());
      expect(pool.some((id) => excluded.includes(id))).toBe(false);
    }
  });

  it("leaves a rotation with memory at least one candidate on every energy", () => {
    // The rotation excludes DEFAULT_ROTATION_MEMORY recent shapes on top of the
    // energy exclusion. If that emptied the pool, pickFormVariant would fall
    // back to the FULL set and the energy scoping would silently vanish.
    for (const energy of ["celebration", "joke", "vent", "hot_take"]) {
      for (const set of [FORM_VARIANTS, X_FORM_VARIANTS]) {
        const rotation = createFormVariantRotation(set);
        const excluded = shapesExcludedForEnergy(energy, set);
        const allowed = new Set(shapesForEnergy(energy, set).map((v) => v.id));
        const rng = makeLcg(energy.length + set.length);
        for (let i = 0; i < 100; i++) {
          expect(allowed).toContain(rotation.next(rng, excluded).id);
        }
      }
    }
  });
});

describe("createFormVariantRotation", () => {
  it("never hands out the same variant twice in a row", () => {
    const rng = makeLcg(42);
    const rotation = createFormVariantRotation();
    let prev: string | null = null;
    for (let i = 0; i < 500; i++) {
      const v = rotation.next(rng);
      expect(v.id).not.toBe(prev);
      prev = v.id;
    }
  });

  it("honours a per-call lane exclusion on top of the anti-repeat", () => {
    const rng = makeLcg(9);
    const rotation = createFormVariantRotation();
    let prev: string | null = null;
    for (let i = 0; i < 500; i++) {
      const v = rotation.next(rng, LIGHT_EXCLUDED_VARIANT_IDS);
      expect(LIGHT_EXCLUDED_VARIANT_IDS).not.toContain(v.id);
      expect(v.id).not.toBe(prev);
      prev = v.id;
    }
  });

  it("remembers 3 picks by default", () => {
    // Pinned, because the two window tests below assert against the CONSTANT
    // and so would still pass if it regressed to 1. Only this and the
    // alternation test below catch that.
    expect(DEFAULT_ROTATION_MEMORY).toBe(3);
  });

  it("never repeats a shape within the default 3-pick memory window", () => {
    const rng = makeLcg(42);
    const rotation = createFormVariantRotation();
    const seen: string[] = [];
    for (let i = 0; i < 500; i++) {
      const v = rotation.next(rng);
      expect(seen.slice(-DEFAULT_ROTATION_MEMORY)).not.toContain(v.id);
      seen.push(v.id);
    }
  });

  it("holds the memory window across a per-call lane exclusion", () => {
    const rng = makeLcg(9);
    const rotation = createFormVariantRotation(X_FORM_VARIANTS);
    const seen: string[] = [];
    for (let i = 0; i < 500; i++) {
      const v = rotation.next(rng, LIGHT_EXCLUDED_VARIANT_IDS);
      expect(LIGHT_EXCLUDED_VARIANT_IDS).not.toContain(v.id);
      expect(seen.slice(-DEFAULT_ROTATION_MEMORY)).not.toContain(v.id);
      seen.push(v.id);
    }
  });

  it("kills the A/B/A/B alternation the 1-deep window allowed", () => {
    // The old rotation excluded only the previous pick, so alternating between
    // the two heaviest shapes was legal and, on X where MICRO and RUN_ON carry
    // the top weights, common. Count 4-long alternating runs (x,y,x,y).
    const rng = makeLcg(7);
    const rotation = createFormVariantRotation(X_FORM_VARIANTS);
    const ids: string[] = [];
    for (let i = 0; i < 1000; i++) ids.push(rotation.next(rng).id);
    let alternations = 0;
    for (let i = 3; i < ids.length; i++) {
      if (ids[i] === ids[i - 2] && ids[i - 1] === ids[i - 3]) alternations++;
    }
    expect(alternations).toBe(0);
  });

  it("trims the memory rather than silently sampling the full set", () => {
    // pickFormVariant falls back to the FULL variant list when exclusions empty
    // the pool. So an over-wide window does not throw, it quietly reintroduces
    // repeats — and a naive window test still passes. Drive a pool small enough
    // that memory + lane exclusion would empty it, and assert the LANE
    // exclusion (the one that must never be violated) still holds.
    const tiny = X_FORM_VARIANTS.slice(0, 4);
    const lane = [tiny[0]!.id];
    const rotation = createFormVariantRotation(tiny, 10);
    const rng = makeLcg(11);
    for (let i = 0; i < 200; i++) {
      const v = rotation.next(rng, lane);
      expect(lane).not.toContain(v.id);
      expect(tiny.map((t) => t.id)).toContain(v.id);
    }
  });

  it("keeps independent state per rotation instance", () => {
    const a = createFormVariantRotation();
    const b = createFormVariantRotation();
    const first = a.next(() => 0.0);
    // b has no exclusion yet, so the same rng maps to the same first variant.
    expect(b.next(() => 0.0).id).toBe(first.id);
  });
});

describe("renderStyleBlock faithful + formVariant", () => {
  const baseStyle: StyleForPrompt = {
    exemplars: [
      { body: "an exemplar post body", accountHandle: "kaia", likeCount: 10, commentCount: 2 },
    ],
    styleNotes: "",
  };

  it("without a formVariant keeps tight length but lets evidence define the shape", () => {
    const block = renderStyleBlock(baseStyle, undefined, true);
    expect(block).toContain("as actually shown in their examples and style notes");
    expect(block).toContain("Keep it tight: one or two short sentences");
    expect(block).toContain("Let the examples determine the exact shape");
    expect(block).toContain("Borrow their VOICE and SHAPE");
    expect(block).not.toContain("OPEN with a short, punchy reaction (roughly 3 to 8 words)");
    expect(block).not.toContain("a hook, plus at most one aside");
    expect(block).not.toContain("Borrow only the SHAPE");
    expect(block).not.toContain("ASSIGNED SHAPE");
  });

  it("with a formVariant renders the assigned shape instead of the fixed recipe", () => {
    const style: StyleForPrompt = {
      ...baseStyle,
      formVariant: { id: "RUN_ON", directive: "ONE longer run-on sentence, ~180 to 260 characters." },
    };
    const block = renderStyleBlock(style, undefined, true);
    expect(block).toContain("THIS REPLY'S ASSIGNED SHAPE");
    expect(block).toContain("ONE longer run-on sentence, ~180 to 260 characters.");
    expect(block).toContain("Stick to the assigned shape's length exactly (comments only");
    expect(block).not.toContain("OPEN with a short, punchy reaction (roughly 3 to 8 words)");
    expect(block).not.toContain("Keep it tight: one or two short sentences");
    // Voice + anti-plagiarism guidance survives the swap.
    expect(block).toContain("do not plagiarize");
    expect(block).toContain("WRITE THIS REPLY IN THE VOICE OF THE WRITER BELOW");
  });

  it("ignores formVariant outside faithful mode (blend paths unchanged)", () => {
    const style: StyleForPrompt = {
      ...baseStyle,
      formVariant: { id: "MICRO", directive: "One tiny reaction." },
    };
    const block = renderStyleBlock(style, "neutral", false);
    expect(block).not.toContain("ASSIGNED SHAPE");
    expect(block).toContain("STYLE TO EMULATE");
  });
});

describe("X_FORM_VARIANTS (Vega)", () => {
  it("has exactly 12 variants with unique ids, non-empty directives, weights summing to 1", () => {
    expect(X_FORM_VARIANTS).toHaveLength(12);
    const ids = X_FORM_VARIANTS.map((v) => v.id);
    expect(new Set(ids).size).toBe(12);
    for (const v of X_FORM_VARIANTS) {
      expect(v.directive.trim().length).toBeGreaterThan(0);
      expect(v.weight).toBeGreaterThan(0);
    }
    const sum = X_FORM_VARIANTS.reduce((a, v) => a + v.weight, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
  });

  it("MICRO permits a ONE-word reply (the shape the operator asked for)", () => {
    const micro = X_FORM_VARIANTS.find((v) => v.id === "MICRO");
    expect(micro).toBeDefined();
    // Falsifiable: Lyra's MICRO says "3 to 8 words" and would fail this.
    expect(micro!.directive).toMatch(/\bONE and 8 words\b/);
    expect(micro!.directive).not.toMatch(/3 to 8 words total/);
  });

  it("no X directive asks for a length X cannot hold (280-char reply ceiling)", () => {
    // Every explicit "~N to M characters" upper bound must stay under 280.
    for (const v of X_FORM_VARIANTS) {
      for (const m of v.directive.matchAll(/(\d+)\s*(?:to|-)\s*(\d+)\s*characters/g)) {
        expect(Number(m[2])).toBeLessThanOrEqual(260);
      }
    }
  });

  it("models no punctuation the verifier hard-zeros (em dash)", () => {
    for (const v of X_FORM_VARIANTS) expect(v.directive).not.toContain("—");
  });

  // The two sets share MACHINERY, not a skeleton list. They used to be the same
  // ten ids with different length bands, which is a large part of why Lyra's and
  // Vega's feeds read as one writer.
  it("shares the ten common shapes with Lyra but keeps two of its own", () => {
    const lyra = new Set(FORM_VARIANTS.map((v) => v.id));
    const vega = new Set(X_FORM_VARIANTS.map((v) => v.id));
    const shared = [...vega].filter((id) => lyra.has(id));
    expect(shared).toHaveLength(10);
    expect([...vega].filter((id) => !lyra.has(id)).sort()).toEqual(["FLAT_DISAGREE", "RIFF"]);
    expect([...lyra].filter((id) => !vega.has(id)).sort()).toEqual(["AGREE_EXTEND", "SELF_STORY"]);
  });

  // Same rationale in numbers: X leans shorter, LinkedIn leans longer, so the
  // two feeds do not land in one character band.
  it("weights the short shapes higher than Lyra's set does", () => {
    const shortWeight = (set: readonly { id: string; weight: number }[]) =>
      set
        .filter((v) => ["MICRO", "ONE_SHORT", "HOOK_THEN_LINE"].includes(v.id))
        .reduce((a, v) => a + v.weight, 0);
    expect(shortWeight(X_FORM_VARIANTS)).toBeGreaterThan(shortWeight(FORM_VARIANTS));
  });

  it("pickFormVariant honours an explicit pool", () => {
    const lcg = makeLcg(7);
    for (let i = 0; i < 500; i++) {
      const picked = pickFormVariant(lcg, null, X_FORM_VARIANTS);
      expect(X_FORM_VARIANTS).toContain(picked);
    }
  });

  it("a pool-bound rotation never repeats a shape back-to-back", () => {
    const rot = createFormVariantRotation(X_FORM_VARIANTS);
    const lcg = makeLcg(99);
    let prev = "";
    for (let i = 0; i < 500; i++) {
      const v = rot.next(lcg);
      expect(X_FORM_VARIANTS.some((x) => x.id === v.id)).toBe(true);
      expect(v.id).not.toBe(prev);
      prev = v.id;
    }
  });

  it("defaults to the LinkedIn pool when no pool is passed (Lyra unchanged)", () => {
    const rot = createFormVariantRotation();
    const lcg = makeLcg(3);
    for (let i = 0; i < 200; i++) expect(FORM_VARIANTS).toContain(rot.next(lcg));
  });

  it("no X shape may exceed the verifier's 250-char hard cap for an X reply", () => {
    // drafter-tick.ts passes charLimit: 250 to the deterministic format scorer,
    // which penalises OVER-length drafts. A directive that asks for more than
    // that would score its own drafts down on every pick.
    const X_REPLY_CHAR_LIMIT = 250;
    for (const v of X_FORM_VARIANTS) {
      for (const m of v.directive.matchAll(/(\d+)\s*(?:to|-)\s*(\d+)\s*characters/g)) {
        expect(Number(m[2])).toBeLessThanOrEqual(X_REPLY_CHAR_LIMIT);
      }
      for (const m of v.directive.matchAll(/under (\d+) characters/g)) {
        expect(Number(m[1])).toBeLessThanOrEqual(X_REPLY_CHAR_LIMIT);
      }
    }
  });

  it("MICRO permits standalone reactions without specificity padding", () => {
    const micro = X_FORM_VARIANTS.find((v) => v.id === "MICRO")!;
    expect(micro.directive).toContain("so real");
    expect(micro.directive).not.toContain("bare agreement with no content");
    expect(micro.directive).not.toContain("IF it reacts to something specific");
    expect(X_FORM_VARIANTS.find((v) => v.id === "ONE_SHORT")!.directive).not.toContain("specific take");
  });

  it("the X pool actually spreads length — not one band (the whole point)", () => {
    // The shortest shape must be able to produce a sub-40-char reply and the
    // longest a 200+ one. A single-band set would fail this.
    const micro = X_FORM_VARIANTS.find((v) => v.id === "MICRO")!;
    const three = X_FORM_VARIANTS.find((v) => v.id === "THREE_BEAT")!;
    expect(micro.directive).toMatch(/single line/);
    expect(three.directive).toMatch(/190 to 240/);
  });
});

describe("renderAssignedShapeBlock", () => {
  it("renders the directive with an explicit override of the default length rules", () => {
    const block = renderAssignedShapeBlock({ id: "MICRO", directive: "One tiny reaction, ONE to 8 words." });
    expect(block).toContain("THIS REPLY'S ASSIGNED SHAPE");
    expect(block).toContain("One tiny reaction, ONE to 8 words.");
    expect(block).toMatch(/OVERRIDES the default reply length/);
  });

  it("keeps the NEVER-DO rules intact and forbids padding a short shape", () => {
    const block = renderAssignedShapeBlock({ id: "MICRO", directive: "d" });
    expect(block).toContain("no em dashes");
    expect(block).toMatch(/do NOT pad it/);
    expect(block).toMatch(/never applies to a DM/i);
  });

  it("stays platform-neutral so either intern can render it", () => {
    const block = renderAssignedShapeBlock({ id: "RUN_ON", directive: "d" });
    expect(block).not.toMatch(/LinkedIn/i);
    expect(block).not.toMatch(/\btweet\b/i);
  });

  it("models no em dash of its own", () => {
    expect(renderAssignedShapeBlock({ id: "X", directive: "d" })).not.toContain("—");
  });
});

describe("SHAPES_WITH_FREE_OPENER", () => {
  it("names only shapes that exist in the X pool", () => {
    const ids = new Set(X_FORM_VARIANTS.map((v) => v.id));
