import { describe, it, expect } from "vitest";
import {
  GENZ_MARKERS,
  DEFAULT_MARKER_RATE,
  LOUD_BLOCKED_ENERGIES,
  markersForEnergy,
  pickGenZMarker,
  renderGenZMarkerBlock,
  createGenZMarkerRotation,
  genzMarkerRateFromEnv,
} from "./genzMarkers.js";
import type { PostEnergy } from "./register.js";

const makeLcg = (seed: number) => () => {
  // Math.imul, NOT `*`: seed * 1103515245 exceeds Number.MAX_SAFE_INTEGER,
  // so the state is ROUNDED before the modulus and the stream collapses —
  // 16403 distinct values in 20000 draws instead of 20000.
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  seed %= 2 ** 31;
  return seed / 2 ** 31;
};

const ALL_ENERGIES: readonly PostEnergy[] = [
  "celebration",
  "joke",
  "hot_take",
  "vent",
  "question",
  "analytical",
];

const CONVERSATIONAL_MOVE_IDS = [
  "GROUNDED_AGREEMENT",
  "CONTEXT_SUPPORTED_ADDRESS",
  "RELATIONAL_TAG",
] as const;

// Keep the operator's verbatim examples out of the prompt catalog while still
// guarding against accidentally copying them into a directive. Encoded here so
// the source itself cannot become a phrasebook for future prompt edits.
const VERBATIM_EXAMPLES = [
  "bWFuLCBnaXJsLCBJIHRvdGFsbHkgYWdyZWUgd2l0aA==",
  "eWVhaCwgdGhhdCBtYWtlcyB0b3RhbCBzZW5zZQ==",
  "Y29vbCBndXkgaXNudCBoZT8=",
].map((encoded) => Buffer.from(encoded, "base64").toString("utf8").toLowerCase());

describe("GENZ_MARKERS", () => {
  it("has unique ids and weights summing to 1.00", () => {
    const ids = GENZ_MARKERS.map((m) => m.id);
    expect(new Set(ids).size).toBe(GENZ_MARKERS.length);
    expect(GENZ_MARKERS.reduce((a, m) => a + m.weight, 0)).toBeCloseTo(1.0, 10);
  });

  it("excludes the cosplay tier entirely", () => {
    // These are the ones that read as an adult doing an impression. They are
    // hard-banned in the drafter prompts; the lane must never reintroduce them.
    const banned = ["no cap", "rizz", "it's giving", "fr fr", "based", "slay", "bussin", " ate "];
    const corpus = GENZ_MARKERS.map((m) => `${m.id} ${m.directive}`).join(" ").toLowerCase();
    for (const b of banned) expect(corpus).not.toContain(b);
  });

  it("has at least two plain markers beyond the rotation memory", () => {
    // createGenZMarkerRotation's default memory is 4 and the loud tier is
    // unreachable on a vent/question, so the plain tier must stay big enough
    // that the rotation can never starve itself into returning null.
    const plain = GENZ_MARKERS.filter((m) => m.tier === "plain");
    expect(plain.length).toBeGreaterThanOrEqual(6);
  });

  it("defines the three conversational moves with their safety guards", () => {
    const moves = new Map(
      GENZ_MARKERS.filter((marker) => CONVERSATIONAL_MOVE_IDS.includes(marker.id as never))
        .map((marker) => [marker.id, marker.directive.toLowerCase()]),
    );
    expect([...moves.keys()].sort()).toEqual([...CONVERSATIONAL_MOVE_IDS].sort());

    expect(moves.get("GROUNDED_AGREEMENT")).toMatch(/spoken acknowledgement/);
    expect(moves.get("GROUNDED_AGREEMENT")).toMatch(/post-specific (reason|referent)/);
    expect(moves.get("GROUNDED_AGREEMENT")).toMatch(/portable/);

    expect(moves.get("CONTEXT_SUPPORTED_ADDRESS")).toMatch(/name.*profile.*post.*conversation/);
    expect(moves.get("CONTEXT_SUPPORTED_ADDRESS")).toMatch(/never guess.*gender/);

    expect(moves.get("RELATIONAL_TAG")).toMatch(/tag question/);
    expect(moves.get("RELATIONAL_TAG")).toMatch(/clear (person|thing).*referent/);
  });

  it("keeps the operator's verbatim examples out of the catalog and renderer", () => {
    const corpus = [
      ...GENZ_MARKERS.map((marker) => marker.directive),
      ...GENZ_MARKERS.map((marker) => renderGenZMarkerBlock(marker)),
    ].join("\n").toLowerCase();
    for (const example of VERBATIM_EXAMPLES) expect(corpus).not.toContain(example);
  });

  it("gives conversational moves enough eligible weight for a 7-10% outer occurrence", () => {
    const occurrenceFor = (platform: "x" | "linkedin") => {
      const pool = markersForEnergy("analytical", {
        platform,
        ...(platform === "linkedin" ? { plainOnly: true } : {}),
      });
      const eligibleWeight = pool.reduce((sum, marker) => sum + marker.weight, 0);
      const moveWeight = pool
        .filter((marker) => CONVERSATIONAL_MOVE_IDS.includes(marker.id as never))
        .reduce((sum, marker) => sum + marker.weight, 0);
      return DEFAULT_MARKER_RATE * (moveWeight / eligibleWeight);
    };

    const catalogMoveWeight = GENZ_MARKERS
      .filter((marker) => CONVERSATIONAL_MOVE_IDS.includes(marker.id as never))
      .reduce((sum, marker) => sum + marker.weight, 0);
    expect(catalogMoveWeight).toBeGreaterThanOrEqual(0.3);
    expect(catalogMoveWeight).toBeLessThanOrEqual(0.36);
    for (const platform of ["x", "linkedin"] as const) {
      expect(occurrenceFor(platform)).toBeGreaterThanOrEqual(0.07);
      expect(occurrenceFor(platform)).toBeLessThanOrEqual(0.1);
    }
  });
});

