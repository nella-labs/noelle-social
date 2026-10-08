import { describe, it, expect } from "vitest";
import {
  normalizeStyleName,
  resolveStyleSourceHandle,
  extractStyleDirective,
  readStyleExemplarKinds,
  readFaithfulVoices,
  readFaithfulVoiceWeights,
  pickFaithfulVoice,
  type StyleSourceRef,
} from "./stylePin.js";

const SOURCES: StyleSourceRef[] = [
  { handle: "kaia-tham-7bb065343", displayName: "Kaia Tham" },
  { handle: "annielongg", displayName: null },
  { handle: "noahkostesku", displayName: "Noah Kostesku" },
];

describe("normalizeStyleName", () => {
  it("lowercases, strips the LinkedIn hex suffix, and collapses separators", () => {
    expect(normalizeStyleName("Kaia Tham")).toBe("kaia tham");
    expect(normalizeStyleName("kaia-tham-7bb065343")).toBe("kaia tham");
    expect(normalizeStyleName("  Kaia   Tham!  ")).toBe("kaia tham");
  });
  it("keeps a real handle without a hex suffix intact", () => {
    expect(normalizeStyleName("annielongg")).toBe("annielongg");
    // A short numeric-ish tail that isn't a 6+ hex run is not stripped.
    expect(normalizeStyleName("john-x1")).toBe("john x1");
  });
});

describe("resolveStyleSourceHandle", () => {
  it("resolves an exact display name to the canonical handle", () => {
    expect(resolveStyleSourceHandle("Kaia Tham", SOURCES)).toBe("kaia-tham-7bb065343");
  });
  it("resolves a first-name-only mention (subset match)", () => {
    expect(resolveStyleSourceHandle("kaia", SOURCES)).toBe("kaia-tham-7bb065343");
  });
  it("resolves the raw handle itself (picker value path)", () => {
    expect(resolveStyleSourceHandle("kaia-tham-7bb065343", SOURCES)).toBe("kaia-tham-7bb065343");
    expect(resolveStyleSourceHandle("annielongg", SOURCES)).toBe("annielongg");
  });
  it("returns null when nothing matches confidently", () => {
    expect(resolveStyleSourceHandle("Taylor Swift", SOURCES)).toBeNull();
    expect(resolveStyleSourceHandle("", SOURCES)).toBeNull();
    expect(resolveStyleSourceHandle("someone", [])).toBeNull();
  });
  it("does not confuse two different people who share no tokens", () => {
    expect(resolveStyleSourceHandle("Noah", SOURCES)).toBe("noahkostesku");
  });
});

describe("extractStyleDirective", () => {
  it("pulls the name from the screenshot's phrasing", () => {
    expect(
      extractStyleDirective(
        "Follow Kaia Tham style, inspire from her hooks and posts to write this one, following her exact voice",
      ),
    ).toBe("Kaia Tham");
  });
  it("handles possessive + verb variants", () => {
    expect(extractStyleDirective("write like Kaia Tham")).toBe("Kaia Tham");
    expect(extractStyleDirective("use Kaia's posts to inspire this")).toBe("Kaia");
    expect(extractStyleDirective("in the style of Noah Kostesku please")).toBe("Noah Kostesku");
    expect(extractStyleDirective("Kaia's style, keep it dry")).toBe("Kaia");
  });
  it("returns null for a non-directive note", () => {
    expect(extractStyleDirective("don't mention pricing; keep it dry and funny")).toBeNull();
    expect(extractStyleDirective("open with the time I shipped at 3am")).toBeNull();
  });
  it("does not capture filler pronouns as a name", () => {
    expect(extractStyleDirective("use her posts")).toBeNull();
    expect(extractStyleDirective("follow my style")).toBeNull();
    expect(extractStyleDirective("keep the same voice")).toBeNull();
  });
  it("round-trips through the resolver end to end", () => {
    const name = extractStyleDirective("Follow Kaia Tham style, use her posts to inspire");
    expect(name).toBe("Kaia Tham");
    expect(resolveStyleSourceHandle(name!, SOURCES)).toBe("kaia-tham-7bb065343");
  });
});

describe("readStyleExemplarKinds", () => {
  it("defaults to posts-only for a null / missing / non-object config", () => {
    expect(readStyleExemplarKinds(null)).toEqual(["post"]);
    expect(readStyleExemplarKinds(undefined)).toEqual(["post"]);
    expect(readStyleExemplarKinds("garbage")).toEqual(["post"]);
    expect(readStyleExemplarKinds(42)).toEqual(["post"]);
  });

  it("defaults to posts-only when the config exists but omits the key", () => {
    expect(readStyleExemplarKinds({})).toEqual(["post"]);
    expect(readStyleExemplarKinds({ pinnedStyleHandle: "kaia-tham-7bb065343" })).toEqual(["post"]);
    expect(readStyleExemplarKinds({ maxStyleExemplars: 3 })).toEqual(["post"]);
  });

  it("passes through an explicit kinds selection", () => {
    expect(readStyleExemplarKinds({ styleExemplarKinds: ["post"] })).toEqual(["post"]);
    expect(readStyleExemplarKinds({ styleExemplarKinds: ["post", "comment"] })).toEqual([
      "post",
      "comment",
    ]);
    expect(readStyleExemplarKinds({ styleExemplarKinds: ["comment"] })).toEqual(["comment"]);
  });

  it("falls back to posts-only when the stored kinds are invalid", () => {
    // Empty array (schema rejects .min(1)) → safeParse fails → posts-only.
    expect(readStyleExemplarKinds({ styleExemplarKinds: [] })).toEqual(["post"]);
    // Unknown kind → safeParse fails → posts-only.
    expect(readStyleExemplarKinds({ styleExemplarKinds: ["repost"] })).toEqual(["post"]);
  });
});

