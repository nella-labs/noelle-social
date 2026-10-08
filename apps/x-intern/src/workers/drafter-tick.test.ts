import { describe, expect, it, vi } from "vitest";
import {
  runDrafterTick,
  runDmRequestTick,
  decideOpus,
  faithfulVerifierVoiceAnchors,
  xReplyStyleCorpusPlan,
  xGenZMarkerRotation,
} from "./drafter-tick.js";
import { BudgetExceededError, GENZ_MARKERS, X_FORM_VARIANTS } from "@noelle/runtime";

// Deterministic rng for the shape-rotation tests (Math.random would make the
// "no two in a row" assertion flaky-looking even though the rotation guarantees it).
const makeLcgForShapes = (seed: number) => () => {
  // Math.imul, NOT `*`: seed * 1103515245 exceeds Number.MAX_SAFE_INTEGER,
  // so the state is ROUNDED before the modulus and the stream collapses —
  // 16403 distinct values in 20000 draws instead of 20000.
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  seed %= 2 ** 31;
  return seed / 2 ** 31;
};

describe("runDrafterTick", () => {
  it("uses the pinned writer's comments as the default faithful reply corpus", () => {
    expect(xReplyStyleCorpusPlan({ pinnedStyleHandle: "eliana_jordan" }, true)).toEqual({
      primary: ["comment"],
      fallback: ["post"],
    });
  });

  it("honors an explicit faithful corpus choice", () => {
    expect(xReplyStyleCorpusPlan({ styleExemplarKinds: ["post"] }, true)).toEqual({
      primary: ["post"],
      fallback: [],
    });
    expect(xReplyStyleCorpusPlan({ styleExemplarKinds: ["comment", "post"] }, true)).toEqual({
      primary: ["comment", "post"],
      fallback: [],
    });
  });

  it("keeps the existing post default outside faithful mode", () => {
    expect(xReplyStyleCorpusPlan({}, false)).toEqual({
      primary: ["post"],
      fallback: [],
    });
  });

  it("gives the verifier the faithful style voice that the writer was told to adopt", () => {
    const anchors = faithfulVerifierVoiceAnchors({
      exemplars: [{
        body: "pinned writer example",
        accountHandle: "eliana_jordan",
        likeCount: 10,
        commentCount: 2,
      }],
      styleNotes: "warm, playful, lowercase",
    });

    expect(anchors).toEqual([
      "@eliana_jordan: pinned writer example",
      "Voice notes: warm, playful, lowercase",
    ]);
  });

  it("posts 3 angles to outbound for each lead", async () => {
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const runner = {
      draft: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          drafts: [
            { angle: "empathetic", body: "e", char_count: 1 },
            { angle: "technical", body: "t", char_count: 1 },
            { angle: "contrarian", body: "c", char_count: 1 },
          ],
        }),
        engine: "codex",
        model: "gpt-5",
      }),
    };
    const nella = {
      search: vi.fn().mockResolvedValue([
        { path: "p.md", snippet: "anchor", score: 8.0, filePath: "p.md", startLine: 1, endLine: 1, highlights: [] },
      ]),
    };
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
    const markStatus = vi.fn().mockResolvedValue(undefined);
    const n = await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o", dm_autodraft_enabled: false },
      claimedLeads: [
        { id: "L", external_id: "x1", payload: { text: "post text", url: "https://x.com/u/status/1" }, author_handle: "u", author_id: "uid", status: "drafting", tier: null, classifier_label: null, classifier_score: null, priority: false },
      ],
      runner: runner as never,
      kb: nella as never,
      postOutbound,
      markStatus,
    });
    expect(n).toBe(1);
    expect(postOutbound).toHaveBeenCalledTimes(1);
    const body = postOutbound.mock.calls[0]![0];
    expect(body.drafts).toHaveLength(3);
    const request = runner.draft.mock.calls[0]![0];
    expect(request.system).toContain("REPLY-ONLY OUTPUT");
    expect(request.prompt).not.toContain("AND one DM");
    expect(request.prompt).not.toContain('"dm"');
  });

  it("drafts an operator-requested reply with guidance, review tags, and no ordinary notification skip", async () => {
    const orgId = "11111111-1111-4111-8111-111111111111";
    const agentInstanceId = "22222222-2222-4222-8222-222222222222";
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const runner = { draft: vi.fn().mockResolvedValue({ text: JSON.stringify({ drafts: [{ angle: "technical", body: "the migration detail is the interesting part", char_count: 44 }] }), engine: "codex", model: "gpt-5" }) };
    const kb = { search: vi.fn().mockResolvedValue([{ path: "p.md", snippet: "anchor", score: 0.1, filePath: "p.md", startLine: 1, endLine: 1, highlights: [] }]) };
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
    const markStatus = vi.fn().mockResolvedValue(undefined);
    const pinNotification = vi.fn();

    const n = await runDrafterTick({
      log,
      instance: { id: agentInstanceId, org_id: orgId },
      claimedLeads: [{
        id: "L", external_id: "x1",
        payload: { text: "thanks!", url: "https://x.com/u/status/1", source: "notification", reply_request: { request_key: "manual-1", instructions: "answer the migration constraint directly", force_human_review: true } },
        author_handle: "u", author_id: "uid", status: "drafting", tier: null, classifier_label: null, classifier_score: 0, priority: false,
      }],
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      pinNotification,
      relevanceThreshold: 99,
      qualityThreshold: 1,
    });

    expect(n).toBe(1);
    expect(pinNotification).not.toHaveBeenCalled();
    expect(runner.draft.mock.calls[0]![0].prompt).toContain("answer the migration constraint directly");
    const outbound = postOutbound.mock.calls[0]![0];
    expect(outbound.owner).toEqual({ orgId, agentInstanceId });
    expect(outbound.replyRequestKey).toBe("manual-1");
    expect(outbound.humanReviewRequired).toBe(true);
    expect(outbound.drafts.every((d: { kind: string }) => d.kind === "reply")).toBe(true);
    expect(markStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "drafted", meta: expect.objectContaining({ reply_request_key: "manual-1" }) }));
  });

  // Regression (2026-07-20): an outbound POST failure is transport, not
  // content — the drafts are already generated + paid for. First failure holds
  // the lead as 'classified' (re-claimable) with meta.outbound_error; a second
  // consecutive failure (marker already set) errors it so a persistent api-vm
  // fault can't loop forever.
  it("holds the lead as 'classified' on the FIRST outbound POST failure (one retry)", async () => {
    const postOutbound = vi.fn().mockRejectedValue(new Error("api-vm 502"));
    const runner = {
      draft: vi.fn().mockResolvedValue({
        text: JSON.stringify({ drafts: [{ angle: "empathetic", body: "e", char_count: 1 }] }),
        engine: "codex",
        model: "gpt-5",
      }),
    };
    const nella = { search: vi.fn().mockResolvedValue([{ path: "p.md", snippet: "a", score: 8, filePath: "p.md", startLine: 1, endLine: 1, highlights: [] }]) };
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
    const markStatus = vi.fn().mockResolvedValue(undefined);
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" },
      claimedLeads: [
        { id: "L", external_id: "x1", payload: { text: "post", url: "https://x.com/u/status/1" }, author_handle: "u", author_id: "uid", status: "drafting", tier: null, classifier_label: null, classifier_score: null, priority: false },
      ],
      runner: runner as never,
      kb: nella as never,
      postOutbound,
      markStatus,
    });
    expect(markStatus).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: "L", status: "classified", meta: expect.objectContaining({ outbound_error: expect.any(String) }) }),
    );
    expect(markStatus).not.toHaveBeenCalledWith(expect.objectContaining({ leadId: "L", status: "drafted" }));
  });

  it("ERRORS the lead on a SECOND consecutive outbound failure (marker already set)", async () => {
    const postOutbound = vi.fn().mockRejectedValue(new Error("api-vm 502"));
    const runner = {
      draft: vi.fn().mockResolvedValue({
        text: JSON.stringify({ drafts: [{ angle: "empathetic", body: "e", char_count: 1 }] }),
        engine: "codex",
        model: "gpt-5",
      }),
    };
    const nella = { search: vi.fn().mockResolvedValue([{ path: "p.md", snippet: "a", score: 8, filePath: "p.md", startLine: 1, endLine: 1, highlights: [] }]) };
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
    const markStatus = vi.fn().mockResolvedValue(undefined);
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" },
      claimedLeads: [
        // payload already carries outbound_error from a prior failed tick.
        { id: "L", external_id: "x1", payload: { text: "post", url: "https://x.com/u/status/1", outbound_error: "api-vm 502" }, author_handle: "u", author_id: "uid", status: "drafting", tier: null, classifier_label: null, classifier_score: null, priority: false },
      ],
      runner: runner as never,
      kb: nella as never,
      postOutbound,
      markStatus,
    });
    expect(markStatus).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: "L", status: "errored" }),
    );
  });

  // Regression (2026-07-19, Lyra sibling bug): the model often omits `char_count`.
  // charCount is recomputed off the cleaned body before anything ships, so a
  // missing count must never error a lead with a perfectly good body.
  it("drafts WITHOUT char_count still post (count recomputed from body)", async () => {
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const runner = {
      draft: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          drafts: [
            { angle: "empathetic", body: "e" },
            { angle: "technical", body: "t" },
            { angle: "contrarian", body: "c" },
          ],
          dm: { body: "x".repeat(500) },
        }),
        engine: "claude-cli",
        model: "claude-sonnet-4-6",
      }),
    };
    const nella = {
      search: vi.fn().mockResolvedValue([
        { path: "p.md", snippet: "anchor", score: 8.0, filePath: "p.md", startLine: 1, endLine: 1, highlights: [] },
      ]),
    };
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
    const markStatus = vi.fn().mockResolvedValue(undefined);
    const n = await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" },
      claimedLeads: [
        { id: "L", external_id: "x1", payload: { text: "post text", url: "https://x.com/u/status/1" }, author_handle: "u", author_id: "uid", status: "drafting", tier: null, classifier_label: null, classifier_score: null, priority: false },
      ],
      runner: runner as never,
      kb: nella as never,
      postOutbound,
      markStatus,
    });
    expect(n).toBe(1);
    expect(postOutbound).toHaveBeenCalledTimes(1);
    const body = postOutbound.mock.calls[0]![0];
    const replies = body.drafts.filter((d: { kind: string }) => d.kind === "reply");
    expect(replies).toHaveLength(3);
    expect(replies[0].charCount).toBe(1);
    expect(markStatus).toHaveBeenCalledWith(expect.objectContaining({ leadId: "L", status: "drafted" }));
  });

  it("grounds the reply in the watchlist person's profile (loaded from sql, injected into system)", async () => {
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const runner = {
      draft: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          drafts: [
            { angle: "empathetic", body: "e", char_count: 1 },
            { angle: "technical", body: "t", char_count: 1 },
            { angle: "contrarian", body: "c", char_count: 1 },
          ],
        }),
        engine: "codex",
        model: "gpt-5",
      }),
    };
    const nella = {
      search: vi.fn().mockResolvedValue([
        { path: "p.md", snippet: "anchor", score: 8.0, filePath: "p.md", startLine: 1, endLine: 1, highlights: [] },
      ]),
    };
    // Mock sql: profiles query returns one row for handle "u"; the objectives
    // query (x_watchlist_people) returns nothing.
    const sql = ((strings: TemplateStringsArray) => {
      const q = strings.join(" ");
      if (q.includes("x_watchlist_profiles")) {
        return Promise.resolve([
          {
            handle: "u",
            summary: "Indie hacker shipping a Rust CLI",
            topics: ["devtools", "rust"],
            tone: "dry, technical",
            engagement_notes: "respond with a concrete benchmark, never hype",
          },
        ]);
      }
      return Promise.resolve([]);
    }) as never;
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
    const markStatus = vi.fn().mockResolvedValue(undefined);
    await runDrafterTick({
      patternRules: [],
      log,
      instance: { id: "i", org_id: "o" },
      claimedLeads: [
        { id: "L", external_id: "x1", payload: { text: "shipping is hard", url: "https://x.com/u/status/1" }, author_handle: "u", author_id: "uid", status: "drafting", tier: null, classifier_label: null, classifier_score: null, priority: false },
      ],
      runner: runner as never,
      kb: nella as never,
      postOutbound,
      markStatus,
      sql,
    });
    expect(runner.draft).toHaveBeenCalledTimes(1);
    const system = runner.draft.mock.calls[0]![0].system as string;
    expect(system).toContain("WHO YOU'RE REPLYING TO");
    expect(system).toContain("Indie hacker shipping a Rust CLI");
    expect(system).toContain("devtools, rust");
  });

  it("does NOT add a profile block when the author has no profile row", async () => {
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const runner = {
      draft: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          drafts: [
            { angle: "empathetic", body: "e", char_count: 1 },
            { angle: "technical", body: "t", char_count: 1 },
            { angle: "contrarian", body: "c", char_count: 1 },
          ],
        }),
        engine: "codex",
        model: "gpt-5",
      }),
    };
    const nella = {
      search: vi.fn().mockResolvedValue([
        { path: "p.md", snippet: "anchor", score: 8.0, filePath: "p.md", startLine: 1, endLine: 1, highlights: [] },
      ]),
    };
    const sql = (() => Promise.resolve([])) as never; // no profiles, no objectives
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
    const markStatus = vi.fn().mockResolvedValue(undefined);
    await runDrafterTick({
      patternRules: [],
      log,
      instance: { id: "i", org_id: "o" },
      claimedLeads: [
        { id: "L", external_id: "x1", payload: { text: "post text", url: "https://x.com/u/status/1" }, author_handle: "stranger", author_id: "uid", status: "drafting", tier: null, classifier_label: null, classifier_score: null, priority: false },
      ],
      runner: runner as never,
      kb: nella as never,
      postOutbound,
      markStatus,
      sql,
    });
    const system = runner.draft.mock.calls[0]![0].system as string;
    expect(system).not.toContain("WHO YOU'RE REPLYING TO");
  });

  it("runs a second knowledge pass and injects product knowledge into the prompt", async () => {
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const runner = {
      draft: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          drafts: [
            { angle: "empathetic", body: "e", char_count: 1 },
            { angle: "technical", body: "t", char_count: 1 },
            { angle: "contrarian", body: "c", char_count: 1 },
          ],
        }),
        engine: "codex",
        model: "gpt-5",
      }),
    };
    // Voice search (no filterDirs) → voice anchor; knowledge search (filterDirs)
    // → a product fact. Proves the two scoped passes are distinct.
    const nella = {
      search: vi.fn().mockImplementation((_q: string, _k: number, opts?: { filterDirs?: string[] }) => {
        if (opts?.filterDirs?.length) {
          return Promise.resolve([
            { snippet: "Nella does AST-aware code search", score: 9, filePath: "01-business/x.md", startLine: 1, endLine: 1, highlights: [] },
          ]);
        }
        return Promise.resolve([
          { snippet: "i ship small and often", score: 8.0, filePath: "02-brand/voice.md", startLine: 1, endLine: 1, highlights: [] },
        ]);
      }),
    };
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
    const markStatus = vi.fn().mockResolvedValue(undefined);
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" },
      claimedLeads: [
        { id: "L", external_id: "x1", payload: { text: "agents keep hallucinating imports", url: "https://x.com/u/status/1" }, author_handle: "u", author_id: "uid", status: "drafting", tier: null, classifier_label: null, classifier_score: null, priority: false },
      ],
      runner: runner as never,
      kb: nella as never,
      postOutbound,
      markStatus,
      knowledgeDirs: ["01-business"],
      knowledgeTopK: 4,
    });
    // Two retrieval passes: voice (no filterDirs) + knowledge (filterDirs).
    expect(nella.search).toHaveBeenCalledTimes(2);
    expect(nella.search.mock.calls.some((c) => c[2]?.filterDirs?.includes("01-business"))).toBe(true);
    const prompt = runner.draft.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain("Product knowledge");
    expect(prompt).toContain("AST-aware code search");
  });

  it("skips the knowledge pass when no knowledge dirs are configured (one search only)", async () => {
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const runner = {
      draft: vi.fn().mockResolvedValue({
        text: JSON.stringify({ drafts: [{ angle: "empathetic", body: "e", char_count: 1 }] }),
        engine: "codex",
        model: "gpt-5",
      }),
    };
    const nella = {
      search: vi.fn().mockResolvedValue([
        { snippet: "anchor", score: 8.0, filePath: "p.md", startLine: 1, endLine: 1, highlights: [] },
      ]),
    };
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
    const markStatus = vi.fn().mockResolvedValue(undefined);
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" },
      claimedLeads: [
        { id: "L", external_id: "x1", payload: { text: "post text", url: "https://x.com/u/status/1" }, author_handle: "u", author_id: "uid", status: "drafting", tier: null, classifier_label: null, classifier_score: null, priority: false },
      ],
      runner: runner as never,
      kb: nella as never,
      postOutbound,
      markStatus,
    });
    expect(nella.search).toHaveBeenCalledTimes(1);
    const prompt = runner.draft.mock.calls[0]![0].prompt as string;
    expect(prompt).not.toContain("Product knowledge");
  });

  const draftsJson = JSON.stringify({
    drafts: [
      { angle: "empathetic", body: "sccache cut my rust builds in half, worth a look", char_count: 47 },
      { angle: "technical", body: "the bottleneck is usually linking, not compiling", char_count: 48 },
      { angle: "contrarian", body: "honestly incremental builds matter more than cold ones here", char_count: 59 },
    ],
  });
  const verdict = (pass: boolean) =>
    JSON.stringify(
      pass
        ? { voice: 0.9, grounding: 0.9, relevance: 0.9, reasons: [], fix: null }
        : { voice: 0.3, grounding: 0.4, relevance: 0.5, reasons: ["too generic"], fix: "name a concrete build tool" },
    );
  const mkKb = () => ({
    search: vi.fn().mockResolvedValue([
      { snippet: "i ship small and often", score: 8.0, filePath: "p.md", startLine: 1, endLine: 1, highlights: [] },
    ]),
  });
  const mkLead = (priority = false) => ({
    id: "L", external_id: "x1", payload: { text: "rust builds are slow", url: "https://x.com/u/status/1" },
    author_handle: "u", author_id: "uid", status: "drafting", tier: null, classifier_label: null, classifier_score: null, priority,
  });

  it("verifier: passes on the first try → no regenerate, verdict attached", async () => {
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const runner = { draft: vi.fn().mockResolvedValue({ text: draftsJson, engine: "codex", model: "gpt-5" }) };
    const judge = vi.fn().mockResolvedValue(verdict(true));
    const makeCalls = vi.fn(() => [judge]);
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
    await runDrafterTick({
      log, instance: { id: "i", org_id: "o" }, claimedLeads: [mkLead()],
      runner: runner as never, kb: mkKb() as never, postOutbound,
      markStatus: vi.fn().mockResolvedValue(undefined),
      verify: { enabled: true, retries: 2, makeCalls },
    });
    expect(makeCalls.mock.calls).toEqual([[false]]);
    expect(runner.draft).toHaveBeenCalledTimes(1); // no regenerate
    expect(judge).toHaveBeenCalledTimes(4); // reply set + each final angle
    const body = postOutbound.mock.calls[0]![0];
    expect(body.verifierMeta.pass).toBe(true);
    expect(body.verifierMeta).toMatchObject({ judgeOk: true, judgeProvider: "legacy" });
    expect(body.verifierMeta.attempts).toBe(0);
  });

  it("keeps the chosen verdict for an unchanged single browser reply", async () => {
    const reply = "sccache might help if rebuilds are the slow bit";
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const runner = { draft: vi.fn().mockResolvedValue({
      text: JSON.stringify({ drafts: [{ angle: "technical", body: reply }] }),
      engine: "codex", model: "gpt-5",
    }) };
    const judge = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ voice: 0.82, grounding: 0.84, relevance: 0.86, reasons: [], fix: null }))
      .mockResolvedValueOnce(JSON.stringify({ voice: 0.66, grounding: 0.84, relevance: 0.86, reasons: ["off voice"], fix: "rewrite voice" }));
    const markStatus = vi.fn().mockResolvedValue(undefined);

    await runDrafterTick({
      log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
      instance: { id: "i", org_id: "o" },
      claimedLeads: [{ ...mkLead(), payload: { ...mkLead().payload, source: "extension_observed" } }],
      runner: runner as never, kb: mkKb() as never, postOutbound, markStatus,
      verify: { enabled: true, retries: 0, voiceFloor: 0.7, makeCalls: () => [judge] },
    });

    expect(judge).toHaveBeenCalledTimes(1);
    expect(postOutbound).toHaveBeenCalledTimes(1);
    const outbound = postOutbound.mock.calls[0]![0];
    expect(outbound.drafts[0]).toMatchObject({
      angle: "technical", body: reply,
      verifierMeta: { pass: true, judgeOk: true, judgeProvider: "legacy", scores: expect.objectContaining({ voice: 0.82 }), reasons: [], attempts: 0 },
    });
    expect(markStatus).not.toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ skip_reason: "low-voice" }) }));
  });

  it("verifier: regenerates with feedback on a failing verdict, keeps the improved draft", async () => {
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const runner = { draft: vi.fn().mockResolvedValue({ text: draftsJson, engine: "codex", model: "gpt-5" }) };
    // Judge fails first, passes after the regenerate.
    const judge = vi.fn().mockResolvedValueOnce(verdict(false)).mockResolvedValue(verdict(true));
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
    await runDrafterTick({
      log, instance: { id: "i", org_id: "o" }, claimedLeads: [mkLead()],
      runner: runner as never, kb: mkKb() as never, postOutbound,
      markStatus: vi.fn().mockResolvedValue(undefined),
      verify: { enabled: true, retries: 2, makeCalls: () => [judge] },
    });
    expect(runner.draft).toHaveBeenCalledTimes(2); // initial + 1 regenerate
    // The regenerate prompt carries the critique.
    expect(runner.draft.mock.calls[1]![0].prompt).toContain("REVIEW FEEDBACK");
    const body = postOutbound.mock.calls[0]![0];
    expect(body.verifierMeta.pass).toBe(true);
    expect(body.verifierMeta.attempts).toBe(1);
  });

  it("verifier: keeps progress on the weakest score so the next repair gets current feedback", async () => {
    const output = (body: string) => JSON.stringify({
      drafts: [{ angle: "technical", body, char_count: body.length }],
    });
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const runner = {
      draft: vi.fn().mockImplementation(async ({ prompt }: { prompt: string }) => {
        const body = runner.draft.mock.calls.length === 1
          ? "baseline reply"
          : runner.draft.mock.calls.length === 2
            ? "voice fixed but grounding needs work"
            : prompt.includes("finish the grounding repair")
              ? "final grounded reply"
              : "stale voice repair";
        return { text: output(body), engine: "codex", model: "gpt-5" };
      }),
    };
    const judge = vi.fn().mockImplementation(async (_system: string, prompt: string) => {
      if (prompt.includes("final grounded reply")) {
        return JSON.stringify({ voice: 0.82, grounding: 0.81, relevance: 0.84, reasons: [], fix: null });
      }
      if (prompt.includes("voice fixed but grounding needs work")) {
        return JSON.stringify({
          voice: 0.72,
          grounding: 0.69,
          relevance: 0.76,
          reasons: ["grounding is now the weakest score"],
          fix: "finish the grounding repair",
        });
      }
      return JSON.stringify({
        voice: 0.68,
        grounding: 0.99,
        relevance: 0.99,
        reasons: ["voice is the weakest score"],
        fix: "fix the voice",
      });
    });

    await runDrafterTick({
      log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
      instance: { id: "i", org_id: "o" },
      claimedLeads: [mkLead()],
      runner: runner as never,
      kb: mkKb() as never,
      postOutbound,
      markStatus: vi.fn().mockResolvedValue(undefined),
      verify: { enabled: true, retries: 2, makeCalls: () => [judge] },
    });

    expect(runner.draft).toHaveBeenCalledTimes(3);
    expect(runner.draft.mock.calls[1]![0].prompt).toContain("baseline reply");
    expect(runner.draft.mock.calls[2]![0].prompt).toContain("finish the grounding repair");
    expect(runner.draft.mock.calls[2]![0].prompt).toContain("voice fixed but grounding needs work");
    const body = postOutbound.mock.calls[0]![0];
    expect(body.drafts[0].body).toBe("final grounded reply");
    expect(body.verifierMeta).toMatchObject({ pass: true, attempts: 2 });
  });

  it("browser verifier judges repair candidates in parallel and keeps only the passing reply", async () => {
    const output = (drafts: Array<{ angle: "empathetic" | "technical" | "contrarian"; body: string }>) =>
      JSON.stringify({ drafts: drafts.map((draft) => ({ ...draft, char_count: draft.body.length })) });
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const runner = {
      draft: vi.fn()
        .mockResolvedValueOnce({
          text: output([{ angle: "technical", body: "baseline reply" }]),
          engine: "codex",
          model: "gpt-5",
        })
        .mockResolvedValueOnce({
          text: output([
            { angle: "empathetic", body: "unreviewed candidate" },
            { angle: "empathetic", body: "weak voice candidate" },
            { angle: "technical", body: "strong passing candidate" },
            { angle: "contrarian", body: "overflow candidate must not be judged" },
          ]),
          engine: "codex",
          model: "gpt-5",
        }),
    };
    const judge = vi.fn().mockImplementation(async (_system: string, prompt: string) => {
      if (prompt.includes("unreviewed candidate")) return "not a verdict";
      if (prompt.includes("strong passing candidate") && !prompt.includes("weak voice candidate")) {
        return JSON.stringify({ voice: 0.82, grounding: 0.84, relevance: 0.86, reasons: [], fix: null });
      }
      if (prompt.includes("weak voice candidate")) {
        return JSON.stringify({ voice: 0.4, grounding: 0.84, relevance: 0.86, reasons: ["off voice"], fix: "fix voice" });
      }
      return JSON.stringify({ voice: 0.5, grounding: 0.8, relevance: 0.8, reasons: ["off voice"], fix: "fix voice" });
    });

    await runDrafterTick({
      log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
      instance: { id: "i", org_id: "o" },
      claimedLeads: [{
        ...mkLead(),
        payload: { ...mkLead().payload, source: "extension_observed" },
      }],
      runner: runner as never,
      kb: mkKb() as never,
      postOutbound,
      markStatus: vi.fn().mockResolvedValue(undefined),
      verify: { enabled: true, retries: 1, makeCalls: () => [judge] },
    });

    expect(runner.draft).toHaveBeenCalledTimes(2);
    expect(runner.draft.mock.calls[1]![0].prompt).toContain("exactly THREE distinct reply candidates");
    expect(judge.mock.calls.some(([, prompt]) => prompt.includes("overflow candidate"))).toBe(false);
    const body = postOutbound.mock.calls[0]![0];
    expect(body.drafts).toHaveLength(1);
    expect(body.drafts[0]).toMatchObject({
      body: "strong passing candidate",
      verifierMeta: expect.objectContaining({ pass: true }),
    });
  });

  it("verifier grades voice against the same real sent replies as the drafter", async () => {
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const runner = { draft: vi.fn().mockResolvedValue({ text: draftsJson, engine: "codex", model: "gpt-5" }) };
    const judge = vi.fn().mockResolvedValue(verdict(true));
    const vaultSnippets = Array.from({ length: 8 }, (_, index) => `vault voice anchor ${index + 1}`);
    const kb = {
      search: vi.fn().mockResolvedValue(vaultSnippets.map((snippet, index) => ({
        snippet,
        score: 8 - index / 10,
        filePath: `voice-${index + 1}.md`,
        startLine: 1,
        endLine: 1,
        highlights: [],
      }))),
    };
    const shortExamples = Array.from({ length: 6 }, (_, index) => `short sent reply ${index + 1}`);
    const pairedExamples = Array.from({ length: 6 }, (_, index) => ({
      post: `older source post ${index + 1}`,
      reply: `paired sent reply ${index + 1}`,
    }));

    await runDrafterTick({
      log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
      instance: { id: "i", org_id: "o" },
      claimedLeads: [mkLead()],
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus: vi.fn().mockResolvedValue(undefined),
      examples: shortExamples,
      voiceExemplars: pairedExamples,
      verify: { enabled: true, retries: 2, makeCalls: () => [judge] },
    });

    const judgePrompt = judge.mock.calls[0]![1] as string;
    expect(judgePrompt).toContain(shortExamples[0]);
    expect(judgePrompt).toContain(pairedExamples[0]?.reply);
    for (const snippet of vaultSnippets) expect(judgePrompt).toContain(snippet);
    for (const example of pairedExamples) expect(judgePrompt).not.toContain(example.post);
  });

  it("excludes generated and template artifacts from writer and verifier voice evidence", async () => {
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const runner = { draft: vi.fn().mockResolvedValue({ text: draftsJson, engine: "codex", model: "gpt-5" }) };
    const judge = vi.fn().mockResolvedValue(verdict(true));
    const kb = {
      search: vi.fn().mockResolvedValue([
        {
          snippet: "## Do {{#voiceDos}} - {{.}} {{/voiceDos}}",
          score: 10,
          source: { filePath: "Voice/voice-and-style.md", startLine: 29, endLine: 36 },
        },
        {
          snippet: "Direct. Specific. Human. Honest uncertainty without guru energy.",
          score: 9.5,
          source: { filePath: "02-brand/voice-and-style.md", startLine: 8, endLine: 14 },
        },
        {
          snippet: "Grow a physics and engineering student audience while building a startup",
          score: 9,
          source: { filePath: "Voice/personal-brand-state.md", startLine: 13, endLine: 21 },
        },
        {
          snippet: "<!-- One or two lines. e.g. Solo founder building Noelle. -->",
          score: 8,
          source: { filePath: "Voice/voice-spec.md", startLine: 19, endLine: 22 },
        },
        {
          snippet: "First person, lowercase-leaning, blunt, founder-to-peer.",
          score: 7,
          source: { filePath: "Voice/voice-spec.md", startLine: 23, endLine: 28 },
        },
      ]),
    };

    await runDrafterTick({
      log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
      instance: { id: "i", org_id: "o" },
      claimedLeads: [mkLead()],
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus: vi.fn().mockResolvedValue(undefined),
      verify: { enabled: true, retries: 2, makeCalls: () => [judge] },
    });

    const writerPrompt = runner.draft.mock.calls[0]![0].prompt as string;
    const judgePrompt = judge.mock.calls[0]![1] as string;
    for (const prompt of [writerPrompt, judgePrompt]) {
      expect(prompt).toContain("First person, lowercase-leaning, blunt, founder-to-peer.");
      expect(prompt).toContain("Direct. Specific. Human. Honest uncertainty without guru energy.");
      expect(prompt).not.toContain("{{#voiceDos}}");
      expect(prompt).not.toContain("physics and engineering student audience");
      expect(prompt).not.toContain("<!-- One or two lines");
    }
  });

  it("uses Codex only for every browser draft and high reasoning for the final repair", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const runner = { draft: vi.fn().mockResolvedValue({ text: draftsJson, engine: "codex", model: "gpt-5" }) };
    const judge = vi.fn().mockResolvedValue(verdict(false));
    const makeCalls = vi.fn(() => [judge]);
    const markStatus = vi.fn().mockResolvedValue(undefined);
    const sourcePost = "If someone sees seven posts, they may warm up; separately, one prospect viewed my profile.";

    await runDrafterTick({
      log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
      instance: { id: "i", org_id: "o" },
      claimedLeads: [{
        ...mkLead(),
        payload: {
          ...mkLead().payload,
          source: "extension_observed",
          text: sourcePost,
        },
      }],
      runner: runner as never,
      kb: mkKb() as never,
      postOutbound,
      markStatus,
      verify: { enabled: true, retries: 2, voiceFloor: 0.8, makeCalls },
    });

    expect(makeCalls).toHaveBeenCalledWith(false, {
      codexSubscriptionOnly: true,
      codexReasoningEffort: "high",
    });
    expect(runner.draft.mock.calls.map((call) => call[0].routing.primary.model))
      .toEqual(["claude-sonnet-4-6", "claude-sonnet-4-6", "claude-sonnet-4-6"]);
    expect(runner.draft.mock.calls[0]![0]).toMatchObject({ codexSubscriptionOnly: true });
    expect(runner.draft.mock.calls[1]![0]).toMatchObject({ codexSubscriptionOnly: true });
    expect(runner.draft.mock.calls[2]![0]).toMatchObject({
      codexSubscriptionOnly: true,
      codexReasoningEffort: "high",
    });
    const firstRepair = runner.draft.mock.calls[1]![0] as { prompt: string };
    const finalRepair = runner.draft.mock.calls[2]![0] as { prompt: string };
    expect(firstRepair.prompt).not.toContain("FINAL BROWSER REPAIR");
    expect(finalRepair.prompt).toContain("FINAL BROWSER REPAIR");
    expect(finalRepair.prompt).toContain(sourcePost);
    expect(finalRepair.prompt).toContain("REVIEW FEEDBACK");
    expect(finalRepair.prompt).toMatch(/one compact reply.*natural.*rhythm/i);
    expect(finalRepair.prompt).toMatch(/source.*specific/i);
    expect(finalRepair.prompt).toMatch(/learned.*pattern rules.*still apply/i);
    expect(finalRepair.prompt).toContain("NO FULL STOPS");
    expect(postOutbound).not.toHaveBeenCalled();
    expect(markStatus).toHaveBeenCalledWith(expect.objectContaining({
      status: "skipped",
      meta: expect.objectContaining({ skip_reason: "low-voice" }),
    }));
  });

  it("keeps bounded private-safe verifier evidence when a browser lead fails the voice floor", async () => {
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const runner = { draft: vi.fn().mockResolvedValue({
      text: JSON.stringify({ drafts: [{ angle: "technical", body: "A concrete reply", char_count: 16 }] }),
      engine: "codex", model: "gpt-5",
    }) };
    const judge = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({
        voice: 0.4, grounding: 0.9, relevance: 0.9,
        reasons: ["Unsupported claim about Alice at @alice in the draft A concrete reply"],
        fix: "Remove Alice's unsupported claim and do not quote her message",
      }))
      .mockResolvedValueOnce(JSON.stringify({
        voice: 0.5, grounding: 0.9, relevance: 0.9,
        reasons: ["Voice still sounds generic and copies Bob's phrasing at bob@example.com"],
        fix: "Make the voice less generic without copying Bob's words",
      }))
      .mockResolvedValueOnce(JSON.stringify({
        voice: 0.6, grounding: 0.9, relevance: 0.9,
        reasons: ["The voice remains generic for https://x.com/alice/status/1"],
        fix: "Use a natural voice; mention Alice's startup",
      }));
    const markStatus = vi.fn().mockResolvedValue(undefined);

    await runDrafterTick({
      log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
      instance: { id: "i", org_id: "o" },
      claimedLeads: [{ ...mkLead(), payload: { ...mkLead().payload, source: "extension_observed" } }],
      runner: runner as never, kb: mkKb() as never, postOutbound, markStatus,
      verify: { enabled: true, retries: 2, voiceFloor: 0.8, makeCalls: () => [judge] },
    });

    expect(postOutbound).not.toHaveBeenCalled();
    const skipped = markStatus.mock.calls.find(([arg]) => arg.status === "skipped")?.[0];
    expect(skipped).toMatchObject({ leadId: "L", meta: { skip_reason: "low-voice" } });
    const diagnostic = skipped.meta.voice_verifier_diagnostic;
    expect(diagnostic).toMatchObject({ version: 1, voice_floor: 0.8 });
    expect(diagnostic.verdicts).toHaveLength(3);
    expect(diagnostic.verdicts.map((entry: { attempt: number; scores: { voice: number } }) =>
      [entry.attempt, entry.scores.voice])).toEqual([[0, 0.4], [1, 0.5], [2, 0.6]]);
    expect(diagnostic.verdicts[0]).toMatchObject({ reason: "unsupported claim", fix: "remove unsupported claim" });
    expect(diagnostic.verdicts[1]).toMatchObject({
      reason: "generic voice; echoes source",
      fix: "use natural voice; add an original point",
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(/Alice|Bob|@alice|bob@example|https:\/\/|A concrete reply/);
  });

  it("keeps legacy reply drafts on the default model routing path", async () => {
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const runner = { draft: vi.fn().mockResolvedValue({ text: draftsJson, engine: "bedrock", model: "claude-sonnet-4-6" }) };

    await runDrafterTick({
      log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
      instance: { id: "i", org_id: "o" },
      claimedLeads: [mkLead()],
      runner: runner as never,
      kb: mkKb() as never,
      postOutbound,
      markStatus: vi.fn().mockResolvedValue(undefined),
    });

    expect(runner.draft).toHaveBeenCalledOnce();
    expect(runner.draft.mock.calls[0]![0]).not.toHaveProperty("directRouting");
    expect(runner.draft.mock.calls[0]![0]).not.toHaveProperty("codexSubscriptionOnly");
  });

  it("verifier: gives up after `retries` and queues the best attempt with a failing verdict", async () => {
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const runner = { draft: vi.fn().mockResolvedValue({ text: draftsJson, engine: "codex", model: "gpt-5" }) };
    const judge = vi.fn().mockResolvedValue(verdict(false)); // always fails
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
    await runDrafterTick({
      log, instance: { id: "i", org_id: "o" }, claimedLeads: [mkLead()],
      runner: runner as never, kb: mkKb() as never, postOutbound,
      markStatus: vi.fn().mockResolvedValue(undefined),
      verify: { enabled: true, retries: 2, makeCalls: () => [judge] },
    });
    expect(runner.draft).toHaveBeenCalledTimes(3); // initial + 2 retries
    const body = postOutbound.mock.calls[0]![0];
    expect(body.verifierMeta.pass).toBe(false);
    expect(body.verifierMeta.attempts).toBe(2);
    expect(postOutbound).toHaveBeenCalledTimes(1); // still queued
  });

  it("verifier: priority lead uses the adversarial (3-judge) panel", async () => {
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const runner = { draft: vi.fn().mockResolvedValue({ text: draftsJson, engine: "codex", model: "gpt-5" }) };
    const judge = vi.fn().mockResolvedValue(verdict(true));
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
    await runDrafterTick({
      log, instance: { id: "i", org_id: "o" }, claimedLeads: [mkLead(true)],
      runner: runner as never, kb: mkKb() as never, postOutbound,
      markStatus: vi.fn().mockResolvedValue(undefined),
      verify: { enabled: true, retries: 2, makeCalls: (priority) => (priority ? [judge, judge, judge] : [judge]) },
    });
    expect(judge).toHaveBeenCalledTimes(12); // 3 judges for the set and each of 3 final angles
  });

  it("reviews each final reply separately so a weak sibling does not block strong angles", async () => {
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const runner = { draft: vi.fn().mockResolvedValue({
      text: JSON.stringify({ ...JSON.parse(draftsJson), dm: { body: "hellooo\n\nsaw your post\n\nexample.test" } }),
      engine: "codex", model: "gpt-5",
    }) };
    const judge = vi.fn()
      .mockResolvedValueOnce(verdict(false)) // whole set fails
      .mockResolvedValueOnce(verdict(true))  // empathetic passes alone
      .mockResolvedValueOnce(verdict(false)) // technical fails alone
      .mockResolvedValueOnce(verdict(true)); // contrarian passes alone
    await runDrafterTick({
      log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
      instance: { id: "i", org_id: "o", dm_autodraft_enabled: true }, claimedLeads: [mkLead()],
      runner: runner as never, kb: mkKb() as never, postOutbound,
      markStatus: vi.fn().mockResolvedValue(undefined),
      verify: { enabled: true, retries: 0, voiceFloor: 0.65, makeCalls: () => [judge] },
    });
    const body = postOutbound.mock.calls[0]![0];
    expect(body.verifierMeta.pass).toBe(false);
    expect(body.drafts.filter((d: { kind: string }) => d.kind === "reply")
      .map((d: { verifierMeta?: { pass: boolean; judgeOk: boolean } }) => [d.verifierMeta?.pass, d.verifierMeta?.judgeOk]))
      .toEqual([[true, true], [false, true], [true, true]]);
    expect(body.drafts.find((d: { kind: string }) => d.kind === "dm").verifierMeta).toBeUndefined();
    expect(judge).toHaveBeenCalledTimes(4);
    expect(String(judge.mock.calls[1]![1])).toContain("rust builds are slow");
    expect(String(judge.mock.calls[1]![1])).toContain("i ship small and often");
  });

  it("reviews the exact cleaned reply body that outbound will persist", async () => {
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const original = "sccache—saved my rust builds";
    const runner = { draft: vi.fn().mockResolvedValue({
      text: JSON.stringify({ drafts: [{ angle: "technical", body: original }] }), engine: "codex", model: "gpt-5",
    }) };
    const judge = vi.fn().mockResolvedValue(verdict(true));
    await runDrafterTick({
      log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
      instance: { id: "i", org_id: "o" }, claimedLeads: [mkLead()],
      runner: runner as never, kb: mkKb() as never, postOutbound,
      markStatus: vi.fn().mockResolvedValue(undefined),
      verify: { enabled: true, retries: 0, makeCalls: () => [judge] },
    });
    const finalReply = postOutbound.mock.calls[0]![0].drafts[0];
    expect(finalReply.body).not.toBe(original);
    expect(finalReply.body).not.toContain("—");
    expect(String(judge.mock.calls[1]![1])).toContain(finalReply.body);
    expect(finalReply.verifierMeta).toMatchObject({ pass: true, judgeOk: true });
  });

  it("marks a fail-open judge result for a cleaned reply as ineligible for unattended sending", async () => {
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const runner = { draft: vi.fn().mockResolvedValue({ text: JSON.stringify({ drafts: [{ angle: "empathetic", body: "sccache helped my builds  " }] }), engine: "codex", model: "gpt-5" }) };
    const judge = vi.fn().mockResolvedValueOnce(verdict(true)).mockRejectedValue(new Error("judge down"));
    await runDrafterTick({
      log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
      instance: { id: "i", org_id: "o" }, claimedLeads: [mkLead()],
      runner: runner as never, kb: mkKb() as never, postOutbound,
      markStatus: vi.fn().mockResolvedValue(undefined),
      verify: { enabled: true, retries: 0, makeCalls: () => [judge] },
    });
    const body = postOutbound.mock.calls[0]![0];
    expect(body.verifierMeta).toMatchObject({ pass: true, judgeOk: true });
    expect(body.drafts[0].body).toBe("sccache helped my builds");
    expect(body.drafts[0].verifierMeta).toMatchObject({ pass: false, judgeOk: false, judgeProvider: "none" });
  });

  it("budget cap: HOLDS a priority (watchlist) lead as re-claimable 'classified' — never errored/lost", async () => {
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const runner = {
      draft: vi.fn().mockRejectedValue(
        new BudgetExceededError({ layer: "instance", spent_cents: 2500, cap_cents: 2500, estimated_cents: 20 }),
      ),
    };
    const markStatus = vi.fn().mockResolvedValue(undefined);
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
    await runDrafterTick({
      log, instance: { id: "i", org_id: "o" }, claimedLeads: [mkLead(true)],
      runner: runner as never, kb: mkKb() as never, postOutbound, markStatus,
    });
    // A watched account must not be dropped by a temporary cap: held as
    // 'classified' so it drafts once budget frees. Nothing queued to the inbox.
    expect(postOutbound).not.toHaveBeenCalled();
    expect(markStatus).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: "L", status: "classified" }),
    );
  });

  it("budget cap: a non-priority lead is still dropped to 'errored' (won't retry)", async () => {
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const runner = {
      draft: vi.fn().mockRejectedValue(
        new BudgetExceededError({ layer: "instance", spent_cents: 2500, cap_cents: 2500, estimated_cents: 20 }),
      ),
    };
    const markStatus = vi.fn().mockResolvedValue(undefined);
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
    await runDrafterTick({
      log, instance: { id: "i", org_id: "o" }, claimedLeads: [mkLead(false)],
      runner: runner as never, kb: mkKb() as never, postOutbound, markStatus,
    });
    expect(markStatus).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: "L", status: "errored" }),
    );
  });

  it("NEVER stamps auto_send (X replies go to the actuator, not the X API) even with auto_send_enabled", async () => {
    // Regression for the API-autosend removal: the drafter must never send an
    // `autoSend` payload, so no approval gets auto_send_target_at stamped and
    // the browser actuator (not the dead API send worker) drains every reply.
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const runner = { draft: vi.fn().mockResolvedValue({ text: draftsJson, engine: "codex", model: "gpt-5" }) };
    const judge = vi.fn().mockResolvedValue(verdict(true));
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
    await runDrafterTick({
      log, instance: { id: "i", org_id: "o", auto_send_enabled: true }, claimedLeads: [mkLead()],
      runner: runner as never, kb: mkKb() as never, postOutbound,
      markStatus: vi.fn().mockResolvedValue(undefined),
      verify: { enabled: true, retries: 2, makeCalls: () => [judge] },
    });
    expect(postOutbound).toHaveBeenCalledTimes(1);
    const body = postOutbound.mock.calls[0]![0];
    expect(body.autoSend).toBeNull();
  });

  it("injects past sent replies as few-shot exemplars when provided", async () => {
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const runner = { draft: vi.fn().mockResolvedValue({ text: draftsJson, engine: "codex", model: "gpt-5" }) };
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
    await runDrafterTick({
      log, instance: { id: "i", org_id: "o" }, claimedLeads: [mkLead()],
      runner: runner as never, kb: mkKb() as never, postOutbound,
      markStatus: vi.fn().mockResolvedValue(undefined),
      examples: ["sccache cut my builds in half, worth a look", "honestly the linker is the real bottleneck"],
    });
    const prompt = runner.draft.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain("Replies the operator actually sent before");
    expect(prompt).toContain("sccache cut my builds in half");
  });

  it("no examples → no exemplars block", async () => {
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const runner = { draft: vi.fn().mockResolvedValue({ text: draftsJson, engine: "codex", model: "gpt-5" }) };
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
    await runDrafterTick({
      log, instance: { id: "i", org_id: "o" }, claimedLeads: [mkLead()],
      runner: runner as never, kb: mkKb() as never, postOutbound,
      markStatus: vi.fn().mockResolvedValue(undefined),
    });
    const prompt = runner.draft.mock.calls[0]![0].prompt as string;
    expect(prompt).not.toContain("Replies the operator actually sent before");
  });

  it("verifier disabled → no judge calls, no verifierMeta", async () => {
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const runner = { draft: vi.fn().mockResolvedValue({ text: draftsJson, engine: "codex", model: "gpt-5" }) };
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
    await runDrafterTick({
      log, instance: { id: "i", org_id: "o" }, claimedLeads: [mkLead()],
      runner: runner as never, kb: mkKb() as never, postOutbound,
      markStatus: vi.fn().mockResolvedValue(undefined),
    });
    expect(runner.draft).toHaveBeenCalledTimes(1);
    const body = postOutbound.mock.calls[0]![0];
    expect(body.verifierMeta).toBeNull();
  });

  it("emits a kind='dm' draft (angle null) alongside the three replies", async () => {
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const runner = {
      draft: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          drafts: [
            { angle: "empathetic", body: "e", char_count: 1 },
            { angle: "technical", body: "t", char_count: 1 },
            { angle: "contrarian", body: "c", char_count: 1 },
          ],
          dm: { body: "hellooo\n\nsaw your post\n\nexample.test", char_count: 36 },
        }),
        engine: "codex",
        model: "gpt-5",
      }),
    };
    const nella = {
      search: vi.fn().mockResolvedValue([
        { path: "p.md", snippet: "anchor", score: 8.0, filePath: "p.md", startLine: 1, endLine: 1, highlights: [] },
      ]),
    };
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
    const markStatus = vi.fn().mockResolvedValue(undefined);
    await runDrafterTick({
      log,
      // Auto-DM is opt-in (0036) — enable it to exercise the DM path.
      instance: { id: "i", org_id: "o", dm_autodraft_enabled: true },
      claimedLeads: [
        { id: "L", external_id: "x1", payload: { text: "post text", url: "https://x.com/u/status/1" }, author_handle: "u", author_id: "uid", status: "drafting", tier: null, classifier_label: null, classifier_score: null, priority: false },
      ],
      runner: runner as never,
      kb: nella as never,
      postOutbound,
      markStatus,
    });
    const body = postOutbound.mock.calls[0]![0];
    expect(body.drafts).toHaveLength(4);
    const dm = body.drafts.find((d: { kind: string }) => d.kind === "dm");
    expect(dm).toBeDefined();
    expect(dm.angle).toBeNull();
    expect(dm.body).toContain("example.test");
    expect(body.drafts.filter((d: { kind: string }) => d.kind === "reply")).toHaveLength(3);
    const request = runner.draft.mock.calls[0]![0];
    expect(request.prompt).toContain("AND one DM");
    expect(request.prompt).toContain('"dm":{"body":"…","char_count":N}');
    expect(request.system).not.toMatch(/REPLY.ONLY OVERRIDE/i);
  });

  it("requests reply-only output for an observed lead even when auto-DM is enabled", async () => {
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const runner = { draft: vi.fn().mockResolvedValue({
      text: JSON.stringify({
        drafts: [{ angle: "technical", body: "this benchmark makes the tradeoff clear", char_count: 39 }],
        dm: { body: "the model ignored the reply-only instruction", char_count: 44 },
      }),
      engine: "codex", model: "gpt-5",
    }) };
    const kb = { search: vi.fn().mockResolvedValue([
      { path: "p.md", snippet: "anchor", score: 8, filePath: "p.md", startLine: 1, endLine: 1, highlights: [] },
    ]) };
    await runDrafterTick({
      log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
      instance: { id: "i", org_id: "o", dm_autodraft_enabled: true },
      claimedLeads: [{
        id: "L", external_id: "x1", payload: { text: "post text", url: "https://x.com/u/status/1", source: "extension_observed" },
        author_handle: "u", author_id: "uid", status: "drafting", tier: null,
        classifier_label: "substantial", classifier_score: 0.7, priority: true,
      }],
      runner: runner as never, kb: kb as never, postOutbound,
      markStatus: vi.fn().mockResolvedValue(undefined),
    });
    const request = runner.draft.mock.calls[0]![0];
    expect(request.system).toContain("REPLY-ONLY OUTPUT");
    expect(request.prompt).toContain('{"drafts":[{"angle":"empathetic|technical|contrarian","body":"…","char_count":N}]}');
    expect(request.prompt).not.toContain("AND one DM");
    expect(request.prompt).not.toContain('"dm"');
    expect(postOutbound.mock.calls[0]![0].drafts).toEqual([
      expect.objectContaining({ kind: "reply", body: "this benchmark makes the tradeoff clear" }),
    ]);
  });

  it("never drafts a DM for a watchlist (priority) person — replies only", async () => {
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const runner = {
      draft: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          drafts: [
            { angle: "empathetic", body: "e", char_count: 1 },
            { angle: "technical", body: "t", char_count: 1 },
            { angle: "contrarian", body: "c", char_count: 1 },
          ],
          // The model still proposes a DM, but the drafter must drop it for a
          // watchlist person — not a single AI-generated DM to them.
          dm: { body: "hellooo\n\nsaw your post\n\nexample.test", char_count: 36 },
        }),
        engine: "codex",
        model: "gpt-5",
      }),
    };
    const nella = {
      search: vi.fn().mockResolvedValue([
        { path: "p.md", snippet: "anchor", score: 8.0, filePath: "p.md", startLine: 1, endLine: 1, highlights: [] },
      ]),
    };
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
    const markStatus = vi.fn().mockResolvedValue(undefined);
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" },
      claimedLeads: [
        { id: "L", external_id: "x1", payload: { text: "post text", url: "https://x.com/u/status/1" }, author_handle: "u", author_id: "uid", status: "drafting", tier: "T1", classifier_label: "watchlist", classifier_score: 1, priority: true },
      ],
      runner: runner as never,
      kb: nella as never,
      postOutbound,
      markStatus,
    });
    const body = postOutbound.mock.calls[0]![0];
    expect(body.drafts.filter((d: { kind: string }) => d.kind === "dm")).toHaveLength(0);
    expect(body.drafts.filter((d: { kind: string }) => d.kind === "reply")).toHaveLength(3);
  });


  it("skips leads with empty post text", async () => {
    const postOutbound = vi.fn();
    const runner = { draft: vi.fn() };
    const nella = { search: vi.fn().mockResolvedValue([]) };
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
    const markStatus = vi.fn().mockResolvedValue(undefined);

    const n = await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" },
      claimedLeads: [
        { id: "L2", external_id: "x2", payload: { text: "" }, author_handle: "u", author_id: null, status: "drafting", tier: null, classifier_label: null, classifier_score: null, priority: false },
      ],
      runner: runner as never,
      kb: nella as never,
      postOutbound,
      markStatus,
    });

    expect(n).toBe(0);
    expect(postOutbound).not.toHaveBeenCalled();
    expect(markStatus).toHaveBeenCalledWith({ leadId: "L2", status: "skipped", meta: { skip_reason: "empty post text" } });
  });

  it("marks lead as errored when drafter output schema fails", async () => {
    const postOutbound = vi.fn();
    const runner = {
      draft: vi.fn().mockResolvedValue({ text: "not valid json", engine: "codex", model: "gpt-5" }),
    };
    const nella = {
      search: vi.fn().mockResolvedValue([
        { path: "p.md", snippet: "anchor", score: 8.0, filePath: "p.md", startLine: 1, endLine: 1, highlights: [] },
      ]),
    };
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
    const markStatus = vi.fn().mockResolvedValue(undefined);

    const n = await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" },
      claimedLeads: [
        { id: "L3", external_id: "x3", payload: { text: "some text" }, author_handle: "u", author_id: null, status: "drafting", tier: null, classifier_label: null, classifier_score: null, priority: false },
      ],
      runner: runner as never,
      kb: nella as never,
      postOutbound,
      markStatus,
    });

    expect(n).toBe(0);
    expect(postOutbound).not.toHaveBeenCalled();
    expect(markStatus).toHaveBeenCalledWith({ leadId: "L3", status: "errored", meta: { error: "schema" } });
  });

  it("keeps browser schema retries on Codex and recovers a malformed first draft", async () => {
    const postOutbound = vi.fn().mockResolvedValue({ id: "b", approval_id: "b" });
    const draft = vi
      .fn()
      .mockResolvedValueOnce({ text: '{"drafts": [', engine: "codex", model: "gpt-5" })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          drafts: [
            { angle: "empathetic", body: "e", char_count: 1 },
            { angle: "technical", body: "t", char_count: 1 },
            { angle: "contrarian", body: "c", char_count: 1 },
          ],
        }),
        engine: "codex",
        model: "gpt-5",
      });
    const runner = { draft };
    const nella = {
      search: vi.fn().mockResolvedValue([
        { path: "p.md", snippet: "anchor", score: 8.0, filePath: "p.md", startLine: 1, endLine: 1, highlights: [] },
      ]),
    };
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
    const markStatus = vi.fn().mockResolvedValue(undefined);

    const n = await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" },
      claimedLeads: [
        { id: "L5", external_id: "x5", payload: { text: "some post text", source: "extension_observed" }, author_handle: "u", author_id: null, status: "drafting", tier: null, classifier_label: null, classifier_score: null, priority: false },
      ],
      runner: runner as never,
      kb: nella as never,
      postOutbound,
      markStatus,
    });

    expect(draft).toHaveBeenCalledTimes(2);
    expect(draft.mock.calls.map((call) => call[0].codexSubscriptionOnly)).toEqual([true, true]);
    expect(n).toBe(1);
    expect(postOutbound).toHaveBeenCalled();
    expect(markStatus).not.toHaveBeenCalledWith(expect.objectContaining({ status: "errored" }));
  });

  it("drafts successfully with markdown-fenced JSON", async () => {
    const postOutbound = vi.fn().mockResolvedValue({ id: "b", approval_id: "b" });
    const runner = {
      draft: vi.fn().mockResolvedValue({
        text: "```json\n" + JSON.stringify({
          drafts: [
            { angle: "empathetic", body: "e", char_count: 1 },
            { angle: "technical", body: "t", char_count: 1 },
            { angle: "contrarian", body: "c", char_count: 1 },
          ],
        }) + "\n```",
        engine: "codex",
        model: "gpt-5",
      }),
    };
    const nella = {
      search: vi.fn().mockResolvedValue([
        { path: "p.md", snippet: "anchor", score: 8.0, filePath: "p.md", startLine: 1, endLine: 1, highlights: [] },
      ]),
    };
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
    const markStatus = vi.fn().mockResolvedValue(undefined);

    const n = await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" },
      claimedLeads: [
        { id: "L4", external_id: "x4", payload: { text: "some post text" }, author_handle: "u", author_id: null, status: "drafting", tier: null, classifier_label: null, classifier_score: null, priority: false },
      ],
      runner: runner as never,
      kb: nella as never,
      postOutbound,
      markStatus,
    });

    expect(n).toBe(1);
    expect(postOutbound).toHaveBeenCalledTimes(1);
    const body = postOutbound.mock.calls[0]![0];
    expect(body.drafts).toHaveLength(3);
  });

  it("treats {drafts:[{angle:'skip',body:'...'}]} as a skip, not a schema error", async () => {
    const postOutbound = vi.fn();
    const runner = {
      draft: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          drafts: [{ angle: "skip", body: "SKIP: no nella connection — post is unrelated.", char_count: 1 }],
        }),
        engine: "bedrock",
        model: "claude-sonnet-4-6",
      }),
    };
    const nella = {
      search: vi.fn().mockResolvedValue([
        { path: "p.md", snippet: "anchor", score: 8.0, filePath: "p.md", startLine: 1, endLine: 1, highlights: [] },
      ]),
    };
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
    const markStatus = vi.fn().mockResolvedValue(undefined);

    const n = await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" },
      claimedLeads: [
        { id: "Lskip", external_id: "xskip", payload: { text: "irrelevant post" }, author_handle: "u", author_id: null, status: "drafting", tier: null, classifier_label: null, classifier_score: null, priority: false },
      ],
      runner: runner as never,
      kb: nella as never,
      postOutbound,
      markStatus,
    });

    expect(n).toBe(0);
    expect(postOutbound).not.toHaveBeenCalled();
    expect(markStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "skipped" }));
  });

  it("does NOT let a model skip silently drop a watchlist (priority) lead — marks errored, not skipped", async () => {
    const postOutbound = vi.fn();
    const runner = {
      draft: vi.fn().mockResolvedValue({
        text: JSON.stringify({ skip: "not a nella fit" }),
        engine: "bedrock",
        model: "claude-sonnet-4-6",
      }),
    };
    const nella = {
      search: vi.fn().mockResolvedValue([
        { path: "p.md", snippet: "anchor", score: 0.1, filePath: "p.md", startLine: 1, endLine: 1, highlights: [] },
      ]),
    };
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
    const markStatus = vi.fn().mockResolvedValue(undefined);

    const n = await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" },
      claimedLeads: [
        { id: "Lpri-skip", external_id: "xpriskip", payload: { text: "watchlist person post" }, author_handle: "u", author_id: null, status: "drafting", tier: "T1", classifier_label: "watchlist", classifier_score: 1, priority: true },
      ],
      runner: runner as never,
      kb: nella as never,
      postOutbound,
      markStatus,
      relevanceThreshold: 1.5,
    });

    expect(n).toBe(0);
    expect(postOutbound).not.toHaveBeenCalled();
    // surfaced as errored (visible), NOT silently skipped
    expect(markStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "errored", meta: expect.objectContaining({ error: "priority_model_skip" }) }),
    );
    expect(markStatus).not.toHaveBeenCalledWith(expect.objectContaining({ status: "skipped" }));
  });

  it("treats prose 'no nella connection' reasoning as a skip", async () => {
    const postOutbound = vi.fn();
    const runner = {
      draft: vi.fn().mockResolvedValue({
        text:
          "The lead post is just a joke meme. There is no mention of agents, hallucinated imports, codebase indexing, or any Nella surface area — no nella connection here, recommending skip.",
        engine: "bedrock",
        model: "claude-sonnet-4-6",
      }),
    };
    const nella = {
      search: vi.fn().mockResolvedValue([
        { path: "p.md", snippet: "anchor", score: 8.0, filePath: "p.md", startLine: 1, endLine: 1, highlights: [] },
      ]),
    };
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
    const markStatus = vi.fn().mockResolvedValue(undefined);

    const n = await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" },
      claimedLeads: [
        { id: "Lprose", external_id: "xprose", payload: { text: "meme" }, author_handle: "u", author_id: null, status: "drafting", tier: null, classifier_label: null, classifier_score: null, priority: false },
      ],
      runner: runner as never,
      kb: nella as never,
      postOutbound,
      markStatus,
    });

    expect(n).toBe(0);
    expect(postOutbound).not.toHaveBeenCalled();
    expect(markStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "skipped" }));
  });

  it("still errors when output is unrelated prose with no skip intent", async () => {
    const postOutbound = vi.fn();
    const runner = {
      draft: vi.fn().mockResolvedValue({
        text: "Let me think about this carefully and produce drafts in a moment...",
        engine: "bedrock",
        model: "claude-sonnet-4-6",
      }),
    };
    const nella = {
      search: vi.fn().mockResolvedValue([
        { path: "p.md", snippet: "anchor", score: 8.0, filePath: "p.md", startLine: 1, endLine: 1, highlights: [] },
      ]),
    };
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
    const markStatus = vi.fn().mockResolvedValue(undefined);

    const n = await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" },
      claimedLeads: [
        { id: "Lerr", external_id: "xerr", payload: { text: "post" }, author_handle: "u", author_id: null, status: "drafting", tier: null, classifier_label: null, classifier_score: null, priority: false },
      ],
      runner: runner as never,
      kb: nella as never,
      postOutbound,
      markStatus,
    });

    expect(n).toBe(0);
    expect(postOutbound).not.toHaveBeenCalled();
    expect(markStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "errored" }));
  });

  it("skips lead without calling runner when top anchor score is below threshold", async () => {
    const postOutbound = vi.fn();
    const draft = vi.fn();
    const runner = { draft };
    // All anchors below the default threshold of 1.5.
    const nella = {
      search: vi.fn().mockResolvedValue([
        { path: "p1.md", snippet: "weak", score: 0.4, filePath: "p1.md", startLine: 1, endLine: 1, highlights: [] },
        { path: "p2.md", snippet: "weaker", score: 0.2, filePath: "p2.md", startLine: 1, endLine: 1, highlights: [] },
      ]),
    };
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
    const markStatus = vi.fn().mockResolvedValue(undefined);

    const n = await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" },
      claimedLeads: [
        { id: "Lbelow", external_id: "xbelow", payload: { text: "some post about unrelated topic" }, author_handle: "u", author_id: null, status: "drafting", tier: null, classifier_label: null, classifier_score: null, priority: false },
      ],
      runner: runner as never,
      kb: nella as never,
      postOutbound,
      markStatus,
      relevanceThreshold: 1.5,
    });

    expect(n).toBe(0);
    expect(draft).not.toHaveBeenCalled();
    expect(postOutbound).not.toHaveBeenCalled();
    expect(markStatus).toHaveBeenCalledWith({
      leadId: "Lbelow",
      status: "skipped",
      meta: expect.objectContaining({
        skip_reason: expect.stringContaining("below-relevance-threshold"),
        top_anchor_score: 0.4,
        relevance_threshold: 1.5,
      }),
    });
  });

  it("drafts lead when top anchor score meets the threshold", async () => {
    const postOutbound = vi.fn().mockResolvedValue({ id: "ok", approval_id: "ok" });
    const runner = {
      draft: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          drafts: [
            { angle: "empathetic", body: "e", char_count: 1 },
            { angle: "technical", body: "t", char_count: 1 },
            { angle: "contrarian", body: "c", char_count: 1 },
          ],
        }),
        engine: "codex",
        model: "gpt-5",
      }),
    };
    // Top anchor at 2.4 — comfortably above the 1.5 threshold.
    const nella = {
      search: vi.fn().mockResolvedValue([
        { path: "p1.md", snippet: "strong overlap", score: 2.4, filePath: "p1.md", startLine: 1, endLine: 1, highlights: [] },
        { path: "p2.md", snippet: "weaker", score: 0.4, filePath: "p2.md", startLine: 1, endLine: 1, highlights: [] },
      ]),
    };
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
    const markStatus = vi.fn().mockResolvedValue(undefined);

    const n = await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" },
      claimedLeads: [
        { id: "Labove", external_id: "xabove", payload: { text: "on-topic post about agents" }, author_handle: "u", author_id: null, status: "drafting", tier: null, classifier_label: null, classifier_score: null, priority: false },
      ],
      runner: runner as never,
      kb: nella as never,
      postOutbound,
      markStatus,
      relevanceThreshold: 1.5,
    });

    expect(n).toBe(1);
    expect(runner.draft).toHaveBeenCalledTimes(1);
    expect(postOutbound).toHaveBeenCalledTimes(1);
    expect(markStatus).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: "Labove", status: "drafted" }),
    );
  });

  it("skips a non-priority lead below the classifier quality threshold without searching the KB or drafting", async () => {
    const postOutbound = vi.fn();
    const draft = vi.fn();
    const runner = { draft };
    const search = vi.fn().mockResolvedValue([]);
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
    const markStatus = vi.fn().mockResolvedValue(undefined);
    const n = await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" },
      claimedLeads: [
        { id: "Lq", external_id: "xq", payload: { text: "low quality post" }, author_handle: "u", author_id: null, status: "drafting", tier: null, classifier_label: "thought", classifier_score: 0.3, priority: false },
      ],
      runner: runner as never,
      kb: { search } as never,
      postOutbound,
      markStatus,
      qualityThreshold: 0.5,
    });
    expect(n).toBe(0);
    expect(search).not.toHaveBeenCalled();
    expect(draft).not.toHaveBeenCalled();
    expect(postOutbound).not.toHaveBeenCalled();
    expect(markStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        leadId: "Lq",
        status: "skipped",
        meta: expect.objectContaining({ skip_reason: expect.stringContaining("below-quality-threshold") }),
      }),
    );
  });

  // CONTRACT CHANGE: this used to assert that an unscored lead is SKIPPED. That
  // was fail-CLOSED — a classifier outage silently dropped every keyword lead —
  // and it contradicted the fail-open contract Lyra and Orion implement. A null
  // score means the scoring call failed, not that the lead is junk (over 90 days
  // 399 `label=other` leads carry a score and 193 do not), so the lead now
  // proceeds to drafting where the relevance gate and verifier still apply.
  it("drafts a non-priority lead the classifier could not score (null) — fails OPEN", async () => {
    const search = vi.fn().mockResolvedValue([]);
    const markStatus = vi.fn().mockResolvedValue(undefined);
    await runDrafterTick({
      log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
      instance: { id: "i", org_id: "o" },
      claimedLeads: [
        { id: "Lnull", external_id: "xn", payload: { text: "unscored post" }, author_handle: "u", author_id: null, status: "drafting", tier: null, classifier_label: "other", classifier_score: null, priority: false },
      ],
      runner: { draft: vi.fn() } as never,
      kb: { search } as never,
      postOutbound: vi.fn(),
      markStatus,
      qualityThreshold: 0.5,
    });
    // It got past the QUALITY gate: the drafter ran its grounding search, which
    // the old fail-closed path short-circuited before reaching.
    expect(search).toHaveBeenCalled();
    // If it is skipped at all it must be by a LATER gate (relevance/verifier),
    // never for the quality score it never had.
    for (const call of markStatus.mock.calls) {
      const reason = (call[0] as { meta?: { skip_reason?: string } })?.meta?.skip_reason ?? "";
      expect(reason).not.toContain("below-quality-threshold");
    }
  });

  it("drafts a PRIORITY (watchlist) lead even with a null score (quality gate bypassed)", async () => {
    const runner = {
      draft: vi.fn().mockResolvedValue({
        text: JSON.stringify({ drafts: [{ angle: "empathetic", body: "e", char_count: 1 }] }),
        engine: "codex",
        model: "gpt-5",
      }),
    };
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const markStatus = vi.fn().mockResolvedValue(undefined);
    const n = await runDrafterTick({
      log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
      instance: { id: "i", org_id: "o" },
      claimedLeads: [
        { id: "Lpri", external_id: "xp", payload: { text: "watchlist post" }, author_handle: "u", author_id: null, status: "drafting", tier: "T1", classifier_label: "watchlist", classifier_score: null, priority: true },
      ],
      runner: runner as never,
      kb: { search: vi.fn().mockResolvedValue([{ path: "p.md", snippet: "anchor", score: 8.0, filePath: "p.md", startLine: 1, endLine: 1, highlights: [] }]) } as never,
      postOutbound,
      markStatus,
      qualityThreshold: 0.5,
    });
    expect(n).toBe(1);
    expect(postOutbound).toHaveBeenCalledTimes(1);
  });

  it("skips lead when nella returns zero anchors (treated as score=0, below any positive threshold)", async () => {
    const postOutbound = vi.fn();
    const draft = vi.fn();
    const runner = { draft };
    const nella = { search: vi.fn().mockResolvedValue([]) };
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
    const markStatus = vi.fn().mockResolvedValue(undefined);

    const n = await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" },
      claimedLeads: [
        { id: "Lzero", external_id: "xzero", payload: { text: "completely unrelated text" }, author_handle: "u", author_id: null, status: "drafting", tier: null, classifier_label: null, classifier_score: null, priority: false },
      ],
      runner: runner as never,
      kb: nella as never,
      postOutbound,
      markStatus,
      relevanceThreshold: 1.5,
    });

    expect(n).toBe(0);
    expect(draft).not.toHaveBeenCalled();
    expect(markStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        leadId: "Lzero",
        status: "skipped",
        meta: expect.objectContaining({ top_anchor_score: 0, relevance_threshold: 1.5 }),
      }),
    );
  });

  it("marks the lead errored with reason='budget_exceeded' when the runner throws BudgetExceededError", async () => {
    const markStatus = vi.fn().mockResolvedValue(undefined);
    const postOutbound = vi.fn().mockResolvedValue({ id: "x", approval_id: "y" });
    const runner = {
      draft: vi.fn(async () => {
        throw new BudgetExceededError({
          layer: "instance",
          spent_cents: 9999,
          cap_cents: 10000,
          estimated_cents: 200,
        });
      }),
    };
    // High-score anchor so the relevance gate lets the lead through to the runner.
    const nella = {
      search: vi.fn(async () => [
        { path: "p.md", snippet: "strong", score: 5.0, filePath: "p.md", startLine: 1, endLine: 1, highlights: [] },
      ]),
    };

    await runDrafterTick({
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      instance: { id: "inst_1", org_id: "org_1" } as never,
      claimedLeads: [
        {
          id: "lead_1",
          external_id: "ext_1",
          payload: { text: "Hi, I'm asking about agent frameworks" },
          author_handle: "test",
          author_id: "1",
          tier: null,
          classifier_label: null,
          classifier_score: null,
          status: "classified",
        },
      ] as never,
      runner: runner as never,
      kb: nella as never,
      postOutbound,
      markStatus,
      relevanceThreshold: 1.5,
    });

    // postOutbound must NOT have been called — the call never reached
    // the network, no draft exists.
    expect(postOutbound).not.toHaveBeenCalled();

    expect(markStatus).toHaveBeenCalledTimes(1);
    expect(markStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        leadId: "lead_1",
        status: "errored",
        meta: expect.objectContaining({
          error: "budget_exceeded",
          layer: "instance",
          spent_cents: 9999,
          cap_cents: 10000,
        }),
      }),
    );
  });

  it("does not retry on BudgetExceededError — runner is called exactly once", async () => {
    const markStatus = vi.fn().mockResolvedValue(undefined);
    const runner = {
      draft: vi.fn(async () => {
        throw new BudgetExceededError({
          layer: "org",
          spent_cents: 30000,
          cap_cents: 30000,
          estimated_cents: 5,
        });
      }),
    };
    // High-score anchor so the relevance gate lets the lead through to the runner.
    const nella = {
      search: vi.fn(async () => [
        { path: "p.md", snippet: "strong", score: 5.0, filePath: "p.md", startLine: 1, endLine: 1, highlights: [] },
      ]),
    };

    await runDrafterTick({
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      instance: { id: "inst_1", org_id: "org_1" } as never,
      claimedLeads: [
        {
          id: "lead_2",
          external_id: "ext_2",
          payload: { text: "Another lead" },
          author_handle: "x",
          author_id: "1",
          tier: null,
          classifier_label: null,
          classifier_score: null,
          status: "classified",
        },
      ] as never,
      runner: runner as never,
      kb: nella as never,
      postOutbound: vi.fn(),
      markStatus,
      relevanceThreshold: 1.5,
    });

    expect(runner.draft).toHaveBeenCalledTimes(1);
  });

  it("injects a watchlist person's objective into the draft system prompt (normalizing @/case)", async () => {
    const postOutbound = vi.fn().mockResolvedValue({ id: "d", approval_id: "a" });
    const runner = {
      draft: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          drafts: [
            { angle: "empathetic", body: "e", char_count: 1 },
            { angle: "technical", body: "t", char_count: 1 },
            { angle: "contrarian", body: "c", char_count: 1 },
          ],
        }),
        engine: "codex",
        model: "gpt-5",
      }),
    };
    const nella = {
      search: vi.fn().mockResolvedValue([
        { path: "p.md", snippet: "strong", score: 8.0, filePath: "p.md", startLine: 1, endLine: 1, highlights: [] },
      ]),
    };
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
    const markStatus = vi.fn().mockResolvedValue(undefined);
    // getWatchlistObjectives reads x_watchlist_people; the stored handle is
    // lowercased/@-stripped, the lead's author_handle is the raw "@JDoe".
    const sql = vi.fn().mockResolvedValue([
      { handle: "jdoe", objective_kind: "amplify", objective_note: "boost them" },
    ]);

    await runDrafterTick({
      patternRules: [],
      log,
      instance: { id: "i", org_id: "o" },
      claimedLeads: [
        { id: "L", external_id: "x1", payload: { text: "post text" }, author_handle: "@JDoe", author_id: "uid", status: "drafting", tier: null, classifier_label: null, classifier_score: null, priority: false },
      ],
      runner: runner as never,
      kb: nella as never,
      postOutbound,
      markStatus,
      sql: sql as never,
    });

    expect(runner.draft).toHaveBeenCalledTimes(1);
    const system: string = runner.draft.mock.calls[0]![0].system;
    expect(system).toContain("PER-PERSON OBJECTIVE");
    expect(system).toContain("Champion and signal-boost"); // amplify directive
    expect(system).toContain("boost them"); // operator note
  });

  it("leaves the system prompt unchanged when the lead's author has no objective", async () => {
    const postOutbound = vi.fn().mockResolvedValue({ id: "d", approval_id: "a" });
    const runner = {
      draft: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          drafts: [
            { angle: "empathetic", body: "e", char_count: 1 },
            { angle: "technical", body: "t", char_count: 1 },
            { angle: "contrarian", body: "c", char_count: 1 },
          ],
        }),
        engine: "codex",
        model: "gpt-5",
      }),
    };
    const nella = {
      search: vi.fn().mockResolvedValue([
        { path: "p.md", snippet: "strong", score: 8.0, filePath: "p.md", startLine: 1, endLine: 1, highlights: [] },
      ]),
    };
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
    const markStatus = vi.fn().mockResolvedValue(undefined);
    const sql = vi.fn().mockResolvedValue([]); // no objectives for this instance

    await runDrafterTick({
      patternRules: [],
      log,
      instance: { id: "i", org_id: "o" },
      claimedLeads: [
        { id: "L", external_id: "x1", payload: { text: "post text" }, author_handle: "someone", author_id: "uid", status: "drafting", tier: null, classifier_label: null, classifier_score: null, priority: false },
      ],
      runner: runner as never,
      kb: nella as never,
      postOutbound,
      markStatus,
      sql: sql as never,
    });

    const system: string = runner.draft.mock.calls[0]![0].system;
    expect(system).not.toContain("PER-PERSON OBJECTIVE");
  });

  it("drafts a priority (watchlist) lead even when anchors are below the relevance threshold", async () => {
    const postOutbound = vi.fn().mockResolvedValue({ id: "d", approval_id: "a" });
    const draft = vi.fn().mockResolvedValue({
      text: JSON.stringify({ drafts: [{ angle: "technical", body: "hi", char_count: 2 }] }),
      engine: "codex",
      model: "gpt-5",
    });
    const runner = { draft };
    // All anchors well below the 1.5 threshold — a normal lead would be skipped.
    const nella = {
      search: vi.fn().mockResolvedValue([
        { path: "p1.md", snippet: "weak", score: 0.1, filePath: "p1.md", startLine: 1, endLine: 1, highlights: [] },
      ]),
    };
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
    const markStatus = vi.fn().mockResolvedValue(undefined);

    const n = await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o", auto_send_enabled: false } as never,
      claimedLeads: [
        { id: "Lpri", external_id: "xpri", payload: { text: "anything at all" }, author_handle: "u", author_id: null, status: "drafting", tier: "T1", classifier_label: "watchlist", classifier_score: 1, priority: true },
      ],
      runner: runner as never,
      kb: nella as never,
      postOutbound,
      markStatus,
      relevanceThreshold: 1.5,
    });

    expect(n).toBe(1);
    expect(draft).toHaveBeenCalledTimes(1);
    expect(postOutbound).toHaveBeenCalledTimes(1);
    expect(markStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "drafted" }));
  });

  it.each(["2026-02-24T14:00:41.000Z", undefined, "", "2026-02-30T00:00:00Z"])(
    "forwards measured source time or unknown for %j", async (realPostedAt) => {
    const postOutbound = vi.fn().mockResolvedValue({ id: "d", approval_id: "a" });
    const runner = {
      draft: vi.fn().mockResolvedValue({
        text: JSON.stringify({ drafts: [{ angle: "technical", body: "hi", char_count: 2 }] }),
        engine: "codex",
        model: "gpt-5",
      }),
    };
    const nella = {
      search: vi.fn().mockResolvedValue([
        { path: "p.md", snippet: "anchor", score: 8.0, filePath: "p.md", startLine: 1, endLine: 1, highlights: [] },
      ]),
    };
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" },
      claimedLeads: [
        { id: "L", external_id: "x1", payload: { text: "post text", url: "https://x.com/u/status/1", posted_at: realPostedAt }, author_handle: "u", author_id: "uid", status: "drafting", tier: null, classifier_label: null, classifier_score: null, priority: false },
      ],
      runner: runner as never,
      kb: nella as never,
      postOutbound,
      markStatus: vi.fn().mockResolvedValue(undefined),
    });
    expect(postOutbound).toHaveBeenCalledTimes(1);
    expect(postOutbound.mock.calls[0]![0].postedAt).toBe(realPostedAt === "2026-02-24T14:00:41.000Z" ? realPostedAt : null);
  });
});

