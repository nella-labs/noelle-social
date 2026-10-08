import { describe, expect, it } from "vitest";
import {
  BrandConfigSchema,
  parseBrandConfig,
  brandConfigHasContent,
} from "./brand-config.js";

describe("BrandConfig", () => {
  it.each(["never", "always"] as const)("a policy-only %s config overrides legacy behavior", (pitch_policy) => {
    expect(brandConfigHasContent(parseBrandConfig({ pitch_policy }))).toBe(true);
  });
  it("an empty config parses with safe defaults (generic peer behavior)", () => {
    const b = parseBrandConfig({});
    expect(b.pitch_policy).toBe("when_relevant");
    expect(b.qa).toEqual([]);
    expect(brandConfigHasContent(b)).toBe(false);
  });

  it("null/undefined column parses as empty", () => {
    expect(brandConfigHasContent(parseBrandConfig(null))).toBe(false);
    expect(brandConfigHasContent(parseBrandConfig(undefined))).toBe(false);
  });

  it("parses a full Noelle-style config", () => {
    const b = parseBrandConfig({
      persona: { name: "Demooperator", bio: "indie founder building Noelle" },
      product: {
        name: "Noelle",
        description: "AI agent org-chart for small teams",
        url: "trynoelle.com",
        install: "trynoelle.com",
        surfaces: ["trynoelle.com"],
        fits_when: ["hiring AI agents", "growth on autopilot"],
      },
      pitch_policy: "when_relevant",
      reply_style: { voice_notes: "direct, specific", never_do: ["no em dashes"] },
      dm_style: { greeting: "Hellooo", closing: "lmk!", fragments_min: 4, fragments_max: 6, len_min: 400, len_max: 700 },
      qa: [{ q: "Who is it for?", a: "small founder-led teams" }],
    });
    expect(b.product?.name).toBe("Noelle");
    expect(b.dm_style?.greeting).toBe("Hellooo");
    expect(b.qa).toHaveLength(1);
    expect(brandConfigHasContent(b)).toBe(true);
  });

  it("rejects an invalid pitch_policy", () => {
    expect(() => BrandConfigSchema.parse({ pitch_policy: "spam_everyone" })).toThrow();
  });

  it("caps qa list length", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ q: `q${i}`, a: `a${i}` }));
    expect(() => BrandConfigSchema.parse({ qa: many })).toThrow();
  });
});
