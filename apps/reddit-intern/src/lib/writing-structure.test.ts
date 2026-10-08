import { describe, expect, it } from "vitest";
import { buildDrafterSystem, buildLightDrafterSystem, SYSTEM_REDDIT_BASE } from "./prompts.js";

describe("Reddit writing structure contract", () => {
  it.each([
    ["legacy replies", () => buildDrafterSystem(null)],
    ["brand replies", () => SYSTEM_REDDIT_BASE],
    ["light replies", () => buildLightDrafterSystem(null)],
  ])("reaches %s through the real builder", (_name, build) => {
    const system = build();
    expect((system.match(/CONTENT AND STRUCTURE/g) ?? [])).toHaveLength(1);
    expect(system).toContain("Preserve uncertainty, partial results and mixed causes");
    expect(system).toContain("Style examples are not evidence of the operator's experiences");
  });
});