describe("runDmRequestTick (on-demand DM)", () => {
  const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
  const nella = {
    search: vi.fn().mockResolvedValue([
      { path: "p.md", snippet: "anchor", score: 3.0, filePath: "p.md", startLine: 1, endLine: 1, highlights: [] },
    ]),
  };
  const callArgs = (runner: unknown, postOutbound: unknown, posted_at?: unknown) => ({
    log,
    instance: { id: "i", org_id: "o" } as never,
    claimedLeads: [
      { id: "L", external_id: "x1", payload: { text: "post text", url: "https://x.com/u/status/1", posted_at }, author_handle: "u", author_id: "uid", status: "drafted", tier: null, classifier_label: null, classifier_score: null, priority: false },
    ] as never,
    kb: nella as never,
    runner: runner as never,
    postOutbound: postOutbound as never,
  });

  it.each([undefined, "", "2026-02-30T00:00:00Z", "2026-10-01T12:34:56.000Z"])("queues only the DM and preserves measured or unknown source time: %s", async (postedAt) => {
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const runner = {
      draft: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          drafts: [{ angle: "empathetic", body: "e", char_count: 1 }],
          dm: { body: "hey saw your post\n\nlet's chat", char_count: 28 },
        }),
        engine: "codex",
        model: "gpt-5",
      }),
    };
    const n = await runDmRequestTick(callArgs(runner, postOutbound, postedAt));
    expect(n).toBe(1);
    expect(postOutbound).toHaveBeenCalledTimes(1);
    const body = postOutbound.mock.calls[0]![0];
    expect(body.drafts).toHaveLength(1);
    expect(body.drafts[0].kind).toBe("dm");
    expect(body.drafts[0].body).toContain("saw your post");
    expect(body.autoSend).toBeNull();
    expect(body.postedAt).toBe(postedAt === "2026-10-01T12:34:56.000Z" ? postedAt : null);
  });

  it("queues nothing when the model returns no DM", async () => {
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const runner = {
      draft: vi.fn().mockResolvedValue({
        text: JSON.stringify({ drafts: [{ angle: "empathetic", body: "e", char_count: 1 }] }),
        engine: "codex",
        model: "gpt-5",
      }),
    };
    const n = await runDmRequestTick(callArgs(runner, postOutbound));
    expect(n).toBe(0);
    expect(postOutbound).not.toHaveBeenCalled();
  });
});

