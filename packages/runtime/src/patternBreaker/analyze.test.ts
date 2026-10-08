import { PatternFindingSchema } from "@noelle/contracts";
import { describe, expect, it, vi } from "vitest";
import { analyzePatterns, refineRule, type PatternPost } from "./analyze.js";

// A corpus where 6 of the last 10 posts end on a tacked-on "congrats".
function congratsCorpus(): PatternPost[] {
  const withCongrats = Array.from({ length: 6 }, (_, i) => ({
    draftId: `d${i}`,
    kind: "reply" as const,
    body: `Real substantive take number ${i} about shipping software and the tradeoffs involved. congrats`,
  }));
  const clean = Array.from({ length: 4 }, (_, i) => ({
    draftId: `c${i}`,
    kind: "reply" as const,
    body: `A genuinely varied thought number ${i} with no formulaic ending at all here`,
  }));
  // newest-first; interleave so the phrase spans the recent window
  return [...withCongrats, ...clean];
}

const phraseFinding = JSON.stringify({
  findings: [
    {
      label: "tacked-on 'congrats' closer",
      kind: "phrase",
      description: "Most recent posts end with a bare 'congrats'.",
      instruction: "Do not end a substantive post with a bare 'congrats'; end on the actual point.",
      regex: "congrats",
      severity: "high",
      frequencyCount: 6,
      examples: [{ draftId: "0", snippet: "...involved. congrats" }],
    },
  ],
});

function lessonCorpus(size = 10): PatternPost[] {
  const repeated = [
    {
      draftId: "actual-0",
      kind: "reply" as const,
      body: "The launch slipped because review came late. It ends by turning the delay into a lesson about trust.",
    },
    {
      draftId: "actual-1",
      kind: "reply" as const,
      body: "The metrics improved after the retry guard. The ending turns the result into a lesson about trust.",
    },
    {
      draftId: "actual-2",
      kind: "reply" as const,
      body: "The migration worked after the checksum fix. It closes by making the incident a lesson about trust.",
    },
  ];
  const rest = Array.from({ length: Math.max(0, size - repeated.length) }, (_, i) => ({
    draftId: `clean-${i}`,
    kind: "reply" as const,
    body: `Clean reply ${i} with a different shape and a source-specific ending.`,
  }));
  return [...repeated, ...rest];
}

