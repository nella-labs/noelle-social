import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("downloadable Noelle identity vectors", () => {
  it("builds the selected flow symbol and lowercase wordmark from geometric primitives", () => {
    const source = JSON.parse(readFileSync(path.resolve("brand/geometry.json"), "utf8"));
    expect(source.symbol.shapes).toHaveLength(2);
    expect(source.symbol.shapes.every(({ type, d }: { type: string; d: string }) =>
      type === "path" && (d.match(/C/g) ?? []).length <= 10)).toBe(true);
    expect(source.wordmark.letters.map(({ glyph }: { glyph: string }) => glyph).join(""))
      .toBe("noelle");
    expect(Object.values(source.wordmark.glyphs).map((glyph) => (glyph as { type: string }).type))
      .toEqual(["path", "circle", "path", "rect"]);
  });

  it.each([
    ["noelle-wordmark.svg", "#13110C"],
    ["noelle-symbol-white.svg", "#FFFFFF"],
    ["noelle-wordmark-white.svg", "#FFFFFF"],
    ["noelle-lockup-white.svg", "#FFFFFF"],
  ])("provides %s as outlined SVG artwork", (name, color) => {
    const file = path.resolve("public/brand", name);
    expect(existsSync(file), `${name} must be available as a public vector`).toBe(true);
    const artwork = readFileSync(file, "utf8");
    expect(artwork).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(artwork).toContain(`fill="${color}"`);
    expect(artwork).toContain("<path ");
    expect(artwork).not.toContain("<text");
    expect(artwork).not.toMatch(/<image|data:image\//);
  });
});
