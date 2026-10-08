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
