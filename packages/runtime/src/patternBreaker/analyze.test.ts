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
    const broad = out.find((entry) => entry.finding.label === "entire post regex");
    const short = out.find((entry) => entry.finding.label === "short phrase regex");
    expect(broad).toBeDefined();
    expect(short).toBeDefined();
    expect(broad!.finding.frequencyCount).toBe(3);
    expect(broad!.finding.examples.map((example) => example.draftId)).toEqual([
      "real-draft-0",
      "real-draft-1",
      "real-draft-2",
    ]);
    expect(broad!.finding.examples.every((example) => example.snippet.length <= 600)).toBe(true);
    expect(posts[0]!.body).toContain(broad!.finding.examples[0]!.snippet);
    expect(PatternFindingSchema.safeParse(broad!.finding).success).toBe(true);
    expect(short!.finding.examples.map((example) => example.snippet)).toEqual(["short-match", "short-match", "short-match"]);
    expect(PatternFindingSchema.safeParse(short!.finding).success).toBe(true);
  });

  it.each(["(unclosed", "(word)\\1", "(?=trust)trust", "(?:a{1000}){1000}"])(
    "keeps an unsupported phrase as structure only with valid evidence: %s", async (regex) => {
    const badRegex = JSON.stringify({
      findings: [
        {
          label: "broken regex pattern",
          kind: "phrase",
          description: "The same broad lesson ending shows up repeatedly.",
          instruction: "Do not force a broad lesson after operational claims.",
          regex,
          severity: "medium",
          frequencyCount: 5,
          examples: [],
          evidence: [
            { sourceIndex: 0, snippet: "turning the delay into a lesson about trust" },
            { sourceIndex: 1, snippet: "turns the result into a lesson about trust" },
            { sourceIndex: 2, snippet: "making the incident a lesson about trust" },
          ],
        },
      ],
    });
    const out = await analyzePatterns({
      posts: lessonCorpus(),
      call: () => Promise.resolve(badRegex),
      minFrequency: 3,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.finding.kind).toBe("structure");
    expect(out[0]!.finding.regex).toBeNull();
  });

  it("dedups against existing active rule labels", async () => {
    const out = await analyzePatterns({
      posts: congratsCorpus(),
      call: () => Promise.resolve(phraseFinding),
      existingLabels: ["Tacked-on 'congrats' closer"], // case-insensitive match
      minFrequency: 3,
    });
    expect(out).toEqual([]);
  });

  it("fails closed (returns []) on unparseable LLM output", async () => {
    const out = await analyzePatterns({ posts: congratsCorpus(), call: () => Promise.resolve("not json at all") });
    expect(out).toEqual([]);
  });

  it("asks the model for source evidence and scoped positive revisions", async () => {
    let system = "";
    await analyzePatterns({
      posts: congratsCorpus(),
      call: async (s) => {
        system = s;
        return JSON.stringify({ findings: [] });
      },
    });
    expect(system).toContain("supporting evidence");
    expect(system).toContain("repeated meaning");
    expect(system).toContain("mere punctuation");
    expect(system).toContain("positive revision");
  });

  it("drops a structure finding without source evidence", async () => {
    const structure = JSON.stringify({
      findings: [
        {
          label: "one-line hook then blank line opener",
          kind: "structure",
          description: "Every recent post opens with a one-line hook then a blank line.",
          instruction: "Vary your openers; don't always lead with a one-line hook followed by a blank line.",
          regex: null,
          severity: "medium",
          frequencyCount: 7,
          examples: [],
        },
      ],
    });
    const out = await analyzePatterns({ posts: congratsCorpus(), call: () => Promise.resolve(structure), minFrequency: 3 });
    expect(out).toEqual([]);
  });

  it("counts only distinct source-grounded structure evidence and remaps examples to draft ids", async () => {
    const structure = JSON.stringify({
      findings: [
        {
          label: "claim-to-lesson ending",
          kind: "structure",
          description: "Recent replies turn an operational claim into the same broad lesson.",
          instruction: "Do not force a broad lesson after operational claims.",
          suggestion: "Use a scoped positive revision tied to the source claim.",
          regex: null,
          severity: "medium",
          frequencyCount: 100,
          examples: [],
          evidence: [
            { sourceIndex: 0, snippet: "turning the delay into a lesson about trust" },
            { sourceIndex: 0, snippet: "turning the delay into a lesson about trust" },
            { sourceIndex: 1, snippet: "turns the result into a lesson about trust" },
            { sourceIndex: 2, snippet: "making the incident a lesson about trust" },
            { sourceIndex: 22, snippet: "out of range" },
            { sourceIndex: 3, snippet: "not actually in this body" },
          ],
        },
      ],
    });
    const out = await analyzePatterns({ posts: lessonCorpus(), call: () => Promise.resolve(structure), minFrequency: 3 });
    expect(out).toHaveLength(1);
    expect(out[0]!.finding.kind).toBe("structure");
    expect(out[0]!.finding.frequencyCount).toBe(3);
    expect(out[0]!.finding.examples).toEqual([
      { draftId: "actual-0", snippet: "turning the delay into a lesson about trust" },
      { draftId: "actual-1", snippet: "turns the result into a lesson about trust" },
      { draftId: "actual-2", snippet: "making the incident a lesson about trust" },
    ]);
    expect(out[0]!.windowSize).toBe(10);
  });

  it("does not count duplicate corpus rows with the same real draft id as distinct structure evidence", async () => {
    const corpus: PatternPost[] = [
      {
        draftId: "same-real-draft",
        kind: "reply",
        body: "First row repeats the same claim-to-lesson ending.",
      },
      {
        draftId: "same-real-draft",
        kind: "reply",
        body: "Second row repeats the same claim-to-lesson ending.",
      },
      {
        draftId: "same-real-draft",
        kind: "reply",
        body: "Third row repeats the same claim-to-lesson ending.",
      },
      ...lessonCorpus(7),
    ];
    const structure = JSON.stringify({
      findings: [
        {
          label: "claim-to-lesson ending",
          kind: "structure",
          description: "The same real draft appears three times with the same structure.",
          instruction: "Do not force a broad lesson after operational claims.",
          regex: null,
          severity: "medium",
          frequencyCount: 3,
          examples: [],
          evidence: [
            { sourceIndex: 0, snippet: "repeats the same claim-to-lesson ending" },
            { sourceIndex: 1, snippet: "repeats the same claim-to-lesson ending" },
            { sourceIndex: 2, snippet: "repeats the same claim-to-lesson ending" },
          ],
        },
      ],
    });
    const out = await analyzePatterns({ posts: corpus, call: () => Promise.resolve(structure), minFrequency: 3 });
    expect(out).toEqual([]);
  });

  it("drops a contradictory structure finding when claimed counts lack real evidence", async () => {
    const structure = JSON.stringify({
      findings: [
        {
          label: "claim-to-lesson ending",
          kind: "structure",
          description: "The model claims this appears everywhere.",
          instruction: "Do not force a broad lesson after operational claims.",
          regex: null,
          severity: "medium",
          frequencyCount: 100,
          examples: [],
          evidence: [{ sourceIndex: 0, snippet: "turning the delay into a lesson about trust" }],
        },
      ],
    });
    const out = await analyzePatterns({ posts: lessonCorpus(), call: () => Promise.resolve(structure), minFrequency: 3 });
    expect(out).toEqual([]);
  });

  it("uses the tightest window that contains enough verified structure evidence", async () => {
    const corpus: PatternPost[] = Array.from({ length: 30 }, (_, i) => ({
      draftId: `p${i}`,
      kind: "post" as const,
      body: i >= 10 && i < 16 ? `Post ${i} repeats the same claim-to-lesson ending.` : `Post ${i} has a different shape.`,
