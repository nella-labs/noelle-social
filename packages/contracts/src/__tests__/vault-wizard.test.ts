import { describe, it, expect } from "vitest";
import {
  LightAnswersSchema,
  MediumAnswersSchema,
  RichAnswersSchema,
} from "../vault-wizard.js";

describe("vault-wizard contracts", () => {
  it("LightAnswersSchema requires personName, oneLineWhat, audience", () => {
    const ok = LightAnswersSchema.safeParse({
      personName: "Ada",
      oneLineWhat: "we build agent infra",
      audience: "indie builders",
    });
    expect(ok.success).toBe(true);

    const bad = LightAnswersSchema.safeParse({ personName: "" });
    expect(bad.success).toBe(false);
  });

  it("MediumAnswersSchema extends LightAnswers with do/don't/pillars", () => {
    const ok = MediumAnswersSchema.safeParse({
      personName: "Ada",
      oneLineWhat: "we build agent infra",
      audience: "indie builders",
      voiceDos: ["direct", "specific", "honest"],
      voiceDonts: ["no hype", "no fake certainty", "no excited to announce"],
      bannedPhrases: ["simply", "leverage"],
      contentPillars: ["building", "founder-life", "technical"],
    });
    expect(ok.success).toBe(true);
  });

  it("MediumAnswersSchema rejects fewer than 3 voiceDos", () => {
    const bad = MediumAnswersSchema.safeParse({
      personName: "Ada",
      oneLineWhat: "we build",
      audience: "builders",
      voiceDos: ["only one"],
      voiceDonts: ["a", "b", "c"],
      bannedPhrases: [],
      contentPillars: ["a", "b", "c"],
    });
    expect(bad.success).toBe(false);
  });

  it("RichAnswersSchema extends MediumAnswers with cadence + samples", () => {
    const ok = RichAnswersSchema.safeParse({
      personName: "Ada",
      oneLineWhat: "we build",
      audience: "builders",
      voiceDos: ["a", "b", "c"],
      voiceDonts: ["a", "b", "c"],
      bannedPhrases: [],
      contentPillars: ["a", "b", "c"],
      cadenceExamples: ["short. short. long.", "fragment.", "two lines."],
      samplePosts: ["a", "b", "c"],
    });
    expect(ok.success).toBe(true);
  });
});
