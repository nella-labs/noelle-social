import { describe, expect, it } from "vitest";
import { buildDenseIndex } from "./denseChunkIndex.js";

describe("buildDenseIndex", () => {
  it("ranks chunk indices by cosine similarity to the query, descending", () => {
    // q points along x. v0 is orthogonal, v1 aligns with q, v2 anti-aligns.
    const idx = buildDenseIndex([
      [0, 1], // index 0 — orthogonal (cos 0)
      [1, 0], // index 1 — identical direction (cos 1)
      [-1, 0], // index 2 — opposite (cos -1)
    ]);
    const out = idx.search([1, 0], 3);
    expect(out.map((r) => r.index)).toEqual([1, 0, 2]);
    expect(out[0]!.score).toBeCloseTo(1, 6);
    expect(out[1]!.score).toBeCloseTo(0, 6);
    expect(out[2]!.score).toBeCloseTo(-1, 6);
  });

  it("caps results at topK", () => {
    const idx = buildDenseIndex([
      [1, 0],
      [0.9, 0.1],
      [0.8, 0.2],
      [0.1, 1],
    ]);
    expect(idx.search([1, 0], 2)).toHaveLength(2);
  });

  it("skips null entries (chunks with no embedding) — their indices never appear", () => {
    const idx = buildDenseIndex([
      [1, 0], // 0
      null, // 1 — not embedded
      [0.5, 0.5], // 2
    ]);
    const out = idx.search([1, 0], 5);
    expect(out.map((r) => r.index)).toEqual([0, 2]);
    expect(out.some((r) => r.index === 1)).toBe(false);
  });

  it("breaks ties deterministically by ascending index", () => {
    const idx = buildDenseIndex([
      [1, 0], // index 0 — cos 1
      [2, 0], // index 1 — also cos 1 (same direction, different magnitude)
    ]);
    const out = idx.search([5, 0], 5);
    expect(out.map((r) => r.index)).toEqual([0, 1]);
  });

  it("returns [] for an empty query vector", () => {
    const idx = buildDenseIndex([[1, 0], [0, 1]]);
    expect(idx.search([], 5)).toEqual([]);
  });

  it("returns [] when there are no embedded chunks", () => {
    expect(buildDenseIndex([]).search([1, 0], 5)).toEqual([]);
    expect(buildDenseIndex([null, null]).search([1, 0], 5)).toEqual([]);
  });

  it("returns [] for topK <= 0", () => {
    const idx = buildDenseIndex([[1, 0]]);
    expect(idx.search([1, 0], 0)).toEqual([]);
  });
});