describe("analyzePatterns", () => {
  it("returns [] for an empty corpus without calling the LLM", async () => {
    const call = vi.fn();
    const out = await analyzePatterns({ posts: [], call });
    expect(out).toEqual([]);
    expect(call).not.toHaveBeenCalled();
  });

  it("recounts a phrase finding deterministically and picks the tightest window", async () => {
    const out = await analyzePatterns({
      posts: congratsCorpus(),
      call: () => Promise.resolve(phraseFinding),
      minFrequency: 3,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.finding.kind).toBe("phrase");
    // 6 hits inside the 10-post window → tightest window is 10.
    expect(out[0]!.windowSize).toBe(10);
    // frequencyCount is the DETERMINISTIC recount, not the LLM's claim.
    expect(out[0]!.finding.frequencyCount).toBe(6);
  });

  it("recounts an explicit lowercase-opener rule without counting uppercase posts", async () => {
    const posts: PatternPost[] = Array.from({ length: 10 }, (_, i) => ({
      draftId: `case-${i}`,
      kind: "reply",
      body: i < 4 ? `lowercase reply number ${i}` : `Uppercase reply number ${i}`,
    }));
    const finding = JSON.stringify({
      findings: [{
        label: "lowercase opener",
        kind: "phrase",
        description: "Several replies begin with lowercase letters.",
        instruction: "Vary lowercase first words.",
        regex: "^[a-z]",
        severity: "medium",
        frequencyCount: 10,
        examples: [],
      }],
    });
    const out = await analyzePatterns({ posts, call: () => Promise.resolve(finding), minFrequency: 3 });
    expect(out).toHaveLength(1);
    expect(out[0]!.finding.frequencyCount).toBe(4);
    expect(out[0]!.finding.examples.every((example) => example.snippet.startsWith("l"))).toBe(true);
  });

  it("keeps the rest of a compound opener rule case-insensitive", async () => {
    const posts: PatternPost[] = Array.from({ length: 10 }, (_, i) => ({
      draftId: `compound-${i}`,
      kind: "reply",
      body: i < 4 ? `lowercase Maintenance note ${i}` : `Uppercase maintenance note ${i}`,
    }));
    const finding = JSON.stringify({ findings: [{
      label: "lowercase maintenance opener",
      kind: "phrase",
      description: "Several lowercase openings mention maintenance.",
      instruction: "Vary the lowercase opener.",
      regex: "^[a-z].*maintenance",
      severity: "medium",
      frequencyCount: 10,
      examples: [],
    }] });
    const out = await analyzePatterns({ posts, call: () => Promise.resolve(finding), minFrequency: 3 });
    expect(out).toHaveLength(1);
    expect(out[0]!.finding.frequencyCount).toBe(4);
  });

  it("threads the 'do this instead' suggestion through the deterministic recount", async () => {
    const withSuggestion = JSON.stringify({
      findings: [
        {
          label: "tacked-on 'congrats' closer",
          kind: "phrase",
          description: "Most recent posts end with a bare 'congrats'.",
          instruction: "Do not end a substantive post with a bare 'congrats'; end on the actual point.",
          suggestion: "Land on the sharpest concrete point and let it stand.",
          regex: "congrats",
          severity: "high",
          frequencyCount: 6,
          examples: [{ draftId: "0", snippet: "...involved. congrats" }],
        },
      ],
    });
    const out = await analyzePatterns({
      posts: congratsCorpus(),
      call: () => Promise.resolve(withSuggestion),
      minFrequency: 3,
    });
    expect(out).toHaveLength(1);
    // The recount rebuilds the finding ({...normalized, frequencyCount}); the
    // positive mirror must survive that spread.
    expect(out[0]!.finding.suggestion).toBe("Land on the sharpest concrete point and let it stand.");
  });

  it("drops a phrase finding that is not actually over-represented", async () => {
    // LLM claims 'congrats' is everywhere, but the corpus only has it once.
    const onePost: PatternPost[] = [
      { draftId: "a", kind: "reply", body: "the only post that says congrats here" },
      ...Array.from({ length: 9 }, (_, i) => ({ draftId: `b${i}`, kind: "reply" as const, body: `clean post ${i}` })),
    ];
    const out = await analyzePatterns({ posts: onePost, call: () => Promise.resolve(phraseFinding), minFrequency: 3 });
    expect(out).toEqual([]);
  });

  it("bounds phrase examples rebuilt from broad regex matches", async () => {
    const longSegment = "Long exact source sentence. ".repeat(30);
    const posts: PatternPost[] = Array.from({ length: 3 }, (_, i) => ({
      draftId: `real-draft-${i}`,
      kind: "reply",
      body: `${longSegment}short-match-${i}`,
    }));
    const broadFinding = JSON.stringify({
      findings: [
        {
          label: "entire post regex",
          kind: "phrase",
          description: "A broad regex matched whole long posts.",
          instruction: "Do not use a broad regex rule that stores an entire long post as an example.",
          regex: "[\\s\\S]+",
          severity: "medium",
          frequencyCount: 99,
          examples: [{ draftId: "0", snippet: "placeholder" }],
        },
        {
          label: "short phrase regex",
          kind: "phrase",
          description: "A short literal phrase appears repeatedly.",
          instruction: "Do not repeat the short literal phrase in every post.",
          regex: "short-match",
          severity: "low",
          frequencyCount: 3,
          examples: [{ draftId: "0", snippet: "placeholder" }],
        },
      ],
    });

    const out = await analyzePatterns({ posts, call: () => Promise.resolve(broadFinding), minFrequency: 3 });

    expect(out).toHaveLength(2);
