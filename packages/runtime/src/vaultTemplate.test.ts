import { describe, it, expect } from "vitest";
import { renderVaultTemplate } from "./vaultTemplate.js";

const lightAnswers = {
  personName: "Ada",
  oneLineWhat: "We ship reliable AI agents.",
  audience: "Builders sick of agent hype.",
};

describe("renderVaultTemplate — light", () => {
  it("renders the canonical 12 light-stage files", () => {
    const files = renderVaultTemplate({
      stage: "light",
      answers: lightAnswers,
      slug: "acme",
    });
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual([
      "00-vault-map.md",
      "01-business/company.md",
      "02-brand/brand.md",
      "02-brand/voice-and-style.md",
      "03-voice-anchors/cadence.md",
      "03-voice-anchors/tone-rules.md",
      "03-voice-anchors/writing-rules.md",
      "04-content-system/weekly-themes.md",
      "05-templates/reply-contrarian.md",
      "05-templates/reply-empathetic.md",
      "05-templates/reply-technical.md",
      "06-inbox/README.md",
    ]);
  });

  it("substitutes personName, oneLineWhat, audience in light files", () => {
    const files = renderVaultTemplate({
      stage: "light",
      answers: lightAnswers,
      slug: "acme",
    });
    const map = Object.fromEntries(files.map((f) => [f.path, f.body]));
    expect(map["01-business/company.md"]).toContain("We ship reliable AI agents.");
    expect(map["01-business/company.md"]).toContain("Builders sick of agent hype.");
    expect(map["02-brand/brand.md"]).toContain("Ada");
    expect(map["02-brand/voice-and-style.md"]).toContain("person: Ada");
    expect(map["00-vault-map.md"]).toContain("Ada");
  });

  it("omits Medium/Rich sections when those answers are absent", () => {
    const files = renderVaultTemplate({
      stage: "light",
      answers: lightAnswers,
      slug: "acme",
    });
    const map = Object.fromEntries(files.map((f) => [f.path, f.body]));
    expect(map["02-brand/voice-and-style.md"]).not.toContain("## Do\n");
    expect(map["02-brand/voice-and-style.md"]).not.toContain("## Don't\n");
    expect(map["02-brand/voice-and-style.md"]).not.toContain("## Cadence examples");
    expect(map["03-voice-anchors/cadence.md"]).not.toContain("## Your cadence examples");
  });
});

const mediumAnswers = {
  ...lightAnswers,
  voiceDos: ["Direct.", "Specific numbers.", "Honest uncertainty."],
  voiceDonts: ["No hype.", "No fake certainty.", "No 'excited to announce'."],
  bannedPhrases: ["simply", "leverage"],
  contentPillars: ["building", "founder-life", "technical"],
};

describe("renderVaultTemplate — medium", () => {
  it("emits the light files plus banned-phrases.md and pillars.md", () => {
    const files = renderVaultTemplate({
      stage: "medium",
      answers: mediumAnswers,
      slug: "acme",
    });
    const paths = files.map((f) => f.path).sort();
    expect(paths).toContain("03-voice-anchors/banned-phrases.md");
    expect(paths).toContain("04-content-system/pillars.md");
    expect(paths.length).toBe(14);
  });

  it("renders do's, don'ts, banned phrases, and pillars", () => {
    const files = renderVaultTemplate({
      stage: "medium",
      answers: mediumAnswers,
      slug: "acme",
    });
    const map = Object.fromEntries(files.map((f) => [f.path, f.body]));
    expect(map["02-brand/voice-and-style.md"]).toContain("- Direct.");
    expect(map["02-brand/voice-and-style.md"]).toContain("- No hype.");
    expect(map["03-voice-anchors/banned-phrases.md"]).toContain("- simply");
    expect(map["03-voice-anchors/banned-phrases.md"]).not.toContain("(pillar 1)");
    expect(map["04-content-system/pillars.md"]).toContain("- building");
    expect(map["02-brand/brand.md"]).toContain("- founder-life");
  });

  it("falls back to default lists when banned-phrases is empty", () => {
    const files = renderVaultTemplate({
      stage: "medium",
      answers: { ...mediumAnswers, bannedPhrases: [] },
      slug: "acme",
    });
    const banned = files.find((f) => f.path === "03-voice-anchors/banned-phrases.md");
    expect(banned?.body).toContain("- excited to announce");
  });
});

const richAnswers = {
  ...mediumAnswers,
  cadenceExamples: [
    "short. short. long.",
    "fragment.",
    "two lines\nthen one.",
  ],
  samplePosts: [
    "Past post one body.",
    "Past post two body.",
    "Past post three body.",
  ],
};

describe("renderVaultTemplate — rich", () => {
  it("emits 15 files including samples.md", () => {
    const files = renderVaultTemplate({
      stage: "rich",
      answers: richAnswers,
      slug: "acme",
    });
    const paths = files.map((f) => f.path).sort();
    expect(paths).toContain("content/voice-anchors/samples.md");
    expect(paths.length).toBe(15);
  });

  it("renders cadence examples in voice-and-style.md and cadence.md", () => {
    const files = renderVaultTemplate({
      stage: "rich",
      answers: richAnswers,
      slug: "acme",
    });
    const map = Object.fromEntries(files.map((f) => [f.path, f.body]));
    expect(map["02-brand/voice-and-style.md"]).toContain("> short. short. long.");
    expect(map["03-voice-anchors/cadence.md"]).toContain("> fragment.");
  });

  it("concatenates sample posts into samples.md", () => {
    const files = renderVaultTemplate({
      stage: "rich",
      answers: richAnswers,
      slug: "acme",
    });
    const samples = files.find((f) => f.path === "content/voice-anchors/samples.md");
    expect(samples?.body).toContain("Past post one body.");
    expect(samples?.body).toContain("Past post three body.");
    expect(samples?.body).not.toContain("(No samples yet.");
  });
});
