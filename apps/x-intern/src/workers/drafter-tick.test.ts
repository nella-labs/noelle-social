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
