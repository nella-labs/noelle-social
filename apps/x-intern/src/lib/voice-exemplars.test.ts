import { describe, expect, it } from "vitest";
import { buildDrafterSystem } from "./prompts.js";

describe("buildDrafterSystem with voice exemplars", () => {
  it("is byte-identical when no exemplars are supplied", () => {
    // A brand-new org has no sent history. It must pay nothing and see no
    // change to the generic base prompt.
    const before = buildDrafterSystem(null, null, null, null, null);
    const after = buildDrafterSystem(null, null, null, null, null, undefined, null, null, undefined, []);
    expect(after).toBe(before);
  });

  it("appends the pairs, after the rest of the voice layers", () => {
    const out = buildDrafterSystem(
      null, null, null, null, null, undefined, null, null, undefined,
      [{ post: "4000 replies in 90 days", reply: "16:1 ratio i'm stealing into my week" }],
    );
    expect(out).toContain("HOW YOU ACTUALLY REPLY");
    expect(out).toContain("YOU REPLIED: 16:1 ratio");
    // The base prompt survives intact underneath, and the pairs come LAST so
    // they are the freshest voice instruction the model reads.
    expect(out).toContain("You are the operator, phone in hand");
    expect(out.indexOf("You are the operator")).toBeLessThan(out.indexOf("HOW YOU ACTUALLY REPLY"));
    expect(out.trimEnd().endsWith("YOU REPLIED: 16:1 ratio i'm stealing into my week")).toBe(true);
  });
});
