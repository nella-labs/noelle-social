import { describe, expect, it, vi } from "vitest";
import { runDrafterTick } from "./drafter-tick.js";

async function draftWithVoice(args: { voice: number; floor?: number; payload?: Record<string, unknown> }) {
  const body = "skill issue";
  const runner = { draft: vi.fn().mockResolvedValue({
    text: JSON.stringify({ drafts: [{ angle: "empathetic", body }] }), engine: "codex", model: "test",
  }) };
  const postOutbound = vi.fn().mockResolvedValue({ id: "draft", approval_id: "approval" });
  const markStatus = vi.fn().mockResolvedValue(undefined);
  const judge = vi.fn().mockResolvedValue(JSON.stringify({
    voice: args.voice, grounding: 0.9, relevance: 0.9, reasons: [], fix: "write naturally",
  }));
  const processed = await runDrafterTick({
    instance: { id: "instance", org_id: "org" },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    claimedLeads: [{
      id: "lead", external_id: "post", author_handle: "peer", author_id: "peer", status: "drafting",
      tier: null, classifier_label: null, classifier_score: null, priority: false,
      payload: { text: "why does rust rebuild the entire world after one typo?", ...args.payload },
    }],
    runner: runner as never,
    kb: { search: vi.fn().mockResolvedValue([{ snippet: "i ship small", score: 8, filePath: "voice.md" }]) } as never,
    postOutbound, markStatus,
    verify: { enabled: true, retries: 2, voiceFloor: args.floor ?? 0.65, makeCalls: () => [judge] },
  });
  return { body, runner, postOutbound, markStatus, processed };
}

describe("X voice floor", () => {
  it("rejects an ordinary low-voice reply after the bounded retries", async () => {
    const result = await draftWithVoice({ voice: 0.3 });
    expect(result.runner.draft).toHaveBeenCalledTimes(3);
    expect(result.postOutbound).not.toHaveBeenCalled();
    expect(result.processed).toBe(0);
    expect(result.markStatus).toHaveBeenCalledWith(expect.objectContaining({
      status: "skipped", meta: expect.objectContaining({ skip_reason: "low-voice", voice: 0.3 }),
    }));
  });

  it("keeps a high-voice two-word reaction unchanged", async () => {
    const result = await draftWithVoice({ voice: 0.9 });
    expect(result.runner.draft).toHaveBeenCalledTimes(1);
    expect(result.postOutbound.mock.calls[0]![0].drafts[0].body).toBe(result.body);
  });

  it.each([
    { source: "notification" },
    { reply_request: { request_key: "manual-voice", instructions: "keep it brief", force_human_review: true } },
  ])("preserves an explicitly requested or conversational reply: %j", async (payload) => {
    const result = await draftWithVoice({ voice: 0.3, payload });
    expect(result.postOutbound).toHaveBeenCalledTimes(1);
    expect(result.postOutbound.mock.calls[0]![0].verifierMeta.scores.voice).toBe(0.3);
  });

  it("allows the operator to disable the voice floor", async () => {
    const result = await draftWithVoice({ voice: 0.3, floor: 0 });
    expect(result.postOutbound).toHaveBeenCalledTimes(1);
  });
});
