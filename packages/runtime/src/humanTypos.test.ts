import { describe, it, expect } from "vitest";
import {
  TYPO_VARIANTS,
  DEFAULT_TYPO_RATE,
  humanizeTypos,
  pickTypoKind,
  typoRateFromEnv,
  type TypoKind,
} from "./humanTypos.js";

// Deterministic LCG so frequency tests are stable but walk the range.
const makeLcg = (seed: number) => () => {
  // Math.imul, NOT `*`: seed * 1103515245 exceeds Number.MAX_SAFE_INTEGER,
  // so the state is ROUNDED before the modulus and the stream collapses —
  // 16403 distinct values in 20000 draws instead of 20000.
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  seed %= 2 ** 31;
  return seed / 2 ** 31;
};

/** An rng that replays a fixed script, then 0 forever. */
const scripted = (...values: number[]) => {
  let i = 0;
  return () => values[i++] ?? 0;
};

/** Force one specific kind: roll a hit, then pin the weighted pick to it. */
const forceKind = (kind: TypoKind, ...rest: number[]) => {
  const idx = TYPO_VARIANTS.findIndex((v) => v.kind === kind);
  const before = TYPO_VARIANTS.slice(0, idx).reduce((a, v) => a + v.weight, 0);
  // Land inside this kind's slice of the cumulative range.
  return scripted(0, before + TYPO_VARIANTS[idx]!.weight / 2, ...rest);
};

const SENTENCE = "the migration ran clean but the rollback still scares me honestly";

describe("TYPO_VARIANTS", () => {
  it("has unique kinds and weights summing to 1.00", () => {
    const kinds = TYPO_VARIANTS.map((v) => v.kind);
    expect(new Set(kinds).size).toBe(TYPO_VARIANTS.length);
    expect(TYPO_VARIANTS.reduce((a, v) => a + v.weight, 0)).toBeCloseTo(1.0, 10);
  });
});

describe("pickTypoKind", () => {
  it("returns null when every kind is excluded", () => {
    expect(pickTypoKind(() => 0.5, TYPO_VARIANTS.map((v) => v.kind))).toBeNull();
  });

  it("renormalises over the remaining pool after exclusions", () => {
    const kind = pickTypoKind(() => 0.99, ["DROP_WORD"]);
    expect(kind).not.toBe("DROP_WORD");
    expect(kind).not.toBeNull();
  });
});

describe("humanizeTypos — the rate gate", () => {
  it("leaves the body untouched when the roll misses", () => {
    const out = humanizeTypos(SENTENCE, { rate: 0.1, rng: () => 0.5 });
    expect(out.body).toBe(SENTENCE);
    expect(out.applied).toBeNull();
  });

  it("is a no-op at rate 0", () => {
    const out = humanizeTypos(SENTENCE, { rate: 0, rng: () => 0 });
    expect(out.body).toBe(SENTENCE);
    expect(out.applied).toBeNull();
  });

  it("lands close to the configured share over many bodies", () => {
    const rng = makeLcg(7);
    let hits = 0;
    for (let i = 0; i < 4000; i++) {
      if (humanizeTypos(SENTENCE, { rate: 0.1, rng }).applied) hits++;
    }
    // 10% of 4000 = 400. Allow generous slack: this asserts "roughly a tenth",
    // not an exact count, because an ineligible body legitimately declines.
    expect(hits).toBeGreaterThan(250);
    expect(hits).toBeLessThan(550);
  });

  it("applies AT MOST ONE slip: the mutated body differs by one edit", () => {
    const rng = makeLcg(11);
    for (let i = 0; i < 500; i++) {
      const out = humanizeTypos(SENTENCE, { rate: 1, rng });
      if (!out.applied) continue;
      const a = SENTENCE.split(" ");
      const b = out.body.split(" ");
      // Exactly one token position differs, or exactly one token was
      // added/removed — never two independent edits.
      const lenDelta = Math.abs(a.length - b.length);
      expect(lenDelta).toBeLessThanOrEqual(1);
      if (lenDelta === 0) {
        const diffs = a.filter((t, k) => t !== b[k]).length;
        expect(diffs).toBe(1);
      }
    }
  });
});

