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
