import { describe, expect, it } from "vitest";
import { rrfFuse, cosineSim } from "./rrf.js";

describe("rrfFuse", () => {
  it("returns the union of indices, best-first, for a single ranking", () => {
    // One ranking == that ranking's order, deduped.
    expect(rrfFuse([[2, 0, 1]])).toEqual([2, 0, 1]);
  });

  it("agreeing rankings keep the shared order", () => {
    const fused = rrfFuse([
      [0, 1, 2],
      [0, 1, 2],
    ]);
    expect(fused).toEqual([0, 1, 2]);
  });

  it("rewards items ranked high in BOTH rankings (deterministic fusion)", () => {
    // dense: 2 best, then 0, then 1
    // rerank: 0 best, then 2, then 1
    // RRF(k=60): item 0 → 1/61 + 1/60 ; item 2 → 1/60 + 1/61 (equal to 0);
    //   item 1 → 1/62 + 1/62 (lowest). 0 and 2 tie → tie-break ascending → 0,2.
    const fused = rrfFuse([
      [2, 0, 1],
      [0, 2, 1],
    ]);
    expect(fused).toEqual([0, 2, 1]);
  });

  it("a clear cross-ranking winner sorts first", () => {
    // item 5 is rank 0 in both → highest fused score → first.
    const fused = rrfFuse([
      [5, 1, 2, 3],
      [5, 3, 2, 1],
    ]);
    expect(fused[0]).toBe(5);
  });

  it("handles partial rankings (an item missing from one ranking earns 0 there)", () => {
    // item 9 only appears in the first ranking, at rank 0.
    // item 0 appears in both but lower.
    const fused = rrfFuse([
      [9, 0],
      [0],
    ]);
    // 9: 1/60. 0: 1/61 + 1/60 ≈ 0.0331 > 1/60 ≈ 0.0167 → 0 first.
    expect(fused).toEqual([0, 9]);
  });

  it("smaller k sharpens the contribution of top ranks", () => {
    // With a tiny k, rank-0 dominance is stronger; just assert determinism +
    // that the doubly-top item wins.
    const fused = rrfFuse(
      [
        [7, 1],
        [7, 2],
      ],
      { k: 1 },
    );
    expect(fused[0]).toBe(7);
  });

  it("breaks exact ties by ascending index for stable output", () => {
    // Symmetric inputs make 1 and 2 tie; ascending tie-break → 1 before 2.
    const fused = rrfFuse([
      [1, 2],
      [2, 1],
    ]);
    expect(fused).toEqual([1, 2]);
  });

  it("returns [] for no rankings", () => {
    expect(rrfFuse([])).toEqual([]);
  });

  it("ignores non-finite / undefined index slots defensively", () => {
    const fused = rrfFuse([[Number.NaN, 0, 1]]);
    expect(fused).toEqual([0, 1]);
  });
});

describe("cosineSim", () => {
  it("returns 1 for identical direction", () => {
    expect(cosineSim([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it("returns 1 for parallel (scaled) vectors", () => {
    expect(cosineSim([1, 0], [5, 0])).toBeCloseTo(1, 10);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSim([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSim([1, 1], [-1, -1])).toBeCloseTo(-1, 10);
  });

  it("returns 0 for mismatched lengths (no signal, never throws)", () => {
    expect(cosineSim([1, 2, 3], [1, 2])).toBe(0);
  });

  it("returns 0 for an empty vector", () => {
    expect(cosineSim([], [])).toBe(0);
  });

  it("returns 0 when either vector has zero magnitude", () => {
    expect(cosineSim([0, 0], [1, 1])).toBe(0);
  });

  it("orders candidates: nearer vector scores higher", () => {
    const q = [1, 0];
    const near = cosineSim(q, [0.9, 0.1]);
    const far = cosineSim(q, [0.1, 0.9]);
    expect(near).toBeGreaterThan(far);
  });
});