// When a tweet has image(s) and a captionFn is wired, the drafter captions them
// and injects "THE POST'S IMAGE SHOWS:" into the prompt so the reply isn't blind
// to the visual. Fail-open everywhere: no images / no captionFn / a caption error
// → no block, the draft still ships.
describe("runDrafterTick — vision caption (X post images)", () => {
  const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
  const mkRunner = () => ({
    draft: vi.fn().mockResolvedValue({
      text: JSON.stringify({
        drafts: [
          { angle: "empathetic", body: "e", char_count: 1 },
          { angle: "technical", body: "t", char_count: 1 },
          { angle: "contrarian", body: "c", char_count: 1 },
        ],
      }),
      engine: "codex",
      model: "gpt-5",
    }),
  });
  const mkKb = () => ({
    search: vi.fn().mockResolvedValue([
      { path: "p.md", snippet: "anchor", score: 8.0, filePath: "p.md", startLine: 1, endLine: 1, highlights: [] },
    ]),
  });
  const leadWithImages = () => ({
    id: "L",
    external_id: "x1",
    payload: { text: "look at this chart", url: "https://x.com/u/status/1", images: ["https://pbs.twimg.com/media/a.jpg"] },
    author_handle: "u",
    author_id: "uid",
    status: "drafting",
    tier: null,
    classifier_label: null,
    classifier_score: null,
    priority: false,
  });

  it.each([false, true])("stops paid drafting after caption admission rejects (priority=%s)", async (priority) => {
    const runner = mkRunner();
    const markStatus = vi.fn().mockResolvedValue(undefined);
    const postOutbound = vi.fn();
    const captionFn = vi.fn().mockRejectedValue(new BudgetExceededError({ layer: "instance", spent_cents: 1, cap_cents: 1, estimated_cents: 1 }));
    expect(await runDrafterTick({ log, instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [{ ...leadWithImages(), priority }] as never, runner: runner as never,
      kb: mkKb() as never, postOutbound, markStatus, captionFn })).toBe(0);
    expect(runner.draft).not.toHaveBeenCalled();
    expect(postOutbound).not.toHaveBeenCalled();
    expect(markStatus).toHaveBeenCalledWith(expect.objectContaining({ status: priority ? "classified" : "errored",
      meta: expect.objectContaining({ error: "budget_exceeded" }) }));
  });

  it("captions the tweet's images and injects 'THE POST'S IMAGE SHOWS:' into the prompt", async () => {
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const runner = mkRunner();
    const captionFn = vi.fn().mockResolvedValue("a line chart of MRR doubling over 3 months");
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [leadWithImages()] as never,
      runner: runner as never,
      kb: mkKb() as never,
      postOutbound,
      markStatus: vi.fn().mockResolvedValue(undefined),
      captionFn,
    });
    expect(captionFn).toHaveBeenCalledTimes(1);
    const prompt = runner.draft.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain("THE POST'S IMAGE SHOWS:");
    expect(prompt).toContain("a line chart of MRR doubling");
  });

  it("no captionFn → no image line (drafting unchanged)", async () => {
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const runner = mkRunner();
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [leadWithImages()] as never,
      runner: runner as never,
      kb: mkKb() as never,
      postOutbound,
      markStatus: vi.fn().mockResolvedValue(undefined),
    });
    const prompt = runner.draft.mock.calls[0]![0].prompt as string;
    expect(prompt).not.toContain("THE POST'S IMAGE SHOWS:");
  });

  it("no images on the lead → captionFn never called, no image line", async () => {
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const runner = mkRunner();
    const captionFn = vi.fn().mockResolvedValue("should not be used");
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [
        { id: "L", external_id: "x1", payload: { text: "just words", url: "https://x.com/u/status/1" }, author_handle: "u", author_id: "uid", status: "drafting", tier: null, classifier_label: null, classifier_score: null, priority: false },
      ] as never,
      runner: runner as never,
      kb: mkKb() as never,
      postOutbound,
      markStatus: vi.fn().mockResolvedValue(undefined),
      captionFn,
    });
    expect(captionFn).not.toHaveBeenCalled();
    const prompt = runner.draft.mock.calls[0]![0].prompt as string;
    expect(prompt).not.toContain("THE POST'S IMAGE SHOWS:");
  });

  it("fails open when the vision call throws (drafting proceeds, no image line)", async () => {
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const runner = mkRunner();
    const captionFn = vi.fn().mockRejectedValue(new Error("vision 500"));
    const n = await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [leadWithImages()] as never,
      runner: runner as never,
      kb: mkKb() as never,
      postOutbound,
      markStatus: vi.fn().mockResolvedValue(undefined),
      captionFn,
    });
    expect(n).toBe(1); // draft still shipped
    const prompt = runner.draft.mock.calls[0]![0].prompt as string;
    expect(prompt).not.toContain("THE POST'S IMAGE SHOWS:");
  });
});