describe("humanizeTypos — each kind", () => {
  it("DROP_WORD removes exactly one function word", () => {
    const out = humanizeTypos(SENTENCE, { rate: 1, rng: forceKind("DROP_WORD", 0) });
    expect(out.applied).toBe("DROP_WORD");
    expect(out.body.split(" ")).toHaveLength(SENTENCE.split(" ").length - 1);
    expect(SENTENCE).toContain(out.body.split(" ")[1]!);
  });

  it("DROP_APOSTROPHE strips the apostrophe from a contraction", () => {
    const body = "honestly it's the rollback that scares me every single time";
    const out = humanizeTypos(body, { rate: 1, rng: forceKind("DROP_APOSTROPHE", 0) });
    expect(out.applied).toBe("DROP_APOSTROPHE");
    expect(out.body).toContain("its");
    expect(out.body).not.toContain("it's");
  });

  it("TRANSPOSE swaps two adjacent letters and keeps the length", () => {
    const out = humanizeTypos(SENTENCE, { rate: 1, rng: forceKind("TRANSPOSE", 0, 0) });
    expect(out.applied).toBe("TRANSPOSE");
    expect(out.body).not.toBe(SENTENCE);
    expect(out.body.length).toBe(SENTENCE.length);
    expect([...out.body].sort().join("")).toBe([...SENTENCE].sort().join(""));
  });

  it("DROP_LETTER halves a doubled letter when one is present", () => {
    const body = "the runner really kept falling over on the second pass";
    const out = humanizeTypos(body, { rate: 1, rng: forceKind("DROP_LETTER", 0, 0) });
    expect(out.applied).toBe("DROP_LETTER");
    expect(out.body.length).toBe(body.length - 1);
  });

  it("DOUBLE_WORD repeats one short word", () => {
    const out = humanizeTypos(SENTENCE, { rate: 1, rng: forceKind("DOUBLE_WORD", 0) });
    expect(out.applied).toBe("DOUBLE_WORD");
    const b = out.body.split(" ");
    expect(b).toHaveLength(SENTENCE.split(" ").length + 1);
    expect(b.some((t, i) => t === b[i + 1])).toBe(true);
  });

  it("KEY_NEIGHBOR swaps ONE letter for a same-row neighbour, same length", () => {
    const out = humanizeTypos(SENTENCE, { rate: 1, rng: forceKind("KEY_NEIGHBOR", 0, 0) });
    expect(out.applied).toBe("KEY_NEIGHBOR");
    expect(out.body).not.toBe(SENTENCE);
    expect(out.body.length).toBe(SENTENCE.length);
    // Exactly one character differs.
    const diffs = [...out.body].filter((ch, i) => ch !== SENTENCE[i]);
    expect(diffs).toHaveLength(1);
  });

  it("KEY_NEIGHBOR never touches a word's FIRST letter", () => {
    // The first letter is what a reader uses to recognise a word, so a miss
    // there reads as a corrupted string rather than as a thumb.
    for (let seed = 1; seed <= 40; seed++) {
      const out = humanizeTypos(SENTENCE, { rate: 1, rng: forceKind("KEY_NEIGHBOR", ...Array.from({ length: 6 }, (_, k) => makeLcg(seed + k)())) });
      if (out.applied !== "KEY_NEIGHBOR") continue;
      const before = SENTENCE.split(" ");
      const after = out.body.split(" ");
      after.forEach((tok, i) => expect(tok[0]).toBe(before[i]![0]));
    }
  });

  it("MISSING_SPACE runs exactly two words together", () => {
    const body = "the queue kept the last job for a very long time honestly";
    const out = humanizeTypos(body, { rate: 1, rng: forceKind("MISSING_SPACE", 0) });
    expect(out.applied).toBe("MISSING_SPACE");
    const words = out.body.split(" ");
    expect(words).toHaveLength(body.split(" ").length - 1);
    // One space vanished and nothing else changed.
    expect(out.body.replace(/ /g, "")).toBe(body.replace(/ /g, ""));
  });

  it("DOUBLE_LETTER adds one letter and never makes a triple", () => {
    const body = "the queue kept stalling out on the second batch of jobs";
    const out = humanizeTypos(body, { rate: 1, rng: forceKind("DOUBLE_LETTER", 0, 0) });
    expect(out.applied).toBe("DOUBLE_LETTER");
    expect(out.body.length).toBe(body.length + 1);
    expect(out.body).not.toMatch(/([a-z])\1\1/);
  });

  it("DOUBLE_LETTER declines a word whose double sits at the FRONT", () => {
    // The eligibility guard is "this word contains no existing double". Its
    // first draft only scanned from index 1, so a word whose double sat at the
    // very front slipped through and became a TRIPLE ("aardvark" -> "aaardvark").
    //
    // The body is built so "aardvark" is the ONLY token DOUBLE_LETTER could
    // pick: it is interior (index 0 and the last index are never touched), and
    // every other interior token is either under 4 letters or already carries a
    // double. With the buggy guard this is forced onto "aardvark" and triples
    // it; with the correct guard the kind finds no candidate and declines.
    const body = "ok aardvark all till off week too glass seen";
    const out = humanizeTypos(body, { rate: 1, rng: forceKind("DOUBLE_LETTER", 0, 0) });
    expect(out.body).not.toMatch(/([a-z])\1\1/);
    expect(out.body).not.toContain("aaardvark");
  });

  it("no kind ever produces a triple letter, swept over seeds and bodies", () => {
    const bodies = [
      "the aardvark kept eating the whole batch of ants honestly",
      "success needs the queue to drain before the batch lands here",
      "committee meetings ran over again and nobody shipped a thing",
      "the migration ran clean but the rollback still scares me honestly",
    ];
    for (const body of bodies) {
      for (let seed = 1; seed <= 60; seed++) {
        const out = humanizeTypos(body, { rate: 1, rng: makeLcg(seed) });
        expect(out.body).not.toMatch(/([a-z])\1\1/);
      }
    }
  });
});

