import { describe, expect, it } from "vitest";
import { buildXPostSystem, renderPostDrafterPrompt } from "./post-drafter.js";

describe("original-post factual context", () => {
  it("separates factual support from proposed ideas, voice and inspiration", () => {
    const prompt = renderPostDrafterPrompt({
      hook: "Latency fell 90%",
      thesis: "an idea awaiting evidence",
      angle: "observation",
      pillar: "tools",
      voiceAnchors: ["a voice example mentions 90%"],
      inspirationExcerpts: ["another author shipped in 2 days"],
      knowledgeAnchors: ["[release.md:4-5] p95 fell from 210ms to 180ms"],
      hookPatterns: [],
      standingRules: [],
      chatGuidance: ["Use the actual 210ms and 180ms measurement"],
    });
    expect(prompt).toContain("Supporting factual evidence");
    expect(prompt).toContain("[release.md:4-5] p95 fell from 210ms to 180ms");
    expect(prompt).toContain("The proposed hook and thesis are ideas, not evidence");
    expect(prompt).toContain("Voice and inspiration examples are style only");
    expect(prompt).toContain("Explicit factual statements supplied by the operator");
  });

  it("bounds supplied evidence and says when none is available", () => {
    const base = {
      hook: "hook",
      thesis: null,
      angle: null,
      pillar: null,
      voiceAnchors: [],
      inspirationExcerpts: [],
      hookPatterns: [],
      standingRules: [],
      chatGuidance: [],
    };
    expect(renderPostDrafterPrompt(base)).toContain("No supporting factual evidence supplied");
    const prompt = renderPostDrafterPrompt({
      ...base,
      knowledgeAnchors: Array.from({ length: 20 }, (_, i) => `evidence-${i} ${"x".repeat(2000)}`),
    });
    expect(prompt).toContain("evidence-7");
    expect(prompt).not.toContain("evidence-8");
    expect(prompt.length).toBeLessThan(9000);
  });

  it("writes self-contained useful X originals with no algorithmic reach guarantees", () => {
    const system = buildXPostSystem(null);
    expect(system).toContain("self-contained");
    expect(system).not.toContain("Judge each reply");
    expect(system).toContain("Never manufacture disagreement");
    expect(system).toContain("Do not promise ranking, impressions or reach");
    expect(system).toContain("HARD CAP 280");
    expect(system).toContain('"body": string');
  });
});