describe("runDrafterTick voice variety (NOELLE_DRAFTER_VARIETY)", () => {
  const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
  const mkRunner = () => ({
    draft: vi.fn().mockResolvedValue({
      text: JSON.stringify({
        drafts: [
          { angle: "empathetic", body: "e", char_count: 1 },
          { angle: "technical", body: "t", char_count: 1 },
          { angle: "contrarian", body: "c", char_count: 1 },
        ],
      }),
      engine: "codex",
      model: "gpt-5",
    }),
  });
  const mkKb = () => ({
    search: vi.fn().mockResolvedValue([
      { path: "p.md", snippet: "anchor", score: 8.0, filePath: "p.md", startLine: 1, endLine: 1, highlights: [] },
    ]),
  });
  const mkLead = () => ({
    id: "L",
    external_id: "x1",
    payload: { text: "post text", url: "https://x.com/u/status/1" },
    author_handle: "u",
    author_id: "uid",
    status: "drafting",
    tier: null,
    classifier_label: null,
    classifier_score: null,
    priority: false,
  });

  // A post with no strong energy takes the SHAPE lane: form rotates so the feed
  // stops reading as one mold. (Before the form-variant port this lane injected a
  // blind register instead; the register lane now lives on the tone-first
  // energies, covered by the two tests below.)
  it("assigns a rotating SHAPE (not a register) when variety is ON and the post has no strong energy", async () => {
    const runner = mkRunner();
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [mkLead()] as never,
      runner: runner as never,
      kb: mkKb() as never,
      postOutbound: vi.fn().mockResolvedValue({ id: "a", approval_id: "a" }),
      markStatus: vi.fn().mockResolvedValue(undefined),
      variety: { enabled: true, rng: () => 0 },
    });
    const prompt = runner.draft.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain("THIS REPLY'S ASSIGNED SHAPE");
    expect(prompt).not.toContain("ASSIGNED REGISTER FOR THIS REPLY");
  });

  it("lets a MICRO shape authorise a ONE-word reply (overrides the 40-120 budget)", async () => {
    const runner = mkRunner();
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [mkLead()] as never,
      runner: runner as never,
      kb: mkKb() as never,
      postOutbound: vi.fn().mockResolvedValue({ id: "a", approval_id: "a" }),
      markStatus: vi.fn().mockResolvedValue(undefined),
      // Pin the rotation to MICRO so the assertion is about the wiring, not luck.
      variety: {
        enabled: true,
        formVariantRotation: {
          next: () => X_FORM_VARIANTS.find((v) => v.id === "MICRO")!,
        },
      },
    });
    const prompt = runner.draft.mock.calls[0]![0].prompt as string;
    const system = runner.draft.mock.calls[0]![0].system as string;
    expect(prompt).toContain("between ONE and 8 words");
    // The shape must be granted authority over the default length budget, or the
    // 40-char floor in SYSTEM_X silently wins and MICRO never lands.
    expect(prompt).toMatch(/OVERRIDES the default reply length/);
    expect(system).toMatch(/ASSIGNED SHAPE/);
    // ...and the prompt's OWN closing output contract must not re-impose the
    // budget underneath the shape block. This is the LAST line of the user
    // message, so a fixed "40-120 / hard max 150" there sits BELOW the shape and
    // its "overrides the rules above" can never reach it.
    expect(prompt).not.toContain("40-120 chars with a hard max of 150");
    const lines = prompt.split("\n");
    expect(lines[lines.length - 1]).toMatch(/ASSIGNED SHAPE above asks for/);
  });

  it("keeps the fixed 40-120 output contract when NO shape is assigned", () => {
    // The shape-aware trailer must not leak into the non-shape path.
    const runner = mkRunner();
    return runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [mkLead()] as never,
      runner: runner as never,
      kb: mkKb() as never,
      postOutbound: vi.fn().mockResolvedValue({ id: "a", approval_id: "a" }),
      markStatus: vi.fn().mockResolvedValue(undefined),
    }).then(() => {
      const prompt = runner.draft.mock.calls[0]![0].prompt as string;
      expect(prompt).toContain("40-120 chars with a hard max of 150");
      expect(prompt).not.toContain("THIS REPLY'S ASSIGNED SHAPE");
    });
  });

  // The REGISTER lane still exists: on a tone-first energy (joke/celebration/
  // vent/hot take) mirroring the tone beats varying the form, so the register
  // wins and no shape is assigned.
  it("uses the energy REGISTER instead of a shape on a celebration (tone-first energy)", async () => {
    const runner = mkRunner();
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [
        {
          ...mkLead(),
          classifier_label: "light",
          payload: {
            text: "we just raised our seed round!! so happy to announce this",
            url: "https://x.com/u/status/1",
          },
        },
      ] as never,
      runner: runner as never,
      kb: mkKb() as never,
      postOutbound: vi.fn().mockResolvedValue({ id: "a", approval_id: "a" }),
      markStatus: vi.fn().mockResolvedValue(undefined),
      // r=0.9 is above TONE_FIRST_SHAPE_SHARE, so this celebration lands on the
      // REGISTER half of the tone-first split. Within the celebration register
      // set, 0.9 walks past HYPE/ULTRA_SHORT/SLANG to NORMAL, so the assertion
      // below is on the block, not on a specific register's wording.
      variety: { enabled: true, rng: () => 0.9 },
      energy: { enabled: true },
    });
    const prompt = runner.draft.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain("ASSIGNED REGISTER FOR THIS REPLY");
    expect(prompt).not.toContain("THIS REPLY'S ASSIGNED SHAPE");
  });

  it("gives the SHAPED half of the tone-first split an energy-scoped shape", async () => {
    // The tone-first lane used to mean "register, and no shape at all", so
    // every joke/celebration/vent/hot-take lead came out in the default length
    // band. Half of them now get a shape instead — drawn only from the shapes
    // that can carry that energy.
    const runner = mkRunner();
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [
        {
          ...mkLead(),
          classifier_label: "light",
          payload: {
            text: "we just raised our seed round!! so happy to announce this",
            url: "https://x.com/u/status/1",
          },
        },
      ] as never,
      runner: runner as never,
      kb: mkKb() as never,
      postOutbound: vi.fn().mockResolvedValue({ id: "a", approval_id: "a" }),
      markStatus: vi.fn().mockResolvedValue(undefined),
      // r=0 is below TONE_FIRST_SHAPE_SHARE → the shaped half.
      variety: { enabled: true, rng: () => 0, genzMarkerRate: 0 },
      energy: { enabled: true },
    });
    const prompt = runner.draft.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain("THIS REPLY'S ASSIGNED SHAPE");
    expect(prompt).not.toContain("ASSIGNED REGISTER FOR THIS REPLY");
    // You cannot disagree with someone's launch, and QUESTION_ONLY is already
    // off-register on a win via the LIGHT lane.
    expect(prompt).not.toContain("Disagree, flat, in your own words");
    expect(prompt).not.toContain("The whole reply is ONE genuine, specific question");
  });

  it("offers a gen-z marker on the leads that roll under the rate, and none above it", async () => {
    const promptFor = async (rate: number, r: number) => {
      const runner = mkRunner();
      await runDrafterTick({
        log,
        instance: { id: "i", org_id: "o" } as never,
        claimedLeads: [mkLead()] as never,
        runner: runner as never,
        kb: mkKb() as never,
        postOutbound: vi.fn().mockResolvedValue({ id: "a", approval_id: "a" }),
        markStatus: vi.fn().mockResolvedValue(undefined),
        variety: { enabled: true, rng: () => r, genzMarkerRate: rate },
      });
      return runner.draft.mock.calls[0]![0].prompt as string;
    };
    expect(await promptFor(0.9, 0.1)).toContain("SPOKEN REGISTER FOR THIS REPLY");
    expect(await promptFor(0.9, 0.95)).not.toContain("SPOKEN REGISTER FOR THIS REPLY");
    // Rate 0 is the off switch and must emit nothing at all.
    expect(await promptFor(0, 0)).not.toContain("SPOKEN REGISTER FOR THIS REPLY");
  });

  it("keeps the marker OUT of the DM and never stacks two markers", async () => {
    const runner = mkRunner();
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [mkLead()] as never,
      runner: runner as never,
      kb: mkKb() as never,
      postOutbound: vi.fn().mockResolvedValue({ id: "a", approval_id: "a" }),
      markStatus: vi.fn().mockResolvedValue(undefined),
      variety: { enabled: true, rng: () => 0.1, genzMarkerRate: 1 },
    });
    const prompt = runner.draft.mock.calls[0]![0].prompt as string;
    // Exactly one marker block, and it says so.
    expect(prompt.match(/SPOKEN REGISTER FOR THIS REPLY/g)).toHaveLength(1);
    expect(prompt).toContain("never two markers in one reply");
    expect(prompt).toContain("never a DM");
    // The cosplay tier stays banned inside the very block that grants slang.
    expect(prompt).toContain("stay banned");
  });

  it("wires the X rotation to all three conversational moves", () => {
    const expected = new Set([
      "GROUNDED_AGREEMENT",
      "CONTEXT_SUPPORTED_ADDRESS",
      "RELATIONAL_TAG",
    ]);
    const seen = new Set<string>();
    for (let i = 0; i < 120; i++) {
      const marker = xGenZMarkerRotation.next(makeLcgForShapes(i + 1), "analytical");
      if (marker && expected.has(marker.id)) seen.add(marker.id);
    }
    expect(seen).toEqual(expected);
  });

  it("puts a forced conversational move in the public reply guidance once and excludes the DM", async () => {
    const marker = GENZ_MARKERS.find((candidate) => candidate.id === "GROUNDED_AGREEMENT");
    expect(marker).toBeDefined();

    const runner = mkRunner();
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [mkLead()] as never,
      runner: runner as never,
      kb: mkKb() as never,
      postOutbound: vi.fn().mockResolvedValue({ id: "a", approval_id: "a" }),
      markStatus: vi.fn().mockResolvedValue(undefined),
      variety: {
        enabled: true,
        rng: () => 0,
        genzMarkerRate: 1,
        genzMarkerRotation: { next: () => marker ?? null },
      },
    });

    const prompt = runner.draft.mock.calls[0]![0].prompt as string;
    expect(prompt.match(/SPOKEN REGISTER FOR THIS REPLY/g)).toHaveLength(1);
    expect(prompt).toContain(marker?.directive);
    expect(prompt).toContain("public reply only, never a DM");
    expect(prompt).toContain("AT MOST ONE of them");
  });

  it("keeps an emoji-only draft alive instead of emptying the outbound", async () => {
    // The post-aware emoji gate can strip a body to "": a reply that is only an
    // allowlisted emoji, under a post with no emoji. Every naive handling of
    // that is worse than the problem — shipping "" violates body.min(1) and
    // THROWS, and on LinkedIn's batched path that throw re-runs the whole batch
    // (duplicate approvals plus duplicate paid calls); filtering to an empty
    // list throws the same way; filtering and letting the "no replies left"
    // branch handle it kills the lead, discards the DM, and blames the
    // commitment guard.
    //
    // So the policy keeps ONE draft under allowlist-only stripping. Asserted on
    // what postOutbound RECEIVES, not inside an `if` that may never run — the
    // first version of this test guarded its only real assertion behind
    // `if (postOutbound.mock.calls.length > 0)`, which was never true.
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const markStatus = vi.fn().mockResolvedValue(undefined);
    const runner = mkRunner();
    runner.draft = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        drafts: [{ angle: "empathetic", body: "\u{1F480}", char_count: 1 }],
        dm: { body: "hey\n\nsaw this\n\nlmk", char_count: 20 },
      }),
      engine: "bedrock",
      model: "m",
    });
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [mkLead()] as never,
      runner: runner as never,
      kb: mkKb() as never,
      postOutbound,
      markStatus,
    });
    expect(postOutbound).toHaveBeenCalledTimes(1);
    const drafts = postOutbound.mock.calls[0]![0].drafts as Array<{ kind: string; body: string }>;
    expect(drafts.length).toBeGreaterThan(0);
    for (const d of drafts) expect(d.body.trim().length).toBeGreaterThan(0);
    // The reply survives as a reply row. (Whether a DM row is appended depends
    // on the auto-DM toggle, which this test does not enable, so it is not
    // asserted here — the point under test is that the outbound is not empty
    // and the lead is not killed.)
    expect(drafts.some((d) => d.kind === "reply")).toBe(true);
    expect(markStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "errored" }),
    );
  });

  it("never injects a register and a shape at the same time (they both claim length)", async () => {
    for (const energyOn of [true, false]) {
      const runner = mkRunner();
      await runDrafterTick({
        log,
        instance: { id: "i", org_id: "o" } as never,
        claimedLeads: [mkLead()] as never,
        runner: runner as never,
        kb: mkKb() as never,
        postOutbound: vi.fn().mockResolvedValue({ id: "a", approval_id: "a" }),
        markStatus: vi.fn().mockResolvedValue(undefined),
        variety: { enabled: true, rng: () => 0.25 },
        ...(energyOn ? { energy: { enabled: true } } : {}),
      });
      const prompt = runner.draft.mock.calls[0]![0].prompt as string;
      const hasRegister = prompt.includes("ASSIGNED REGISTER FOR THIS REPLY");
      const hasShape = prompt.includes("THIS REPLY'S ASSIGNED SHAPE");
      expect(hasRegister && hasShape).toBe(false);
      expect(hasRegister || hasShape).toBe(true);
    }
  });

  it("rotates the shape across consecutive leads (no two in a row the same)", async () => {
    const runner = mkRunner();
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [
        { ...mkLead(), id: "l1", external_id: "x1" },
        { ...mkLead(), id: "l2", external_id: "x2" },
        { ...mkLead(), id: "l3", external_id: "x3" },
      ] as never,
      runner: runner as never,
      kb: mkKb() as never,
      postOutbound: vi.fn().mockResolvedValue({ id: "a", approval_id: "a" }),
      markStatus: vi.fn().mockResolvedValue(undefined),
      variety: { enabled: true, rng: makeLcgForShapes(5) },
    });
    const directives = runner.draft.mock.calls.map((c) => {
      const p = (c as unknown as [{ prompt: string }])[0].prompt;
      const m = /THIS REPLY'S ASSIGNED SHAPE[^\n]*\n([^\n]+)/.exec(p);
      return m ? m[1]! : "";
    });
    expect(directives.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < directives.length; i++) {
      expect(directives[i]).not.toBe(directives[i - 1]);
    }
  });

  it("injects the per-person do-not-repeat list and passes it to the verifier", async () => {
    const runner = mkRunner();
    const verifyCalls: unknown[] = [];
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [mkLead()] as never,
      runner: runner as never,
      kb: mkKb() as never,
      postOutbound: vi.fn().mockResolvedValue({ id: "a", approval_id: "a" }),
      markStatus: vi.fn().mockResolvedValue(undefined),
      getPriorReplies: async () => ["the exact take i already used on them"],
      verify: {
        enabled: true,
        retries: 0,
        makeCalls: () => [
          (_s: string, _p: string) => {
            verifyCalls.push(_p);
            return Promise.resolve(
              JSON.stringify({
                scores: { voice: 1, grounding: 1, relevance: 1, novelty: 1 },
                reasons: [],
              }),
            );
          },
        ],
      },
    } as never);
    const prompt = runner.draft.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain("ALREADY sent to this person");
    expect(prompt).toContain("the exact take i already used on them");
    // The name of this test is "passes it to the verifier", so actually assert
    // that: the judge prompt must carry the prior replies, or deleting
    // priorRepliesToPerson from verifyCtx would leave this green.
    expect(verifyCalls.length).toBeGreaterThan(0);
    expect(String(verifyCalls[0])).toContain("the exact take i already used on them");
  });

  it("injects the feed-wide avoid-list, fetched once per tick for many leads", async () => {
    const runner = mkRunner();
    const getRecentPhrasings = vi.fn().mockResolvedValue(["a stock opener i keep reusing"]);
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [
        { ...mkLead(), id: "l1", external_id: "x1" },
        { ...mkLead(), id: "l2", external_id: "x2" },
        { ...mkLead(), id: "l3", external_id: "x3" },
      ] as never,
      runner: runner as never,
      kb: mkKb() as never,
      postOutbound: vi.fn().mockResolvedValue({ id: "a", approval_id: "a" }),
      markStatus: vi.fn().mockResolvedValue(undefined),
      getRecentPhrasings,
    });
    const prompt = runner.draft.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain("most recent replies across the whole feed");
    expect(prompt).toContain("a stock opener i keep reusing");
    // Fetched ONCE for the whole tick, not once per lead.
    expect(getRecentPhrasings).toHaveBeenCalledTimes(1);
  });

  it("omits both memory blocks when there is no history (byte-identical first contact)", async () => {
    const runner = mkRunner();
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [mkLead()] as never,
      runner: runner as never,
      kb: mkKb() as never,
      postOutbound: vi.fn().mockResolvedValue({ id: "a", approval_id: "a" }),
      markStatus: vi.fn().mockResolvedValue(undefined),
      getPriorReplies: async () => [],
      getRecentPhrasings: async () => [],
    });
    const prompt = runner.draft.mock.calls[0]![0].prompt as string;
    expect(prompt).not.toContain("ALREADY sent to this person");
    expect(prompt).not.toContain("most recent replies across the whole feed");
  });

  it("survives a memory-fetch failure without dropping the lead (fail-open)", async () => {
    const runner = mkRunner();
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [mkLead()] as never,
      runner: runner as never,
      kb: mkKb() as never,
      postOutbound,
      markStatus: vi.fn().mockResolvedValue(undefined),
      getPriorReplies: async () => {
        throw new Error("db down");
      },
      getRecentPhrasings: async () => {
        throw new Error("db down");
      },
    });
    expect(postOutbound).toHaveBeenCalled();
  });

  it("adds an OPENING MOVE only on a shape that leaves the opener free", async () => {
    const pick = async (shapeId: string) => {
      const runner = mkRunner();
      await runDrafterTick({
        log,
        instance: { id: "i", org_id: "o" } as never,
        claimedLeads: [mkLead()] as never,
        runner: runner as never,
        kb: mkKb() as never,
        postOutbound: vi.fn().mockResolvedValue({ id: "a", approval_id: "a" }),
        markStatus: vi.fn().mockResolvedValue(undefined),
        variety: {
          enabled: true,
          rng: () => 0,
          formVariantRotation: { next: () => X_FORM_VARIANTS.find((v) => v.id === shapeId)! },
        },
      });
      return runner.draft.mock.calls[0]![0].prompt as string;
    };
    // RUN_ON says what the reply IS, not how it starts → gets an opening move.
    expect(await pick("RUN_ON")).toContain("OPENING MOVE FOR THIS REPLY");
    // HOOK_THEN_LINE already prescribes the opener → a second directive would fight it.
    expect(await pick("HOOK_THEN_LINE")).not.toContain("OPENING MOVE FOR THIS REPLY");
    // MICRO is one to eight words → no opening distinct from the whole reply.
    expect(await pick("MICRO")).not.toContain("OPENING MOVE FOR THIS REPLY");
  });

  it("never asks Vega for an ANECDOTE opener (burned-props failure mode)", async () => {
    // Sweep the rng across the whole pool; ANECDOTE must never surface on X.
    for (let i = 0; i < 40; i++) {
      const runner = mkRunner();
      await runDrafterTick({
        log,
        instance: { id: "i", org_id: "o" } as never,
        claimedLeads: [mkLead()] as never,
        runner: runner as never,
        kb: mkKb() as never,
        postOutbound: vi.fn().mockResolvedValue({ id: "a", approval_id: "a" }),
        markStatus: vi.fn().mockResolvedValue(undefined),
        variety: {
          enabled: true,
          rng: () => i / 40,
          formVariantRotation: { next: () => X_FORM_VARIANTS.find((v) => v.id === "RUN_ON")! },
        },
      });
      const prompt = runner.draft.mock.calls[0]![0].prompt as string;
      expect(prompt).not.toContain("first-person observation from your own work");
    }
  });

  it("fails OPEN on an unscored lead — a classifier outage must not drop every lead", async () => {
    const runner = mkRunner();
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      // classifier_score null = the scoring call failed, NOT junk.
      claimedLeads: [{ ...mkLead(), classifier_score: null, priority: false }] as never,
      runner: runner as never,
      kb: mkKb() as never,
      postOutbound,
      markStatus: vi.fn().mockResolvedValue(undefined),
      qualityThreshold: 0.5,
    });
    expect(postOutbound).toHaveBeenCalled();
  });

  it("still drops a genuinely low-scored lead (the gate is not disabled)", async () => {
    const runner = mkRunner();
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    const markStatus = vi.fn().mockResolvedValue(undefined);
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [{ ...mkLead(), classifier_score: 0.1, priority: false }] as never,
      runner: runner as never,
      kb: mkKb() as never,
      postOutbound,
      markStatus,
      qualityThreshold: 0.5,
    });
    expect(postOutbound).not.toHaveBeenCalled();
    expect(markStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "skipped" }),
    );
  });

  it("routes a LIGHT lead to a short warm reply and never a bare question", async () => {
    const runner = mkRunner();
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [{ ...mkLead(), classifier_label: "light" }] as never,
      runner: runner as never,
      kb: mkKb() as never,
      postOutbound: vi.fn().mockResolvedValue({ id: "a", approval_id: "a" }),
      markStatus: vi.fn().mockResolvedValue(undefined),
      // r=0 would pick QUESTION_ONLY out of the unfiltered pool on some seeds;
      // the light lane must exclude it whatever the rng does.
      variety: { enabled: true, rng: () => 0.35 },
    });
    const prompt = runner.draft.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain("THIS POST IS A WIN, LAUNCH, OR MILESTONE");
    expect(prompt).not.toContain("The whole reply is ONE genuine, specific question");
  });

  it("never assigns QUESTION_ONLY on the light lane, across the whole rng range", async () => {
    for (let i = 0; i < 40; i++) {
      const runner = mkRunner();
      await runDrafterTick({
        log,
        instance: { id: "i", org_id: "o" } as never,
        claimedLeads: [{ ...mkLead(), classifier_label: "light" }] as never,
        runner: runner as never,
        kb: mkKb() as never,
        postOutbound: vi.fn().mockResolvedValue({ id: "a", approval_id: "a" }),
        markStatus: vi.fn().mockResolvedValue(undefined),
        variety: { enabled: true, rng: () => i / 40 },
      });
      const prompt = runner.draft.mock.calls[0]![0].prompt as string;
      expect(prompt).not.toContain("The whole reply is ONE genuine, specific question");
    }
  });

  it("leaves a non-light lead without the light directive (byte-identical)", async () => {
    const runner = mkRunner();
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [mkLead()] as never,
      runner: runner as never,
      kb: mkKb() as never,
      postOutbound: vi.fn().mockResolvedValue({ id: "a", approval_id: "a" }),
      markStatus: vi.fn().mockResolvedValue(undefined),
      variety: { enabled: true, rng: () => 0.35 },
    });
    const prompt = runner.draft.mock.calls[0]![0].prompt as string;
    expect(prompt).not.toContain("THIS POST IS A WIN, LAUNCH, OR MILESTONE");
  });

  it("injects NOTHING when variety is OFF (byte-identical to today)", async () => {
    const runner = mkRunner();
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [mkLead()] as never,
      runner: runner as never,
      kb: mkKb() as never,
      postOutbound: vi.fn().mockResolvedValue({ id: "a", approval_id: "a" }),
      markStatus: vi.fn().mockResolvedValue(undefined),
      variety: { enabled: false, rng: () => 0 },
    });
    const prompt = runner.draft.mock.calls[0]![0].prompt as string;
    expect(prompt).not.toContain("ASSIGNED REGISTER");
  });

  it("injects NOTHING when the variety arg is omitted entirely", async () => {
    const runner = mkRunner();
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [mkLead()] as never,
      runner: runner as never,
      kb: mkKb() as never,
      postOutbound: vi.fn().mockResolvedValue({ id: "a", approval_id: "a" }),
      markStatus: vi.fn().mockResolvedValue(undefined),
    });
    const prompt = runner.draft.mock.calls[0]![0].prompt as string;
    expect(prompt).not.toContain("ASSIGNED REGISTER");
  });
});

