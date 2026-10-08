import { describe, expect, it } from "vitest";
import {
  buildSuggestMessages,
  parseSuggestedObjective,
  suggestObjectiveFromAccount,
  OBJECTIVE_SUGGEST_MAX,
} from "./suggest-objective.js";

describe("parseSuggestedObjective", () => {
  it("parses a plain JSON objective", () => {
    expect(parseSuggestedObjective('{"objective":"Grow my AI-agents founder audience with build-in-public reels."}')).toBe(
      "Grow my AI-agents founder audience with build-in-public reels.",
    );
  });
  it("parses a fenced block and collapses whitespace", () => {
    expect(parseSuggestedObjective('```json\n{"objective":"a   b\\nc"}\n```')).toBe("a b c");
  });
  it("returns null on unparseable / blank", () => {
    expect(parseSuggestedObjective("not json")).toBeNull();
    expect(parseSuggestedObjective('{"objective":"   "}')).toBeNull();
  });
  it("clamps to the max length", () => {
    const long = "x".repeat(OBJECTIVE_SUGGEST_MAX + 50);
    expect(parseSuggestedObjective(JSON.stringify({ objective: long }))?.length).toBe(OBJECTIVE_SUGGEST_MAX);
  });
});

describe("buildSuggestMessages", () => {
  it("includes profile, captions and brand context when present", () => {
    const { prompt } = buildSuggestMessages({
      accountProfile: "founder building in public",
      captions: ["day 12 of building Noelle"],
      brandContext: ["Noelle is an AI agent org-chart"],
    });
    expect(prompt).toContain("founder building in public");
    expect(prompt).toContain("day 12 of building Noelle");
    expect(prompt).toContain("Noelle is an AI agent org-chart");
  });
});

describe("suggestObjectiveFromAccount", () => {
  it("returns null with no signal (no profile/captions/brand)", async () => {
    await expect(suggestObjectiveFromAccount({ captions: [] })).resolves.toBeNull();
  });
  it("returns the parsed objective from the injected call", async () => {
    const out = await suggestObjectiveFromAccount(
      { accountProfile: "p", captions: ["c"] },
      { call: async () => ({ text: '{"objective":"My niche objective."}' }) },
    );
    expect(out).toBe("My niche objective.");
  });
  it("fails open to null when the call throws", async () => {
    const out = await suggestObjectiveFromAccount(
      { captions: ["c"] },
      { call: async () => { throw new Error("bedrock down"); } },
    );
    expect(out).toBeNull();
  });
});
