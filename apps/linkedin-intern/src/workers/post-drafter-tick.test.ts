import { afterEach, describe, it, expect, vi } from "vitest";
import * as runtime from "@noelle/runtime";
import { runPostDrafterTick } from "./post-drafter-tick.js";
import type { ApprovedIdea } from "../lib/post-ideas-db.js";
import type { PostDraftContext } from "../lib/post-drafter.js";
import type { ActiveInstance } from "../lib/activation.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const instance = {
  id: "i1",
  org_id: "o1",
  model_overrides: null,
  objective: null,
} as unknown as ActiveInstance;

const idea: ApprovedIdea = {
  id: "idea-1",
  orgId: "o1",
  agentInstanceId: "i1",
  platform: "linkedin",
  targetPlatforms: ["linkedin"],
  pendingPlatforms: null,
  generationRequestId: null,
  generationReviewRequired: false,
  hook: "Stop hiring seniors",
  thesis: "juniors compound",
  angle: "contrarian",
  pillar: "hiring",
  inspirationRefs: [],
};

const ctx: PostDraftContext = {
  hook: idea.hook,
  thesis: idea.thesis,
  angle: idea.angle,
  pillar: idea.pillar,
  voiceAnchors: ["blunt lowercase"],
  inspirationExcerpts: [],
  hookPatterns: [],
  standingRules: [],
  chatGuidance: [],
};

