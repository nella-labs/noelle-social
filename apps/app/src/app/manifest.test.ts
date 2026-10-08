import { describe, expect, it } from "vitest";
import manifest from "./manifest";

describe("Noelle installed app identity", () => {
  it("uses the geometric icon revision for every manifest size", () => {
    const icons = manifest().icons ?? [];
    expect(icons).toHaveLength(3);
    for (const icon of icons) {
      expect(new URL(icon.src!, "https://app.trynoelle.com").searchParams.get("v")).toBe("geometric-1");
    }
  });
});