describe("markersForEnergy", () => {
  it("drops the loud tier on a vent and on a question", () => {
    for (const energy of LOUD_BLOCKED_ENERGIES) {
      const pool = markersForEnergy(energy);
      expect(pool.length).toBeGreaterThan(0);
      expect(pool.every((m) => m.tier === "plain")).toBe(true);
    }
  });

  it("keeps the full universal pool on every other KNOWN energy", () => {
    const open = ALL_ENERGIES.filter((e) => !LOUD_BLOCKED_ENERGIES.includes(e));
    for (const energy of open) {
      expect(markersForEnergy(energy).map((marker) => marker.id)).toEqual(
        markersForEnergy(energy, { platform: "reddit" }).map((marker) => marker.id),
      );
    }
  });

  it("fails SAFE on an unknown energy — null blocks the loud tier too", () => {
    // This is the production case, not an edge case. postEnergy is null
    // whenever NOELLE_DRAFTER_ENERGY is off, which is its default and its
    // state in the live ecosystem config, so a gate that only fired on a KNOWN
    // vent would never fire at all — and "cooked" would land under someone's
    // layoff post, auto-sent, on Reddit.
    const pool = markersForEnergy(null);
    expect(pool.every((m) => m.tier === "plain")).toBe(true);
    expect(pool.length).toBeLessThan(GENZ_MARKERS.length);
    for (let seed = 1; seed <= 200; seed++) {
      expect(pickGenZMarker(makeLcg(seed), null)?.tier).toBe("plain");
    }
  });

  it("offers conversational moves on X and LinkedIn but never on Reddit", () => {
    for (const platform of ["x", "linkedin"] as const) {
      const ids = markersForEnergy("analytical", {
        platform,
        ...(platform === "linkedin" ? { plainOnly: true } : {}),
      }).map((marker) => marker.id);
      for (const id of CONVERSATIONAL_MOVE_IDS) expect(ids).toContain(id);
    }

    for (const opts of [{ platform: "reddit" as const }, {}]) {
      const ids = markersForEnergy("analytical", opts).map((marker) => marker.id);
      for (const id of CONVERSATIONAL_MOVE_IDS) expect(ids).not.toContain(id);
    }
  });
});

describe("pickGenZMarker", () => {
  it("never returns a loud marker under a blocked energy, swept", () => {
    for (const energy of LOUD_BLOCKED_ENERGIES) {
      for (let seed = 1; seed <= 200; seed++) {
        const picked = pickGenZMarker(makeLcg(seed), energy);
        expect(picked).not.toBeNull();
        expect(picked!.tier).toBe("plain");
      }
    }
  });

  it("reaches the loud tier on an open energy", () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 400; seed++) {
      const picked = pickGenZMarker(makeLcg(seed), "joke");
      if (picked?.tier === "loud") seen.add(picked.id);
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it("honours exclusions and returns null when the pool empties", () => {
    const all = GENZ_MARKERS.map((m) => m.id);
    expect(pickGenZMarker(() => 0.5, null, all)).toBeNull();
    const picked = pickGenZMarker(() => 0.99, null, ["THE_WAY"]);
    expect(picked?.id).not.toBe("THE_WAY");
  });

  it("renormalises after exclusions rather than falling off the end", () => {
    // r just under 1 must still land on the LAST surviving candidate, not on an
    // excluded one and not on null. Uses an OPEN energy, because a null energy
    // now restricts the pool to the plain tier.
    const excluded = GENZ_MARKERS.filter((m) => m.tier === "plain")