describe("humanizeTypos — what it must never touch", () => {
  it("does not duplicate not into a double negative", () => {
    const body = "we do not charge customers before they approve the invoice";
    const out = humanizeTypos(body, { rate: 1, rng: forceKind("DOUBLE_WORD", 0.3) });
    expect(out.body.match(/\bnot\b/g)).toHaveLength(1);
  });

  it.each([
    "no", "not", "never", "none", "nobody", "nothing", "neither", "nor", "without", "cannot",
    "can't", "won't", "don't", "doesn't", "didn't", "isn't", "aren't", "wasn't", "weren't",
    "shouldn't", "wouldn't", "couldn't", "mustn't", "hasn't", "haven't", "hadn't", "needn't", "ain't",
  ])("preserves the negation token %s across kinds and seeds", (negation) => {
    const body = `we ${negation} change the billing contract before customers approve the invoice`;
    for (let seed = 1; seed <= 120; seed++) {
      for (const { kind } of TYPO_VARIANTS) {
        const next = makeLcg(seed);
        const out = humanizeTypos(body, { rate: 1, rng: forceKind(kind, next(), next(), next()) });
        expect(out.body.split(/\s+/).filter((token) => token === negation), `${kind} @${seed}`)
          .toHaveLength(1);
      }
    }
  });

  it("never mutates a handle, a hashtag, a URL, a domain, or a number", () => {
    const body = "shipped @noelle on getnella.dev with 12 users see https://x.com/foo #build";
    const rng = makeLcg(3);
    for (let i = 0; i < 2000; i++) {
      const out = humanizeTypos(body, { rate: 1, rng });
      expect(out.body).toContain("@noelle");
      expect(out.body).toContain("getnella.dev");
      expect(out.body).toContain("https://x.com/foo");
      expect(out.body).toContain("#build");
      expect(out.body).toContain("12");
    }
  });

  it("never mutates a capitalised proper noun", () => {
    const body = "we moved Nella onto Cloud Run and the cold start got worse honestly";
    const rng = makeLcg(5);
    for (let i = 0; i < 2000; i++) {
      const out = humanizeTypos(body, { rate: 1, rng });
      expect(out.body).toContain("Nella");
      expect(out.body).toContain("Cloud");
      expect(out.body).toContain("Run");
    }
  });

  it("never mutates the first or the last token", () => {
    const rng = makeLcg(13);
    const first = SENTENCE.split(" ")[0]!;
    const last = SENTENCE.split(" ").at(-1)!;
    for (let i = 0; i < 2000; i++) {
      const out = humanizeTypos(SENTENCE, { rate: 1, rng });
      expect(out.body.split(" ")[0]).toBe(first);
      expect(out.body.split(" ").at(-1)).toBe(last);
    }
  });

  it("declines a reply too short to carry a believable slip", () => {
    const out = humanizeTypos("eaten by wolves is wild", { rate: 1, rng: () => 0 });
    expect(out.applied).toBeNull();
    expect(humanizeTypos("brutal", { rate: 1, rng: () => 0 }).applied).toBeNull();
  });

  it("declines rather than exceeding maxLength", () => {
    // A body one char under the cap: DOUBLE_WORD would blow past it.
    const body = "the deploy went fine but the alerting never fired at all so nobody knew";
    const out = humanizeTypos(body, {
      rate: 1,
      rng: forceKind("DOUBLE_WORD", 0),
      maxLength: body.length,
    });
    expect(out.applied).not.toBe("DOUBLE_WORD");
    expect(out.body.length).toBeLessThanOrEqual(body.length);
  });

  it("respects maxLength across many random draws", () => {
    const body = "the deploy went fine but the alerting never fired at all so nobody knew";
    const rng = makeLcg(17);
    for (let i = 0; i < 2000; i++) {
      const out = humanizeTypos(body, { rate: 1, rng, maxLength: 280 });
      expect(out.body.length).toBeLessThanOrEqual(280);
    }
  });

  it("ships a body clean when no token is safe to mutate", () => {
    const body = "@a @b @c @d @e @f";
    const out = humanizeTypos(body, { rate: 1, rng: () => 0 });
    expect(out.body).toBe(body);
    expect(out.applied).toBeNull();
  });
});

