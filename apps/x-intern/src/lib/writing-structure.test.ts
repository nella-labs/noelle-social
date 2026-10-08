import { describe, expect, it } from "vitest";
import { buildDrafterSystem, SYSTEM_X_BASE } from "./prompts.js";
import { buildIdeationSystem } from "./ideation.js";

describe("X writing structure contract", () => {
  it.each([
    ["legacy replies", () => buildDrafterSystem(null)],
    ["brand replies", () => SYSTEM_X_BASE],
    ["steered replies", () => buildDrafterSystem("Discuss the supplied test result")],
    ["ideas", () => buildIdeationSystem(null)],
  ])("reaches %s through the real builder", (_name, build) => {
    const system = build();
    expect((system.match(/CONTENT AND STRUCTURE/g) ?? [])).toHaveLength(1);
    expect(system).toContain("Preserve uncertainty, partial results and mixed causes");
    expect(system).toContain("Style examples are not evidence of the operator's experiences");
  });
});
