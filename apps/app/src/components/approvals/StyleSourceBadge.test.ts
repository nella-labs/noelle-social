import { describe, it, expect } from "vitest";
import { formatStyleBlend } from "./StyleSourceBadge";

describe("formatStyleBlend", () => {
  it("drops the percent for a lone source (it's effectively 100%)", () => {
    expect(formatStyleBlend([{ handle: "kaia", weight: 1 }])).toBe("kaia");
  });

  it("shows each source's rounded percent for a real blend", () => {
    expect(
      formatStyleBlend([
        { handle: "kaia", weight: 0.75 },
        { handle: "devon", weight: 0.25 },
      ]),
    ).toBe("kaia 75% · devon 25%");
  });

  it("preserves the given (desc) order — the selector already sorts", () => {
    expect(
      formatStyleBlend([
        { handle: "devon", weight: 0.5 },
        { handle: "kaia", weight: 0.33 },
        { handle: "mara", weight: 0.17 },
      ]),
    ).toBe("devon 50% · kaia 33% · mara 17%");
  });

  it("skips blank handles", () => {
    expect(
      formatStyleBlend([
        { handle: "kaia", weight: 0.6 },
        { handle: "   ", weight: 0.4 },
      ]),
    ).toBe("kaia 60%");
  });

  it("strips the LinkedIn auto-id suffix from vanity slugs", () => {
    expect(
      formatStyleBlend([
        { handle: "kaia-tham-7bb065343", weight: 0.67 },
        { handle: "annielongg", weight: 0.33 },
      ]),
    ).toBe("kaia-tham 67% · annielongg 33%");
  });
});