describe("poolForFaithfulLead (faithful multi-voice rotation)", () => {
  const row = (handle: string, i: number) =>
    ({ id: `${handle}-${i}`, account_handle: handle, body: `post ${i} by ${handle}` }) as never;
  const pool = [row("kaia", 1), row("kaia", 2), row("henry", 1)];

  it("returns the pool untouched for zero or one voice (single-pin unchanged)", async () => {
    const { poolForFaithfulLead } = await import("./drafter-tick.js");
    expect(poolForFaithfulLead(pool, [], "any post")).toBe(pool);
    expect(poolForFaithfulLead(pool, ["kaia"], "any post")).toBe(pool);
  });

  it("restricts the pool to ONE voice, deterministically per post text", async () => {
    const { poolForFaithfulLead } = await import("./drafter-tick.js");
    const out1 = poolForFaithfulLead(pool, ["kaia", "henry"], "some lead post");
    const out2 = poolForFaithfulLead(pool, ["kaia", "henry"], "some lead post");
    expect(out1).toEqual(out2); // stable per lead
    const handles = new Set(out1.map((r) => (r as { account_handle: string }).account_handle));
    expect(handles.size).toBe(1); // a single writer's corpus
  });

  it("rotates across different posts (both voices reachable)", async () => {
    const { poolForFaithfulLead } = await import("./drafter-tick.js");
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const out = poolForFaithfulLead(pool, ["kaia", "henry"], `post number ${i}`);
      seen.add((out[0] as { account_handle: string }).account_handle);
    }
    expect(seen).toEqual(new Set(["kaia", "henry"]));
  });

  it("a zero weight makes that voice unreachable (weights bias the draw)", async () => {
    const { poolForFaithfulLead } = await import("./drafter-tick.js");
    for (let i = 0; i < 40; i++) {
      const out = poolForFaithfulLead(pool, ["kaia", "henry"], `post number ${i}`, [1, 0]);
      expect((out[0] as { account_handle: string }).account_handle).toBe("kaia");
    }
  });

  it("fails open to the full pool when the chosen voice has no corpus", async () => {
    const { poolForFaithfulLead } = await import("./drafter-tick.js");
    // Only henry can be chosen (kaia weight 0) but the pool has no henry rows.
    const kaiaOnly = [row("kaia", 1), row("kaia", 2)];
    const out = poolForFaithfulLead(kaiaOnly, ["kaia", "henry"], "post", [0, 1]);
    expect(out).toBe(kaiaOnly);
  });
});

