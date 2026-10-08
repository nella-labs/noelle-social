import { describe, it, expect } from "vitest";
import { buildPolishSystem, renderPolishPrompt, parsePolish } from "./idea-polish.js";

describe("buildPolishSystem", () => {
  it("includes the shared anti-AI writing rules for refined ideas", () => {
    expect(buildPolishSystem(null)).toContain("NEVER MARK SIGNIFICANCE");
    expect(buildPolishSystem(null)).toContain("TIER-1 VOCABULARY");
  });

  it("instructs to refine the idea (not write the post) and bans fabrication", () => {
    const sys = buildPolishSystem(null);
    expect(sys).toContain("refine a single content IDEA");
    expect(sys).toContain("NOT");
    expect(sys.toLowerCase()).toContain("never fabricate");
    expect(sys).toContain('"hook"');
    expect(sys).toContain('"thesis"');
  });
  it("includes the objective + brand when given", () => {
    const sys = buildPolishSystem("grow to 10k", "BRAND: rust + cream");
    expect(sys).toContain("grow to 10k");
    expect(sys).toContain("BRAND: rust + cream");
  });
});

describe("renderPolishPrompt", () => {
  it("includes the idea fields and voice anchors", () => {
    const p = renderPolishPrompt(
      { hook: "shipping beats planning", thesis: "ship daily", angle: "contrarian", pillar: "building" },
      ["i write in lowercase, blunt"],
    );
    expect(p).toContain("shipping beats planning");
    expect(p).toContain("ship daily");
    expect(p).toContain("contrarian");
    expect(p).toContain("lowercase, blunt");
  });
  it("handles a thesis-less idea + no anchors", () => {
    const p = renderPolishPrompt({ hook: "h", thesis: null, angle: null, pillar: null }, []);
    expect(p).toContain("Thesis: (none yet)");
    expect(p).not.toContain("Operator voice");
  });
});

describe("parsePolish", () => {
  it("parses a clean JSON object", () => {
    expect(parsePolish('{"hook":"sharper hook","thesis":"tighter thesis"}')).toEqual({
      hook: "sharper hook",
      thesis: "tighter thesis",
    });
  });
  it("tolerates surrounding prose/fences and a null thesis", () => {
    expect(parsePolish('Here:\n```json\n{"hook":"h","thesis":null}\n```')).toEqual({ hook: "h", thesis: null });
  });
  it("returns null on garbage or a missing hook", () => {
    expect(parsePolish("not json")).toBeNull();
    expect(parsePolish('{"thesis":"x"}')).toBeNull();
    expect(parsePolish('{"hook":""}')).toBeNull();
  });
});
