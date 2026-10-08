import { describe, expect, it } from "vitest";
import {
  hasGatheredContent,
  synthesizeBrief,
  renderBriefBlock,
  type GatheredContext,
  type DraftingBrief,
} from "./contextAssembly.js";

const ctx = { postText: "rust builds are slow", platform: "x", authorHandle: "u" };

describe("hasGatheredContent", () => {
  it("is false for an empty gather", () => {
    expect(hasGatheredContent({})).toBe(false);
    expect(hasGatheredContent({ voiceAnchors: [], knowledgeAnchors: [], examples: [] })).toBe(false);
    expect(hasGatheredContent({ personProfile: "  ", imageCaption: "" })).toBe(false);
  });
  it("is true when any slice has content", () => {
    expect(hasGatheredContent({ voiceAnchors: ["a"] })).toBe(true);
    expect(hasGatheredContent({ personProfile: "someone" })).toBe(true);
    expect(hasGatheredContent({ imageCaption: "a chart" })).toBe(true);
  });
});

describe("synthesizeBrief", () => {
  const gathered: GatheredContext = {
    personProfile: "rust tooling author",
    knowledgeAnchors: ["Nella does AST-aware code search"],
    voiceAnchors: ["i ship small and often"],
  };

  it("returns null when there is nothing to distill (no LLM call)", async () => {
    const call = () => Promise.reject(new Error("should not be called"));
    expect(await synthesizeBrief({}, ctx, call)).toBeNull();
  });

  it("parses a well-formed brief", async () => {
    const call = () =>
      Promise.resolve(
        JSON.stringify({
          who: "rust tooling author",
          voiceNotes: "casual, ships often",
          groundedFacts: ["Nella does AST-aware code search"],
          examplesThatWorked: [],
          avoidLikeThis: ["great post!"],
          imageContext: null,
        }),
      );
    const brief = await synthesizeBrief(gathered, ctx, call);
    expect(brief).not.toBeNull();
    expect(brief!.who).toBe("rust tooling author");
    expect(brief!.groundedFacts).toEqual(["Nella does AST-aware code search"]);
    expect(brief!.avoidLikeThis).toEqual(["great post!"]);
  });

  it("tolerates a brief wrapped in prose/fences", async () => {
    const call = () =>
      Promise.resolve('Here you go:\n```json\n{"who":null,"voiceNotes":"dry","groundedFacts":[],"examplesThatWorked":[],"avoidLikeThis":[],"imageContext":null}\n```');
    const brief = await synthesizeBrief(gathered, ctx, call);
    expect(brief).not.toBeNull();
    expect(brief!.voiceNotes).toBe("dry");
  });

  it("fails open to null when the synthesizer throws", async () => {
    expect(await synthesizeBrief(gathered, ctx, () => Promise.reject(new Error("503")))).toBeNull();
  });

  it("fails open to null on unparseable output", async () => {
    expect(await synthesizeBrief(gathered, ctx, () => Promise.resolve("no json here"))).toBeNull();
  });

  it("caps array fields", async () => {
    const call = () =>
      Promise.resolve(
        JSON.stringify({
          groundedFacts: Array.from({ length: 20 }, (_, i) => `f${i}`),
          avoidLikeThis: Array.from({ length: 20 }, (_, i) => `n${i}`),
          examplesThatWorked: Array.from({ length: 20 }, (_, i) => `e${i}`),
        }),
      );
    const brief = await synthesizeBrief(gathered, ctx, call);
    expect(brief!.groundedFacts.length).toBeLessThanOrEqual(6);
    expect(brief!.avoidLikeThis.length).toBeLessThanOrEqual(3);
    expect(brief!.examplesThatWorked.length).toBeLessThanOrEqual(3);
  });
});

describe("renderBriefBlock", () => {
  const brief: DraftingBrief = {
    who: "a rust tooling author",
    voiceNotes: "casual and concrete",
    groundedFacts: ["Nella does AST-aware code search", "free tier is 5k/mo"],
    examplesThatWorked: ["sccache cut my builds in half"],
    avoidLikeThis: ["great post! 🔥"],
    imageContext: "a flamegraph of a slow build",
  };

  it("renders each present section with clear labels", () => {
    const out = renderBriefBlock(brief);
    expect(out).toContain("WHO YOU'RE REPLYING TO");
    expect(out).toContain("a rust tooling author");
    expect(out).toContain("VOICE TO MATCH");
    expect(out).toContain("GROUNDED FACTS");
    expect(out).toContain("AST-aware code search");
    expect(out).toContain("THE POST'S IMAGE SHOWS");
    expect(out).toContain("flamegraph");
    expect(out).toContain("DO NOT SOUND LIKE THESE");
  });

  it("omits empty sections", () => {
    const out = renderBriefBlock({
      who: null,
      voiceNotes: null,
      groundedFacts: [],
      examplesThatWorked: [],
      avoidLikeThis: [],
      imageContext: null,
    });
    expect(out).toBe("");
  });
});