describe("runDmRequestTick — progressive DM ladder", () => {
  const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
  const dmLead = {
    id: "L1",
    external_id: "x1",
    payload: { text: "post text", url: "https://x.com/u/status/1" },
    author_handle: "u",
    author_id: "uid",
    status: "drafting",
    tier: null,
    classifier_label: null,
    classifier_score: null,
    priority: false,
  };
  const runnerWithDm = () => ({
    draft: vi.fn().mockResolvedValue({
      text: JSON.stringify({
        drafts: [{ angle: "empathetic", body: "r", char_count: 1 }],
        dm: { body: "a dm body", char_count: 9 },
      }),
      engine: "codex",
      model: "m",
    }),
  });

  const ladderSql = (sent: number, fail = false) => ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    // postgres tags build fragments lazily; only a complete query executes.
    if (!/\bfrom\s+noelle\.approvals\b/i.test(text)) return { strings, values };
    if (fail) return Promise.reject(new Error("db down"));
    return Promise.resolve(/count\(\*\)/i.test(text) ? [{ n: sent }] : []);
  }) as never;

  // sentCount -> the rung directive that must appear, and whether a call is allowed.
  const cases: Array<[number, string, boolean]> = [
    [0, "early, light first touch", false],
    [1, "one layer deeper", false],
    [2, "grounded overlap", false],
    [5, "low-pressure, easy-to-decline quick call", true],
  ];

  for (const [sent, needle, callAllowed] of cases) {
    it(`sends rung ${sent === 0 ? 1 : Math.min(sent + 1, 4)} after ${sent} prior DMs`, async () => {
      const runner = runnerWithDm();
      const sql = ladderSql(sent);
      await runDmRequestTick({
        log,
        instance: { id: "i", org_id: "o" } as never,
        claimedLeads: [dmLead] as never,
        runner: runner as never,
        kb: { search: vi.fn().mockResolvedValue([]) } as never,
        postOutbound: vi.fn().mockResolvedValue({ id: "a", approval_id: "a" }),
        sql,
      });
      const prompt = runner.draft.mock.calls[0]![0].prompt as string;
      expect(prompt).toContain("DM RELATIONSHIP STAGE");
      expect(prompt).toContain(needle);
      if (callAllowed) {
        expect(prompt).toContain("only rung that may propose a call");
      } else {
        expect(prompt).toContain("Do NOT propose a call");
      }
    });
  }

  it("starts at rung 1 when the ladder query fails (never cold-invites)", async () => {
    const runner = runnerWithDm();
    const sql = ladderSql(0, true);
    await runDmRequestTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [dmLead] as never,
      runner: runner as never,
      kb: { search: vi.fn().mockResolvedValue([]) } as never,
      postOutbound: vi.fn().mockResolvedValue({ id: "a", approval_id: "a" }),
      sql,
    });
    const prompt = runner.draft.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain("early, light first touch");
    expect(prompt).toContain("Do NOT propose a call");
  });

  it("omits the ladder entirely with no sql handle (byte-identical fallback)", async () => {
    const runner = runnerWithDm();
    await runDmRequestTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [dmLead] as never,
      runner: runner as never,
      kb: { search: vi.fn().mockResolvedValue([]) } as never,
      postOutbound: vi.fn().mockResolvedValue({ id: "a", approval_id: "a" }),
    });
    const prompt = runner.draft.mock.calls[0]![0].prompt as string;
    // Still rung 1 (pickRung(0)) — the ladder is always on, just unfed.
    expect(prompt).toContain("early, light first touch");
  });
});

