import { describe, expect, it } from "vitest";
import {
  WATCHLIST_OBJECTIVES,
  WatchlistObjectiveKindSchema,
  WatchlistObjectiveNoteSchema,
  composeObjectiveDirective,
  watchlistObjectiveLabel,
} from "./watchlist-objective.js";

describe("watchlist objective presets", () => {
  it("exposes the four presets with unique keys + non-empty directives", () => {
    expect(WATCHLIST_OBJECTIVES.map((o) => o.key)).toEqual([
      "relationship",
      "feedback",
      "pitch",
      "amplify",
    ]);
    for (const o of WATCHLIST_OBJECTIVES) {
      expect(o.label.length).toBeGreaterThan(0);
      expect(o.drafterDirective.length).toBeGreaterThan(0);
    }
  });

  it("validates the kind enum", () => {
    expect(WatchlistObjectiveKindSchema.safeParse("relationship").success).toBe(true);
    expect(WatchlistObjectiveKindSchema.safeParse("nonsense").success).toBe(false);
  });

  it("normalises the note (empty/whitespace ⇒ null, bounded)", () => {
    expect(WatchlistObjectiveNoteSchema.parse("")).toBeNull();
    expect(WatchlistObjectiveNoteSchema.parse("   ")).toBeNull();
    expect(WatchlistObjectiveNoteSchema.parse(" be present ")).toBe("be present");
    expect(WatchlistObjectiveNoteSchema.safeParse("x".repeat(241)).success).toBe(false);
  });

  it("labels a kind", () => {
    expect(watchlistObjectiveLabel("relationship")).toBe("Build relationship");
    expect(watchlistObjectiveLabel(null)).toBeNull();
  });
});

describe("composeObjectiveDirective", () => {
  it("returns '' for no objective so callers can append unconditionally", () => {
    expect(composeObjectiveDirective(null)).toBe("");
    expect(composeObjectiveDirective(undefined, "ignored")).toBe("");
  });

  it("includes the preset directive", () => {
    const out = composeObjectiveDirective("relationship");
    expect(out).toContain("Objective for this specific person:");
    expect(out).toContain("Do NOT pitch");
  });

  it("appends the operator note when present", () => {
    const out = composeObjectiveDirective("relationship", "stay active about what they ship");
    expect(out).toContain("Operator note: stay active about what they ship");
  });

  it("omits the note clause when blank", () => {
    expect(composeObjectiveDirective("pitch", "   ")).not.toContain("Operator note:");
  });
});
