import { describe, expect, it } from "vitest";
import { stripEmDashes } from "./voiceSanitize.js";

describe("stripEmDashes", () => {
  it("turns a spaced em dash into comma-glue (the real-world case)", () => {
    expect(stripEmDashes("the gap is feedback loops — tutorials give you the illusion")).toBe(
      "the gap is feedback loops, tutorials give you the illusion",
    );
  });

  it("handles an unspaced em dash", () => {
    expect(stripEmDashes("a—b")).toBe("a, b");
  });

  it("handles en dash and horizontal bar", () => {
    expect(stripEmDashes("x – y ― z")).toBe("x, y, z");
  });

  it("collapses a parenthetical em-dash pair into commas", () => {
    expect(stripEmDashes("X — like Y — Z")).toBe("X, like Y, Z");
  });

  it("converts a spaced double-hyphen", () => {
    expect(stripEmDashes("one thing -- another")).toBe("one thing, another");
  });

  it("preserves a numeric range as a hyphen", () => {
    expect(stripEmDashes("aim 400–700 chars")).toBe("aim 400-700 chars");
  });

  it("leaves real hyphens in compounds alone", () => {
    expect(stripEmDashes("a one-person company with AST-aware indexing")).toBe(
      "a one-person company with AST-aware indexing",
    );
  });

  it("drops a trailing dash cleanly (no dangling comma)", () => {
    expect(stripEmDashes("ends with a dash —")).toBe("ends with a dash");
  });

  it("is a no-op on text with no dashes", () => {
    expect(stripEmDashes("honestly this is just one clean sentence")).toBe(
      "honestly this is just one clean sentence",
    );
  });

  it("is idempotent", () => {
    const once = stripEmDashes("a — b — c");
    expect(stripEmDashes(once)).toBe(once);
  });
});