describe("decideOpus — engagement-tiered escalation", () => {
  const base = { likesThreshold: 150, repliesThreshold: 40 };

  it("escalates on real like traction", () => {
    expect(decideOpus({ ...base, likes: 200, replies: 0, commentBait: false }).useOpus).toBe(true);
    expect(decideOpus({ ...base, likes: 150, replies: 0, commentBait: false }).useOpus).toBe(false);
  });

  it("escalates on real reply traction", () => {
    expect(decideOpus({ ...base, likes: 0, replies: 41, commentBait: false }).useOpus).toBe(true);
  });

  it("IGNORES the reply count on an engagement-bait post", () => {
    // The whole point: a comment-farming CTA inflates replies with junk, so it
    // must not buy itself the expensive model.
    expect(decideOpus({ ...base, likes: 0, replies: 5000, commentBait: true }).useOpus).toBe(false);
  });

  it("still escalates a bait post on LIKES (likes stay reliable)", () => {
    expect(decideOpus({ ...base, likes: 900, replies: 5000, commentBait: true }).useOpus).toBe(true);
  });

  it("treats missing / non-finite engagement as zero and never escalates", () => {
    for (const v of [null, undefined, Number.NaN]) {
      expect(decideOpus({ ...base, likes: v, replies: v, commentBait: false }).useOpus).toBe(false);
    }
  });
});

