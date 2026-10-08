import { describe, expect, it } from "vitest";
import { OPENING_MOVES, pickOpeningMove, renderOpeningMoveBlock } from "./opening-move.js";

describe("OPENING_MOVES", () => {
  it("has the six curated opening moves", () => {
    expect(OPENING_MOVES.map((m) => m.id)).toEqual([
      "REACT",
      "DETAIL",
      "TAKE",
      "QUESTION",
      "PUSHBACK",
      "ANECDOTE",
    ]);
  });

  it("weights sum to 1 (so the [0,1) range is fully covered)", () => {
    const sum = OPENING_MOVES.reduce((acc, m) => acc + m.weight, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it("no single move dominates", () => {
    for (const m of OPENING_MOVES) expect(m.weight).toBeLessThanOrEqual(0.2);
  });
});

describe("pickOpeningMove (boundary values for the documented weights)", () => {
  // Cumulative: REACT [0,.20) DETAIL [.20,.40) TAKE [.40,.60)
  // QUESTION [.60,.75) PUSHBACK [.75,.90) ANECDOTE [.90,1.0)
  // Midpoints (not exact edges) so float accumulation can't push a case one
  // bucket over (0.2+0.2+0.2 = 0.6000…1, etc.).
  it.each([
    [0, "REACT"],
    [0.1, "REACT"],
    [0.25, "DETAIL"],
    [0.35, "DETAIL"],
    [0.45, "TAKE"],
    [0.55, "TAKE"],
    [0.65, "QUESTION"],
    [0.72, "QUESTION"],
    [0.8, "PUSHBACK"],
    [0.88, "PUSHBACK"],
    [0.92, "ANECDOTE"],
    [0.99, "ANECDOTE"],
  ])("r=%s → %s", (r, id) => {
    expect(pickOpeningMove(() => r).id).toBe(id);
  });

  it("a pathological r >= 1 falls back to the last move (ANECDOTE)", () => {
    expect(pickOpeningMove(() => 1).id).toBe("ANECDOTE");
    expect(pickOpeningMove(() => 1.5).id).toBe("ANECDOTE");
  });

  it("defaults to Math.random and always returns a valid move", () => {
    for (let i = 0; i < 200; i++) {
      const m = pickOpeningMove();
      expect(OPENING_MOVES.map((x) => x.id)).toContain(m.id);
    }
  });

  it("covers EVERY move across the [0,1) range at the documented weights", () => {
    const seen = new Set<string>();
    for (let r = 0; r < 1; r += 0.001) seen.add(pickOpeningMove(() => r).id);
    expect([...seen].sort()).toEqual(["ANECDOTE", "DETAIL", "PUSHBACK", "QUESTION", "REACT", "TAKE"]);
  });
});

describe("renderOpeningMoveBlock", () => {
  it("labels the block, carries the directive, and keeps rules intact + DM-exempt", () => {
    const block = renderOpeningMoveBlock(pickOpeningMove(() => 0)); // REACT
    expect(block).toContain("OPENING MOVE FOR THIS REPLY");
    expect(block).toContain("direct reaction");
    expect(block).toContain("no em dashes");
    expect(block).toContain("never applies to the DM");
  });

  it("PUSHBACK move tells it to disagree without manufacturing agreement", () => {
    const block = renderOpeningMoveBlock(pickOpeningMove(() => 0.8)); // PUSHBACK
    expect(block).toContain("disagreeing");
    expect(block).toContain("Do not manufacture agreement");
  });
});
