import { describe, expect, it, vi } from "vitest";
import { runDmRequestTick, runDrafterTick } from "./drafter-tick.js";

async function requestDm(bodies: string[]) {
  const reply = (body: string) => ({ text: JSON.stringify({ drafts: [{ angle: "empathetic", body: "skill issue" }], dm: { body } }), engine: "codex", model: "test" });
  const runner = { draft: vi.fn().mockResolvedValue(reply(bodies.at(-1)!)) };
  for (const body of bodies) runner.draft.mockResolvedValueOnce(reply(body));
  const postOutbound = vi.fn().mockResolvedValue({ id: "draft", approval_id: "approval" });
  const count = await runDmRequestTick({
    instance: { id: "instance", org_id: "org" },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    claimedLeads: [{
      id: "lead", external_id: "post", author_handle: "peer", author_id: "peer", status: "drafting",
      tier: null, classifier_label: null, classifier_score: null, priority: false,
      payload: { text: "five trial reels per day on a VPS", posted_at: new Date().toISOString() },
    }],
    runner: runner as never, kb: { search: vi.fn().mockResolvedValue([]) } as never, postOutbound,
  });
  return { runner, postOutbound, count };
}

describe("X requested DM voice check", () => {
  const stiff = "Hey, the part I keep thinking about is measurement. Curious how you judge the reels?";

  it("rewrites stock outreach framing before an on-demand DM can reach approvals", async () => {
    const natural = "hey, five reels a day on that VPS lol, how do you pick the one to keep?";
    const result = await requestDm([stiff, natural]);
    expect(result.runner.draft).toHaveBeenCalledTimes(2);
    expect(result.postOutbound.mock.calls[0]![0].drafts[0].body).toBe(natural);
    expect(result.postOutbound.mock.calls[0]![0].drafts[0].dmVoiceCheck).toEqual(expect.objectContaining({ pass: true, attempts: 1 }));
  });

  it("does not queue a DM that still uses stock framing after its one rewrite", async () => {
    const result = await requestDm([stiff]);
    expect(result.runner.draft).toHaveBeenCalledTimes(2);
    expect(result.postOutbound).not.toHaveBeenCalled();
    expect(result.count).toBe(0);
  });

  it("keeps a natural brief message without another model call", async () => {
    const result = await requestDm(["hey, that poor VPS lol"]);
    expect(result.runner.draft).toHaveBeenCalledTimes(1);
    expect(result.postOutbound.mock.calls[0]![0].drafts[0].body).toBe("hey, that poor VPS lol");
  });

  it("drops a rejected companion DM while keeping the good public reply", async () => {
    const runner = { draft: vi.fn().mockResolvedValue({
      text: JSON.stringify({ drafts: [{ angle: "empathetic", body: "skill issue" }], dm: { body: stiff } }),
      engine: "codex", model: "test",
    }) };
    const postOutbound = vi.fn().mockResolvedValue({ id: "draft", approval_id: "approval" });
    await runDrafterTick({
      instance: { id: "instance", org_id: "org", dm_autodraft_enabled: true },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      claimedLeads: [{
        id: "lead", external_id: "post", author_handle: "peer", author_id: "peer", status: "drafting",
        tier: null, classifier_label: null, classifier_score: null, priority: false,
        payload: { text: "five trial reels per day on a VPS" },
      }],
      runner: runner as never,
      kb: { search: vi.fn().mockResolvedValue([{ snippet: "i ship small", score: 8, filePath: "voice.md" }]) } as never,
      postOutbound, markStatus: vi.fn(),
    });
    expect(runner.draft).toHaveBeenCalledTimes(2);
    expect(postOutbound.mock.calls[0]![0].drafts).toEqual([expect.objectContaining({ kind: "reply", body: "skill issue" })]);
  });
});