describe("typoRateFromEnv", () => {
  it("defaults to 18%", () => {
    expect(typoRateFromEnv({})).toBe(DEFAULT_TYPO_RATE);
    expect(DEFAULT_TYPO_RATE).toBe(0.18);
  });

  it("NOELLE_HUMAN_TYPOS=0 turns the pass off", () => {
    expect(typoRateFromEnv({ NOELLE_HUMAN_TYPOS: "0" })).toBe(0);
  });

  it("honours a valid explicit rate", () => {
    expect(typoRateFromEnv({ NOELLE_HUMAN_TYPO_RATE: "0.25" })).toBe(0.25);
    expect(typoRateFromEnv({ NOELLE_HUMAN_TYPO_RATE: "0" })).toBe(0);
  });

  it("falls back to the default on a malformed rate", () => {
    expect(typoRateFromEnv({ NOELLE_HUMAN_TYPO_RATE: "nope" })).toBe(DEFAULT_TYPO_RATE);
    expect(typoRateFromEnv({ NOELLE_HUMAN_TYPO_RATE: "7" })).toBe(DEFAULT_TYPO_RATE);
    expect(typoRateFromEnv({ NOELLE_HUMAN_TYPO_RATE: "-1" })).toBe(DEFAULT_TYPO_RATE);
  });
});

describe("humanizeTypos — never INVENTS an offensive word", () => {
  // KEY_NEIGHBOR is the first kind that SUBSTITUTES a letter, which makes
  // real-word collisions reachable. Enumerated, not hypothesised: with o -> i on
  // the same QWERTY row, "shot" -> "shit", and "duck"/"dock" -> "dick". Orion
  // auto-sends, so there is no human between that and the subreddit.
  const HAZARDS = [
    "we took a decent shot at the whole retry problem honestly",
    "the duck typing in that module keeps biting us on deploys",
    "every dock worker script in the repo assumes the old path",
  ];

  it("never produces shit/dick from a clean body, swept over kinds and seeds", () => {
    for (const body of HAZARDS) {
      for (let seed = 1; seed <= 400; seed++) {
        const out = humanizeTypos(body, { rate: 1, rng: makeLcg(seed) });
        expect(out.body, `${body} @${seed}`).not.toMatch(/\b(shit|dick|cunt|fuck|retard)\b/);
      }
    }
  });

  it("does not FREEZE a body that already contains one — it censors invention, not speech", () => {
    // The guard compares the word sets before and after, so a body that already
    // says it is still mutable: only a word that was NOT there before and IS
    // there after is refused. Asserting "the word survives" would be wrong,
    // because a slip may legitimately land on that very word.
    const body = "honestly the whole retry thing is shit and i said so twice";
    let mutated = 0;
    for (let seed = 1; seed <= 60; seed++) {
      if (humanizeTypos(body, { rate: 1, rng: makeLcg(seed) }).applied) mutated++;
    }
    expect(mutated).toBeGreaterThan(0);
  });
});