describe("runPostDrafterTick", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([false, true])("reviews the exact link-free retained post (repair=%s)", async (repair) => {
    const verdict = (pass: boolean) => ({
      pass, judgeOk: true, judgeProvider: "legacy", reasons: [], fix: "narrow the claim",
      scores: { voice: pass ? 0.9 : 0.4, grounding: 0.9, relevance: 0.9, format: 1, novelty: 1, diversity: 1 },
    });
    const review = vi.spyOn(runtime, "verifyTiered").mockResolvedValueOnce(verdict(!repair) as never);
    if (repair) review.mockResolvedValueOnce(verdict(true) as never);
    const runner = { draft: vi.fn()
      .mockResolvedValueOnce({ text: JSON.stringify({ body: "Original — https://example.com/a body" }), engine: "original", model: "original-model" })
      .mockResolvedValueOnce({ text: JSON.stringify({ body: "Repair — example.com/b body" }), engine: "repair", model: "repair-model" }),
    };
    const sink = vi.fn().mockResolvedValue({ draft_id: "saved" });
    await runPostDrafterTick({
      log, instance, ideas: [idea], gather: async () => ctx, runner,
      makeVerifierCalls: () => [vi.fn()], verifyRetries: 1, sink, release: vi.fn(),
    });
    const saved = sink.mock.calls[0]![0];
    const reviewed = review.mock.calls.at(-1)![0][0]!;
    expect(reviewed.body).toBe(saved.body);
    expect(review.mock.calls.every(([drafts]) => drafts.every((draft) => !draft.body.includes("example.com")))).toBe(true);
    expect(saved).toMatchObject({ sourceEngine: repair ? "repair" : "original", model: repair ? "repair-model" : "original-model" });
    expect(saved.charCount).toBe(saved.body.length);
    expect(saved.hook).toBe(saved.body);
  });

  it("releases a URL-only post without judging or saving an empty body", async () => {
    const review = vi.spyOn(runtime, "verifyTiered");
    const runner = { draft: vi.fn().mockResolvedValue({
      text: JSON.stringify({ body: "https://example.com/a" }), engine: "writer", model: "model",
    }) };
    const sink = vi.fn();
    const release = vi.fn().mockResolvedValue(undefined);
    const count = await runPostDrafterTick({
      log, instance, ideas: [idea], gather: async () => ctx, runner,
      makeVerifierCalls: () => [vi.fn()], verifyRetries: 1, sink, release,
    });
    expect(count).toBe(0);
    expect(review).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(idea.id);
  });

  it.each([
    { label: "passing repair with a lower aggregate score", pass: true, scores: [0.71, 0.71, 0.71], body: "repair body", engine: "repair-engine", model: "repair-model" },
    { label: "retained original after a weaker failed repair", pass: false, scores: [0.4, 0.4, 0.4], body: "original body", engine: "original-engine", model: "original-model" },
    { label: "retained original after an unparsable repair", pass: false, scores: null, body: "original body", engine: "original-engine", model: "original-model" },
  ])("saves the selected body and its provenance: $label", async ({ pass, scores, body, engine, model }) => {
    const verdict = (passed: boolean, values: number[]) => ({
      pass: passed, judgeOk: true, judgeProvider: "legacy", reasons: [], fix: "narrow the claim",
      scores: { voice: values[0], grounding: values[1], relevance: values[2], format: 1, novelty: 1, diversity: 1 },
    });
    const review = vi.spyOn(runtime, "verifyTiered")
      .mockResolvedValueOnce(verdict(false, [0.6, 1, 1]) as never);
    if (scores) review.mockResolvedValueOnce(verdict(pass, scores) as never);
    const runner = { draft: vi.fn()
      .mockResolvedValueOnce({ text: JSON.stringify({ body: "original body" }), engine: "original-engine", model: "original-model" })
      .mockResolvedValueOnce({ text: scores ? JSON.stringify({ body: "repair body" }) : "not json", engine: "repair-engine", model: "repair-model" }),
    };
    const sink = vi.fn().mockResolvedValue({ draft_id: "saved" });
    await runPostDrafterTick({
      log, instance, ideas: [idea], gather: async () => ctx,
      runner, makeVerifierCalls: () => [vi.fn()], verifyRetries: 1,
      sink, release: vi.fn(),
    });
    expect(sink.mock.calls[0]![0]).toMatchObject({
      body, sourceEngine: engine, model, qualityPassed: pass,
      verifierMeta: { pass, attempts: 1 },
    });
  });

  it("gives the writer and judge the same bounded factual support for an X original", async () => {
    const runner = {
      draft: vi
        .fn()
        .mockResolvedValue({
          text: JSON.stringify({ body: "p95 fell from 210ms to 180ms after the cache change" }),
          engine: "b",
          model: "m",
        }),
    };
    const judge = vi
      .fn()
      .mockResolvedValue(
        JSON.stringify({
          voice: 0.9,
          grounding: 0.9,
          relevance: 0.9,
          reasons: ["supported measurement"],
        }),
      );
    const sink = vi.fn().mockResolvedValue({ draft_id: "d1" });
    await runPostDrafterTick({
      log,
      instance,
      ideas: [{ ...idea, targetPlatforms: ["x"], pendingPlatforms: ["x"] }],
      gather: async () => ({
        ...ctx,
        knowledgeAnchors: ["[release.md:4-5] p95 fell from 210ms to 180ms"],
        chatGuidance: ["The measurement came from our cache benchmark"],
      }),
      runner,
      makeVerifierCalls: () => [judge],
      verifyRetries: 0,
      sink,
      release: vi.fn(),
    });
    const writerPrompt = runner.draft.mock.calls[0]![0]!.prompt as string;
    const judgePrompt = judge.mock.calls[0]![1] as string;
    for (const prompt of [writerPrompt, judgePrompt]) {
      expect(prompt).toContain("[release.md:4-5] p95 fell from 210ms to 180ms");
      expect(prompt).toContain("The measurement came from our cache benchmark");
      expect(prompt).toContain("ideas, not evidence");
    }
    expect(sink.mock.calls[0]![0]!.platform).toBe("x");
  });

  it("drafts, sanitizes em dashes, and sinks (verifier off)", async () => {
    const runner = {
      draft: vi.fn().mockResolvedValue({
        text: JSON.stringify({ body: "I hire juniors — they compound." }),
        engine: "bedrock",
        model: "opus",
      }),
    };
    const sink = vi.fn().mockResolvedValue({ draft_id: "d1" });
    const release = vi.fn();

    const n = await runPostDrafterTick({
      log,
      instance,
      ideas: [idea],
      gather: async () => ctx,
      runner,
      makeVerifierCalls: () => [], // verify off
      verifyRetries: 2,
      sink,
      release,
    });

    expect(n).toBe(1);
    const sunk = sink.mock.calls[0]![0];
    // em dash replaced by the sanitizer (no '—' in final body)
    expect(sunk.body).not.toMatch(/—/);
    expect(sunk.sourceEngine).toBe("bedrock");
    expect(sunk.model).toBe("opus");
    expect(sunk.qualityPassed).toBeNull(); // verifier off → no meta
    expect(release).not.toHaveBeenCalled();
  });

  it("releases the idea on a parse failure", async () => {
    const runner = {
      draft: vi.fn().mockResolvedValue({ text: "not json", engine: "b", model: "m" }),
    };
    const sink = vi.fn();
    const release = vi.fn().mockResolvedValue(undefined);

    const n = await runPostDrafterTick({
      log,
      instance,
      ideas: [idea],
      gather: async () => ctx,
      runner,
      makeVerifierCalls: () => [],
      verifyRetries: 2,
      sink,
      release,
    });

    expect(n).toBe(0);
    expect(sink).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith("idea-1");
  });

  it("runs the verifier and attaches a verdict when judges are provided", async () => {
    const goodPost = JSON.stringify({ body: "I hire juniors. They compound fast." });
    const runner = {
      draft: vi.fn().mockResolvedValue({ text: goodPost, engine: "b", model: "m" }),
    };
    // A judge that passes everything.
    const passJudge = vi.fn().mockResolvedValue(
      JSON.stringify({
        voice: 0.9,
        grounding: 0.9,
        relevance: 0.9,
        reasons: ["on voice"],
      }),
    );
    const sink = vi.fn().mockResolvedValue({ draft_id: "d1" });

    const n = await runPostDrafterTick({
      log,
      instance,
      ideas: [idea],
      gather: async () => ctx,
      runner,
      makeVerifierCalls: () => [passJudge],
      verifyRetries: 2,
      sink,
      release: vi.fn(),
    });

    expect(n).toBe(1);
    expect(passJudge).toHaveBeenCalled();
    const sunk = sink.mock.calls[0]![0];
    expect(sunk.verifierMeta).not.toBeNull();
    expect(sunk.verifierMeta.judgeOk).toBe(true);
    expect(sunk.verifierMeta.judgeProvider).toBe("legacy");
    expect(typeof sunk.qualityPassed).toBe("boolean");
  });

  it("fresh generate fans out into 3 X versions + 1 LinkedIn", async () => {
    const runner = {
      draft: vi
        .fn()
        .mockResolvedValue({ text: JSON.stringify({ body: "a post" }), engine: "b", model: "m" }),
    };
    const sink = vi.fn().mockResolvedValue({ draft_id: "d" });
    const clearPending = vi.fn().mockResolvedValue(undefined);
    const release = vi.fn();

    const n = await runPostDrafterTick({
      log,
      instance,
      ideas: [{ ...idea, targetPlatforms: ["linkedin", "x"], pendingPlatforms: null }],
      gather: async () => ctx,
      runner,
      makeVerifierCalls: () => [],
      verifyRetries: 2,
      sink,
      release,
      clearPending,
    });

    // "the three posts for X, and the linkedin post": X yields 3 versions, LI 1.
    expect(n).toBe(4);
    const platforms = sink.mock.calls.map((c) => c[0]!.platform).sort();
    expect(platforms).toEqual(["linkedin", "x", "x", "x"]);
    // Each platform got its OWN system prompt (X is ruthlessly short; LinkedIn is not).
    const systems = runner.draft.mock.calls.map((c) => c[0]!.system as string);
    expect(systems.some((s) => s.includes("X (Twitter) posts") && s.includes("HARD CAP 280"))).toBe(
      true,
    );
    expect(
      systems.some(
        (s) => s.includes("You write LinkedIn posts") && !s.includes("X (Twitter) posts"),
      ),
    ).toBe(true);
    expect(clearPending).toHaveBeenCalledWith("idea-1");
    expect(release).not.toHaveBeenCalled();
  });

  it("pending_platforms scopes a regen to a subset (X only)", async () => {
    const runner = {
      draft: vi
        .fn()
        .mockResolvedValue({ text: JSON.stringify({ body: "x post" }), engine: "b", model: "m" }),
    };
    const sink = vi.fn().mockResolvedValue({ draft_id: "d" });
    const clearPending = vi.fn().mockResolvedValue(undefined);

    const n = await runPostDrafterTick({
      log,
      instance,
      ideas: [{ ...idea, targetPlatforms: ["linkedin", "x"], pendingPlatforms: ["x"] }],
      gather: async () => ctx,
      runner,
      makeVerifierCalls: () => [],
      verifyRetries: 2,
      sink,
      release: vi.fn(),
      clearPending,
    });

    expect(n).toBe(1);
    expect(sink.mock.calls[0]![0]!.platform).toBe("x");
    expect(clearPending).toHaveBeenCalledWith("idea-1");
  });

  it("a single platform parse-fail keeps the other platform's draft (no release)", async () => {
    // LinkedIn (first in target order) returns valid JSON; X returns junk → only
    // the LinkedIn draft lands and the idea is NOT released (one platform won).
    const runner = {
      draft: vi
        .fn()
        .mockResolvedValueOnce({
          text: JSON.stringify({ body: "li post" }),
          engine: "b",
          model: "m",
        })
        .mockResolvedValueOnce({ text: "not json", engine: "b", model: "m" }),
    };
    const sink = vi.fn().mockResolvedValue({ draft_id: "d" });
    const release = vi.fn();
    const clearPending = vi.fn().mockResolvedValue(undefined);

    const n = await runPostDrafterTick({
      log,
      instance,
      ideas: [{ ...idea, targetPlatforms: ["linkedin", "x"], pendingPlatforms: null }],
      gather: async () => ctx,
      runner,
      makeVerifierCalls: () => [],
      verifyRetries: 2,
      sink,
      release,
      clearPending,
    });

    expect(n).toBe(1);
    expect(sink.mock.calls[0]![0]!.platform).toBe("linkedin");
    expect(release).not.toHaveBeenCalled();
    expect(clearPending).toHaveBeenCalledWith("idea-1");
  });

  it("verifies and regenerates MCP posts as original posts", async () => {
    const runner = {
      draft: vi
        .fn()
        .mockResolvedValueOnce({
          text: JSON.stringify({ body: "first post" }),
          engine: "b",
          model: "m",
        })
        .mockResolvedValueOnce({
          text: JSON.stringify({ body: "better post" }),
          engine: "b",
          model: "m",
        }),
    };
    const judge = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          voice: 0.4,
          grounding: 0.9,
          relevance: 0.9,
          reasons: ["too generic"],
          fix: "make the original post more specific",
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({ voice: 0.9, grounding: 0.9, relevance: 0.9, reasons: [], fix: null }),
      );
    const sink = vi.fn().mockResolvedValue({ draft_id: "d1" });

    await runPostDrafterTick({
      log,
      instance,
      ideas: [
        {
          ...idea,
          generationRequestId: "11111111-1111-1111-1111-111111111111",
          generationReviewRequired: true,
        },