describe("writer and verifier factual evidence parity", () => {
  const fact = "Oriole maps Atlas dependency graphs";
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const brand = {
    persona: { name: "Ari", bio: "Builds Oriole" },
    product: { name: "Oriole", description: fact },
    qa: [{ q: "Which manifests?", a: "Atlas manifests" }],
    reply_style: { voice_notes: "Style-only Vega" },
  };

  async function run(options: {
    brand?: typeof brand; thread?: boolean; retries?: number; siblings?: boolean; directives?: boolean;
  }) {
    const draftBodies = options.siblings ? [fact, "Oriole supports Atlas manifests"] : [fact];
    const runner = { draft: vi.fn().mockResolvedValue({
      text: JSON.stringify({ drafts: draftBodies.map((body) => ({ angle: "technical", body })) }),
      engine: "codex", model: "fixture",
    }) };
    let reviews = 0;
    const judge = vi.fn(async (_system: string, prompt: string) => {
      reviews++;
      const evidence = prompt.split("DRAFTS TO GRADE")[0]!;
      const supported = evidence.includes(fact);
      const firstRepair = options.retries && reviews === 1;
      return JSON.stringify({ voice: firstRepair ? 0.3 : 0.9, grounding: supported ? 0.9 : 0.2, relevance: 0.9,
        reasons: supported ? [] : ["Unsupported Oriole/Atlas claim"], fix: supported ? null : "Remove unsupported claim" });
    });
    const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
    await runDrafterTick({
      log: log as never,
      instance: {
        id: "i", org_id: "o", ...(options.brand ? { brand_config: options.brand } : {}),
        ...(options.directives ? { objective: "Objective-only Lyra" } : {}),
      },
      claimedLeads: [{
        id: "L", external_id: "123", status: "drafting", priority: true,
        author_handle: "author", author_id: "uid", tier: null, classifier_label: null, classifier_score: null,
        payload: { text: "How do you inspect dependency graphs?", url: "https://x.com/author/status/123",
          ...(options.directives ? { reply_request: {
            request_key: "manual-evidence", instructions: "Request-only Vega", force_human_review: true,
          } } : {}),
          ...(options.thread ? { source: "notification", conversation: {
            root_post_text: "Does Oriole map Atlas?", our_reply_text: fact,
          } } : {}),
        },
      }],
      runner: runner as never,
      kb: { search: vi.fn().mockResolvedValue([{ snippet: "Plain spoken", score: 8, filePath: "voice.md", startLine: 1, endLine: 1 }]) } as never,
      postOutbound, markStatus: vi.fn(), patternRules: [],
      verify: { enabled: true, retries: options.retries ?? 0, makeCalls: () => [judge] },
    });
    expect(postOutbound).toHaveBeenCalledTimes(1);
    return { runner, judge, outbound: postOutbound.mock.calls[0]![0] };
  }

  it("supplies configured identity/product/Q&A facts without voice or operator directives", async () => {
    const result = await run({ brand });
    const evidence = result.judge.mock.calls[0]![1].split("DRAFTS TO GRADE")[0]!;
    expect(result.runner.draft.mock.calls[0]![0].system).toContain(fact);
    expect(evidence).toContain(fact);
    expect(evidence).toContain("Builds Oriole");
    expect(evidence).toContain("Atlas manifests");
