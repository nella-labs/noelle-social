import { describe, expect, it } from "vitest";
import {
  buildDrafterSystem,
  buildLightDrafterSystem,
  SYSTEM_LINKEDIN_BASE,
  SYSTEM_LINKEDIN_INTRO,
  buildLadderDmSystem,
} from "./prompts.js";
import { buildPostDrafterSystem, renderPostDrafterPrompt } from "./post-drafter.js";
import { buildIdeationSystem } from "./ideation.js";
import { buildPolishSystem } from "./idea-polish.js";
import { draftVipIntroDm } from "./vip-dm.js";

describe("LinkedIn writing structure contract", () => {
  it("does not force a follow ask or a sentence-length formula into every post", () => {
    const system = buildPostDrafterSystem("linkedin", null);
    expect(system).not.toContain("END WITH A CALM SIGN-OFF");
    expect(system).not.toContain("Include at least one very short sentence");
  });

  it("keeps LinkedIn post hooks source-supported without forcing artificial tension or confession", () => {
    const system = buildPostDrafterSystem("linkedin", null);

    expect(system).toContain("draft 4-5 source-supported candidate hooks");
    expect(system).toContain("pick the strongest true one");
    expect(system).not.toContain("THE HOOK IS THE WHOLE GAME");
    expect(system).not.toContain("creates tension or curiosity");
    expect(system).not.toContain("confession");
    expect(system).not.toContain("stop doing X");
  });

  it("allows brief LinkedIn posts when the facts are thin instead of padding or repeating", () => {
    const system = buildPostDrafterSystem("linkedin", null);

    expect(system).toContain("Use the length the evidence earns");
    expect(system).toContain("a thin fact can be a brief post");
    expect(system).not.toContain("FIXATE, DON'T COVER");
    expect(system).not.toContain("re-hit the central ones");
    expect(system).not.toContain("One detail mentioned twice beats three mentioned once");
    expect(system).not.toContain("LinkedIn post, not a tweet");
  });

  it("asks for body plus optional hooks consistently with the parser", () => {
    const prompt = renderPostDrafterPrompt({
      hook: "9 of 12 teams finished setup",
      thesis: "desktop only, mobile untested",
      angle: "bounded evidence",
      pillar: "product",
      voiceAnchors: [],
      inspirationExcerpts: [],
      hookPatterns: [],
      standingRules: [],
      chatGuidance: [],
    });

    expect(prompt).toContain("single `body` key plus optional `hooks`");
    expect(prompt).not.toContain("single `body` key.");
  });

  it.each([
    ["legacy replies and DM", () => buildDrafterSystem(null)],
    ["brand replies and DM", () => SYSTEM_LINKEDIN_BASE],
    ["light replies", () => buildLightDrafterSystem(null)],
    ["intro DM", () => SYSTEM_LINKEDIN_INTRO],
    ["ladder DM", () => buildLadderDmSystem({ index: 1, id: "open", label: "Connect", directive: "React to their actual post", proposesCall: false })],
    ["LinkedIn post", () => buildPostDrafterSystem("linkedin", null)],
    ["X post", () => buildPostDrafterSystem("x", null)],
    ["ideas", () => buildIdeationSystem(null)],
    ["idea polish", () => buildPolishSystem(null)],
  ])("reaches %s through the real builder", (_name, build) => {
    const system = build();
    expect((system.match(/CONTENT AND STRUCTURE/g) ?? [])).toHaveLength(1);
    expect(system).toContain("Preserve uncertainty, partial results and mixed causes");
    expect(system).toContain("Style examples are not evidence of the operator's experiences");
  });

  it("reaches the VIP DM runner without changing its plain-text output", async () => {
    let system = "";
    const body = "hey, how did you choose the first test group?";
    const draft = await draftVipIntroDm({
      runner: { draft: async (args) => {
        system = args.system;
        return { text: body, engine: "bedrock", model: "test" };
      } },
      orgId: "test-org",
      instanceId: "test-instance",
      postText: "Opened the first test group today",
    });
    expect(system).toContain("CONTENT AND STRUCTURE");
    expect(system).toContain("Style examples are not evidence of the operator's experiences");
    expect(draft).toBe(body);
  });
});