describe("readFaithfulVoices", () => {
  it("returns [] for an empty / null / garbage config", () => {
    expect(readFaithfulVoices({})).toEqual([]);
    expect(readFaithfulVoices(null)).toEqual([]);
    expect(readFaithfulVoices(undefined)).toEqual([]);
    expect(readFaithfulVoices("garbage")).toEqual([]);
    expect(readFaithfulVoices(42)).toEqual([]);
  });

  it("promotes a single pinnedStyleHandle to a 1-element list", () => {
    expect(readFaithfulVoices({ pinnedStyleHandle: "a" })).toEqual(["a"]);
  });

  it("returns an explicit faithfulVoices list", () => {
    expect(readFaithfulVoices({ faithfulVoices: ["a", "b"] })).toEqual(["a", "b"]);
  });

  it("lets faithfulVoices OVERRIDE a pinnedStyleHandle", () => {
    expect(
      readFaithfulVoices({ pinnedStyleHandle: "a", faithfulVoices: ["b", "c"] }),
    ).toEqual(["b", "c"]);
  });
});

describe("pickFaithfulVoice", () => {
  it("returns null for an empty list", () => {
    expect(pickFaithfulVoice([], "anything")).toBeNull();
  });

  it("returns the only element for a 1-element list regardless of seed", () => {
    expect(pickFaithfulVoice(["a"], "")).toBe("a");
    expect(pickFaithfulVoice(["a"], "some-lead-text")).toBe("a");
    expect(pickFaithfulVoice(["a"], "another")).toBe("a");
  });

  it("is deterministic: the same seed twice yields the same voice", () => {
    const first = pickFaithfulVoice(["a", "b"], "lead-42");
    const second = pickFaithfulVoice(["a", "b"], "lead-42");
    expect(first).toBe(second);
  });

  it("rotates: over many distinct seeds BOTH voices are chosen at least once", () => {
    const seen = new Set<string | null>();
    for (let i = 0; i < 200; i++) {
      seen.add(pickFaithfulVoice(["a", "b"], `lead-${i}`));
    }
    expect(seen.has("a")).toBe(true);
    expect(seen.has("b")).toBe(true);
  });

  it("weights the draw ~60/40 over many seeds when weights are supplied", () => {
    const N = 4000;
    let a = 0;
    for (let i = 0; i < N; i++) {
      if (pickFaithfulVoice(["a", "b"], `lead-${i}`, [0.6, 0.4]) === "a") a += 1;
    }
    const share = a / N;
    // seeded PRNG over distinct seeds is ~uniform, so the weighted share lands
    // near 0.6 — allow a generous band so the test isn't flaky.
    expect(share).toBeGreaterThan(0.55);
    expect(share).toBeLessThan(0.65);
  });

  it("is still deterministic per seed with weights", () => {
    expect(pickFaithfulVoice(["a", "b"], "lead-42", [0.6, 0.4])).toBe(
      pickFaithfulVoice(["a", "b"], "lead-42", [0.6, 0.4]),
    );
  });

  it("falls back to uniform when weights are length-mismatched or non-positive", () => {
    // length mismatch → uniform (both still appear)
    const seen = new Set<string | null>();
    for (let i = 0; i < 200; i++) seen.add(pickFaithfulVoice(["a", "b"], `x-${i}`, [1]));
    expect(seen.has("a") && seen.has("b")).toBe(true);
    // all-zero weights → uniform, never throws / never null for a 2-element list
    expect(pickFaithfulVoice(["a", "b"], "z", [0, 0])).not.toBeNull();
  });

  it("a zero-weight voice is never chosen", () => {
    for (let i = 0; i < 200; i++) {
      expect(pickFaithfulVoice(["a", "b"], `q-${i}`, [1, 0])).toBe("a");
    }
  });
});

describe("readFaithfulVoiceWeights", () => {
  it("returns the weights when parallel to faithfulVoices", () => {
    expect(
      readFaithfulVoiceWeights({ faithfulVoices: ["a", "b"], faithfulVoiceWeights: [0.6, 0.4] }),
    ).toEqual([0.6, 0.4]);
  });

  it("returns undefined when weights are absent or length-mismatched", () => {
    expect(readFaithfulVoiceWeights({ faithfulVoices: ["a", "b"] })).toBeUndefined();
    expect(
      readFaithfulVoiceWeights({ faithfulVoices: ["a", "b"], faithfulVoiceWeights: [1] }),
    ).toBeUndefined();
    expect(readFaithfulVoiceWeights({})).toBeUndefined();
    expect(readFaithfulVoiceWeights(null)).toBeUndefined();
  });
});
