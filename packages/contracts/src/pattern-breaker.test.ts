import { describe, it, expect } from "vitest";
import {
  PatternFindingSchema,
  PatternAnalysisSchema,
  PatternAlertViewSchema,
  PatternRefineInputSchema,
} from "./pattern-breaker.js";

describe("PatternFindingSchema", () => {
  const base = {
    label: "tacked-on congrats closer",
    kind: "phrase" as const,
    description: "Recent posts end with a bare 'congrats'.",
    instruction: "Do not end a substantive post with a bare 'congrats'.",
    regex: "congrats",
    severity: "high" as const,
    frequencyCount: 6,
    examples: [{ draftId: "0", snippet: "...involved. congrats" }],
  };

  it("accepts a well-formed phrase finding", () => {
    expect(PatternFindingSchema.parse(base).label).toBe("tacked-on congrats closer");
  });

  it("accepts an optional 'do this instead' suggestion, and omits it cleanly", () => {
    const withSug = PatternFindingSchema.parse({ ...base, suggestion: "End on the actual point." });
    expect(withSug.suggestion).toBe("End on the actual point.");
    // suggestion is optional — a finding without one still parses.
    expect(PatternFindingSchema.parse(base).suggestion).toBeUndefined();
  });

  it("allows a null regex (structure finding) and defaults examples to []", () => {
    const f = PatternFindingSchema.parse({ ...base, kind: "structure", regex: null, examples: undefined });
    expect(f.regex).toBeNull();
    expect(f.examples).toEqual([]);
  });

  it("accepts optional source evidence for analyzer-side verification", () => {
    const f = PatternFindingSchema.parse({
      ...base,
      kind: "structure",
      regex: null,
      evidence: [{ sourceIndex: 2, snippet: "same ending move" }],
    });
    expect(f.evidence).toEqual([{ sourceIndex: 2, snippet: "same ending move" }]);
  });

  it("rejects malformed evidence indices and empty snippets", () => {
    expect(
      PatternFindingSchema.safeParse({
        ...base,
        kind: "structure",
        regex: null,
        evidence: [{ sourceIndex: "2junk", snippet: "same ending move" }],
      }).success,
    ).toBe(false);
    expect(
      PatternFindingSchema.safeParse({
        ...base,
        kind: "structure",
        regex: null,
        evidence: [{ sourceIndex: 2.5, snippet: "same ending move" }],
      }).success,
    ).toBe(false);
    expect(
      PatternFindingSchema.safeParse({
        ...base,
        kind: "structure",
        regex: null,
        evidence: [{ sourceIndex: 2, snippet: "" }],
      }).success,
    ).toBe(false);
  });

  it("caps raw evidence at the analyzer corpus size", () => {
    expect(
      PatternFindingSchema.safeParse({
        ...base,
        kind: "structure",
        regex: null,
        evidence: Array.from({ length: 101 }, (_, i) => ({ sourceIndex: i, snippet: `snippet ${i}` })),
      }).success,
    ).toBe(false);
  });

  it("rejects a too-short instruction (prevents junk rules)", () => {
    expect(PatternFindingSchema.safeParse({ ...base, instruction: "stop" }).success).toBe(false);
  });

  it("rejects an unknown severity", () => {
    expect(PatternFindingSchema.safeParse({ ...base, severity: "critical" }).success).toBe(false);
  });

  it("PatternAnalysisSchema defaults findings to []", () => {
    expect(PatternAnalysisSchema.parse({}).findings).toEqual([]);
  });
});

describe("PatternRefineInputSchema", () => {
  it("accepts an empty body (no steer)", () => {
    expect(PatternRefineInputSchema.parse({}).note).toBeUndefined();
  });
  it("accepts a note", () => {
    expect(PatternRefineInputSchema.parse({ note: "only when genuine" }).note).toBe("only when genuine");
  });
});

describe("PatternAlertViewSchema", () => {
  it("round-trips a refining alert", () => {
    const v = PatternAlertViewSchema.parse({
      id: "11111111-1111-1111-1111-111111111111",
      ruleId: "22222222-2222-2222-2222-222222222222",
      patternName: "congrats closer",
      description: "you keep doing X",
      severity: "medium",
      windowSize: 10,
      frequencyCount: 6,
      examples: [],
      status: "refining",
      ruleInstruction: "Do not end with congrats.",
      suggestion: "End on the actual point instead.",
      createdAt: "2026-06-26T00:00:00Z",
    });
    expect(v.status).toBe("refining");
    expect(v.suggestion).toBe("End on the actual point instead.");
  });

  it("accepts a null suggestion (rule has none / was deleted)", () => {
    const v = PatternAlertViewSchema.parse({
      id: "11111111-1111-1111-1111-111111111111",
      ruleId: null,
      patternName: "congrats closer",
      description: "you keep doing X",
      severity: "low",
      windowSize: 10,
      frequencyCount: 6,
      examples: [],
      status: "open",
      ruleInstruction: null,
      suggestion: null,
      createdAt: "2026-06-26T00:00:00Z",
    });
    expect(v.suggestion).toBeNull();
  });
});
it("retains a typed expected-request retry and rejects malformed identities", () => {
  const expectedRequestId = "11111111-1111-4111-8111-111111111111";
  expect(
    PatternRefineInputSchema.parse({ expectedRequestId, note: "Keep the useful supportive detail" }),
  ).toEqual({ expectedRequestId, note: "Keep the useful supportive detail" });
  expect(PatternRefineInputSchema.safeParse({ expectedRequestId: "unknown" }).success).toBe(false);
});
