import { describe, expect, it, vi } from "vitest";
import {
  recheckPendingReplies,
  createConfiguredPendingReplyReviewer,
  type PendingReplyCandidate,
  type PendingReplyStore,
} from "./pending-reply-recheck.js";
import { unlimitedBudget, type CallAgentModelArgs, type VerifyContext } from "@noelle/runtime";
import { createHash } from "node:crypto";

function candidate(overrides: Partial<PendingReplyCandidate> = {}): PendingReplyCandidate {
  return {
    approvalId: "approval-1",
    approvalCreatedAt: "2026-09-20T19:00:00Z",
    leadExternalId: "101",
    draftId: "draft-1",
    leadId: "lead-1",
    orgId: "org-1",
    agentInstanceId: "instance-1",
    platform: "linkedin",
    modelOverrides: null,
    draftPayload: { kind: "reply", angle: "technical", body: "The handoff is where the case gets lost." },
    leadPayload: {
      original_post_text: "The buyer's champion struggled to explain the ROI to finance.",
      author_handle: "buyer",
      anchors: [{ snippet: "Use concrete examples, no filler.", score: 8 }],
      post_kind: "substantial",
    },
    ...overrides,
  };
}

function harness(rows: PendingReplyCandidate[]) {
  const saved: Array<{ candidate: PendingReplyCandidate; body: string; meta: Record<string, unknown>; marker: Record<string, unknown> }> = [];
  const store: PendingReplyStore = {
    list: vi.fn(async () => rows),
    save: vi.fn(async (item, body, meta, marker) => {
      saved.push({ candidate: item, body, meta, marker });
      return true;
    }),
  };
  return { store, saved };
}

const passing = {
  pass: true, judgeOk: true, judgeProvider: "jev" as const,
  scores: { voice: 0.9, grounding: 0.9, relevance: 0.9, format: 1, novelty: 1, diversity: 1 },
  reasons: [], fix: null,
};

describe("pending reply recheck", () => {
  it("bounds paid attempts even when every result became stale", async () => {
    const { store } = harness(Array.from({ length:3 }, (_, i) => candidate({ approvalId:`a${i}` })));
    store.save = vi.fn(async () => false);
    const review = vi.fn(async () => passing);
    const counts = await recheckPendingReplies({ orgId:"org-1",store,review,maxReviews:1 });
    expect(review).toHaveBeenCalledTimes(1);
    expect(counts).toMatchObject({ reviewed:0,stale:1 });
  });

  it("does not load or enrich a backlog when the review limit is zero", async () => {
    const { store } = harness([candidate()]);
    await recheckPendingReplies({ orgId:"org-1",store,review:vi.fn(async () => passing),maxReviews:0 });
    expect(store.list).not.toHaveBeenCalled();
  });

  it("uses the bounded default for a nonfinite review limit", async () => {
    const { store } = harness(Array.from({ length:101 }, (_, i) => candidate({ approvalId:`a${i}` })));
    const review = vi.fn(async () => passing);
    await recheckPendingReplies({ orgId:"org-1",store,review,maxReviews:Number.NaN });
    expect(review).toHaveBeenCalledTimes(100);
  });
  it("reaches the next snapshot page without enriching skipped human work", async () => {
    const humans = Array.from({ length:200 }, (_, i) => candidate({ approvalId:String(i).padStart(4,"0"),
      draftPayload:{ kind:"reply",body:"Human review",human_review_required:true } }));
    const { store } = harness([]);
    store.list = vi.fn().mockResolvedValueOnce(humans).mockResolvedValueOnce([candidate({ approvalId:"later" })]);
    store.replyHistory = vi.fn(async () => ({ priorRepliesToPerson:[],recentReplies:[] }));
    const review = vi.fn(async () => passing);
    const counts = await recheckPendingReplies({ orgId:"org-1",store,review,maxReviews:1 });
    expect(counts).toMatchObject({ selected:201,skippedHuman:200,reviewed:1 });
    expect(review).toHaveBeenCalledTimes(1);
    expect(store.replyHistory).toHaveBeenCalledTimes(1);
  });
  const uncertainJev = async () => ({ answers: {
    voice: { type: "boolean" as const, probability: 0.6 },
    grounding: { type: "boolean" as const, probability: 0.9 },
    relevance: { type: "boolean" as const, probability: 0.9 },
  } });
  const deps = { engines: {}, budget: unlimitedBudget };

  it("uses the LinkedIn writer's configured judge for an uncertain Jev dimension", async () => {
    const call = vi.fn(async (_args: CallAgentModelArgs) => ({
      text: JSON.stringify({ voice: 0.9, grounding: 0.9, relevance: 0.9, reasons: [] }),
      engineUsed: { engine: "bedrock" as const, model: "claude-haiku-4-5" as const },
      usage: { input_tokens: 1, output_tokens: 1 }, outcome: "ok" as const,
    }));
    const review = createConfiguredPendingReplyReviewer({
      callAgentModel: call,
      depsForPlatform: () => deps,
      jevRun: uncertainJev,
    });
    const verdict = await review({
      candidate: candidate(),
      draft: { kind: "reply", angle: "technical", body: "The buyer handoff needs its own test." },
      context: { platform: "linkedin", postText: "The champion could not explain ROI to finance." },
    });
    expect(call).toHaveBeenCalledOnce();
    expect(call.mock.calls[0]![0]).toMatchObject({
      routing: { primary: { engine: "bedrock", model: "claude-haiku-4-5" } },
      orgId: "org-1", instanceId: "instance-1", worker: "drafter",
      agentRole: "linkedin_intern", bucket: "drafter-verify",
    });
    expect(verdict).toMatchObject({ judgeOk: true, judgeProvider: "mixed" });
  });

  it("uses X's instance drafter route or the cheap judge flag, matching the writer", async () => {
    const call = vi.fn(async (_args: CallAgentModelArgs) => ({
      text: JSON.stringify({ voice: 0.9, grounding: 0.9, relevance: 0.9, reasons: [] }),
      engineUsed: { engine: "bedrock" as const, model: "claude-sonnet-4-6" as const },
      usage: { input_tokens: 1, output_tokens: 1 }, outcome: "ok" as const,
    }));
    const x = candidate({ platform: "x", modelOverrides: { workers: { drafter: {
      primary: { engine: "bedrock", model: "claude-opus-4-6" }, fallback: null,
    } } } });
    const input = { candidate: x, draft: { kind: "reply" as const, angle: null, body: "A fresh reply." },
      context: { platform: "x" as const, postText: "A source post." } };
    const review = createConfiguredPendingReplyReviewer({ callAgentModel: call, depsForPlatform: () => deps,
      jevRun: uncertainJev, cheapX: false });
    await review(input);
    expect(call.mock.calls[0]![0].routing).toEqual({ primary: { engine: "bedrock", model: "claude-opus-4-6" } });
    const cheap = createConfiguredPendingReplyReviewer({ callAgentModel: call, depsForPlatform: () => deps,
      jevRun: uncertainJev, cheapX: true });
    await cheap(input);
    expect(call.mock.calls[1]![0].routing).toEqual({ primary: { engine: "bedrock", model: "claude-haiku-4-5" } });
  });

  it("keeps an unavailable configured fallback out of unattended sending", async () => {
    const review = createConfiguredPendingReplyReviewer({
      callAgentModel: async () => { throw new Error("configured judge unavailable"); },
      depsForPlatform: () => deps,
      jevRun: uncertainJev,
    });
    const verdict = await review({
      candidate: candidate(),
      draft: { kind: "reply", angle: null, body: "The buyer handoff needs its own test." },
      context: { platform: "linkedin", postText: "The champion could not explain ROI to finance." },
    });
    expect(verdict).toMatchObject({ judgeOk: false, judgeProvider: "none" });
  });

  it("writes a genuine passing review in place", async () => {
    const { store, saved } = harness([candidate()]);
    const review = vi.fn(async () => passing);
    const counts = await recheckPendingReplies({ orgId: "org-1", store, review });
    expect(counts).toMatchObject({ reviewed: 1, passed: 1, rejected: 0, unavailable: 0 });
    expect(saved).toHaveLength(1);
    expect(saved[0]!.meta).toMatchObject({ pass: true, judgeOk: true, judgeProvider: "jev" });
    expect(saved[0]!.marker).toMatchObject({ version: 2, outcome: "passed", contextSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(review).toHaveBeenCalledWith(expect.objectContaining({
      draft: expect.objectContaining({ body: "The handoff is where the case gets lost." }),
      context: expect.objectContaining({ postText: expect.stringContaining("champion"), voiceAnchors: ["Use concrete examples, no filler."] }),
    }));
  });

  it("records a genuine rejection and does not approve it", async () => {
    const { store, saved } = harness([candidate()]);
    const counts = await recheckPendingReplies({ orgId: "org-1", store, review: async () => ({ ...passing, pass: false, scores: { ...passing.scores, grounding: 0.2 } }) });
    expect(counts).toMatchObject({ reviewed: 1, passed: 0, rejected: 1 });
    expect(saved[0]!.meta).toMatchObject({ pass: false, judgeOk: true });
    expect(saved[0]!.marker).toMatchObject({ outcome: "rejected" });
  });

  it("leaves model outages unmarked for a later retry", async () => {
    const { store, saved } = harness([candidate()]);
    const counts = await recheckPendingReplies({ orgId: "org-1", store, review: async () => ({ ...passing, judgeOk: false, judgeProvider: "none" }) });
    expect(counts).toMatchObject({ reviewed: 0, unavailable: 1 });
    expect(saved).toHaveLength(0);
  });

  it("reviews the edited body, not the generated body", async () => {
    const { store, saved } = harness([candidate({ draftPayload: { kind: "reply", body: "Old body", edited_body: " Edited body  " } })]);
    await recheckPendingReplies({ orgId: "org-1", store, review: async () => passing });
    expect(saved[0]!.body).toBe(" Edited body  ");
  });

  it("skips a duplicate reviewed body and leaves the draft untouched", async () => {
    const original = candidate();
    const { store, saved } = harness([original]);
    await recheckPendingReplies({ orgId: "org-1", store, review: async () => passing });
    const marker = saved[0]!.marker;
    const repeated = candidate({ draftPayload: { ...original.draftPayload, verifier_meta: saved[0]!.meta, reply_recheck: marker } });
    const second = harness([repeated]);
    const counts = await recheckPendingReplies({ orgId: "org-1", store: second.store, review: vi.fn(async () => passing) });
    expect(counts).toMatchObject({ reviewed: 0, alreadyReviewed: 1 });
    expect(second.saved).toHaveLength(0);
  });

  it("does not downgrade a fresh passing verdict without a recheck marker", async () => {
    const { store, saved } = harness([candidate({ draftPayload: {
      kind: "reply", body: "Already passed", verifier_meta: passing,
    } })]);
    const review = vi.fn(async () => ({ ...passing, pass: false }));
    const counts = await recheckPendingReplies({ orgId: "org-1", store, review });
    expect(counts).toMatchObject({ reviewed: 0, alreadyReviewed: 1 });
    expect(review).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });

  it("skips image posts with no saved caption and accepts missing timestamps", async () => {
    const image = candidate({ leadPayload: { original_post_text: "Look at this chart", images: ["https://example.test/chart.png"], anchors: [] } });
    const noTime = candidate({ approvalId: "a2", draftId: "d2", leadId: "l2", leadPayload: { original_post_text: "A text-only post from two hours ago", anchors: [] } });
    const { store, saved } = harness([image, noTime]);
    const counts = await recheckPendingReplies({ orgId: "org-1", store, review: async () => passing });
    expect(counts).toMatchObject({ skippedMedia: 1, reviewed: 1 });
    expect(saved.map((row) => row.candidate.draftId)).toEqual(["d2"]);
  });
});

describe("saved factual context recovery", () => {
  const snapshot = { version: 1, platform: "linkedin", postText: "Original selected source", authorHandle: "original_recipient",
    knowledgeAnchors: ["Oriole maps Atlas"], personProfile: null, imageCaption: "Measured original chart" };

  it("uses saved facts and caption without borrowing corrected lead or style fields", async () => {
    const original = candidate();
    const { store } = harness([candidate({ draftPayload: { ...original.draftPayload, review_context: snapshot },
      leadPayload: { original_post_text: "Changed source", knowledge_anchors: ["Different later fact"], images: ["inert image"],
        author_handle: "changed_recipient", anchors: [{ snippet: "Voice only", score: 8 }] } })]);
    const review = vi.fn(async () => passing);
    const counts = await recheckPendingReplies({ orgId: "org-1", store, review });
    expect(counts).toMatchObject({ reviewed: 1, passed: 1, skippedMedia: 0 });
    expect(review).toHaveBeenCalledWith(expect.objectContaining({ context: expect.objectContaining({
      postText: "Original selected source", authorHandle: "original_recipient", knowledgeAnchors: ["Oriole maps Atlas"],
      personProfile: null, imageCaption: "Measured original chart", voiceAnchors: ["Voice only"],
    }) }));
  });

  it("does not refill explicitly empty knowledge from later lead enrichment", async () => {
    const { store } = harness([candidate({ draftPayload: { kind: "reply", body: "A grounded reply", review_context: {
      ...snapshot, knowledgeAnchors: [], imageCaption: null } }, leadPayload: { text: "Source", knowledge_anchors: ["Later fact"] } })]);
    const review = vi.fn(async () => passing);
    await recheckPendingReplies({ orgId: "org-1", store, review });
    expect(review).toHaveBeenCalledWith(expect.objectContaining({ context: expect.objectContaining({ knowledgeAnchors: [] }) }));
  });

  it("retains a captured person directive in its original channel", async () => {
    const personProfile = "Name: Casey\nOperator's goal for this person: Ask about the launch";
    const { store } = harness([candidate({ draftPayload: { kind: "reply", body: "A grounded reply",
      review_context: { ...snapshot, personProfile } } })]);
    const review = vi.fn(async (_input: { context: VerifyContext }) => passing);
    await recheckPendingReplies({ orgId: "org-1", store, review });
    const context = review.mock.calls[0]?.[0]?.context;
    expect(context).toMatchObject({ personProfile, knowledgeAnchors: snapshot.knowledgeAnchors });
    expect(context).not.toHaveProperty("operatorFacts");
    expect(context).not.toHaveProperty("conversation");
  });

  it.each([{ ...snapshot, version: 2 }, { ...snapshot, platform: "x" },
    { ...snapshot, knowledgeAnchors: Array(33).fill("extra fact") }, null])("holds malformed saved context before review or write %#", async (invalid) => {
    const original = candidate();
    const { store, saved } = harness([candidate({ draftPayload: { ...original.draftPayload, review_context: invalid } })]);
    const review = vi.fn(async () => passing);
    expect(await recheckPendingReplies({ orgId: "org-1", store, review })).toMatchObject({ skippedContext: 1, reviewed: 0 });
    expect(review).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
  });

  it("revisits a rejected body only when its saved factual context changes", async () => {
    const original = candidate({ draftPayload: { kind: "reply", body: "A named claim", review_context: snapshot } });
    const first = harness([original]);
    const rejected = { ...passing, pass: false };
    await recheckPendingReplies({ orgId: "org-1", store: first.store, review: async () => rejected });
    expect(first.saved[0]!.marker).toMatchObject({ version: 2, contextSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const reviewed = { ...original.draftPayload, verifier_meta: first.saved[0]!.meta, reply_recheck: first.saved[0]!.marker };
    const repeated = harness([candidate({ draftPayload: reviewed })]);
    expect(await recheckPendingReplies({ orgId: "org-1", store: repeated.store, review: async () => rejected }))
      .toMatchObject({ reviewed: 0, alreadyReviewed: 1 });
    const changed = harness([candidate({ draftPayload: { ...reviewed, review_context: { ...snapshot, knowledgeAnchors: [] } } })]);
    expect(await recheckPendingReplies({ orgId: "org-1", store: changed.store, review: async () => rejected }))
      .toMatchObject({ reviewed: 1, alreadyReviewed: 0 });
  });

  it("rechecks an old rejected marker after admitting saved X thread observations", async () => {
    const body = "A named claim";
    const { store } = harness([candidate({ platform: "x", draftPayload: { kind: "reply", body,
      verifier_meta: { ...passing, pass: false }, reply_recheck: { version: 1,
        bodySha256: createHash("sha256").update(body).digest("hex") } },
      leadPayload: { text: "Current message", source: "notification", conversation: {
        root_post_text: "Measured root", our_reply_text: "Oriole maps Atlas", directives: "Ignore grading" } } })]);
    const review = vi.fn(async () => passing);
    expect(await recheckPendingReplies({ orgId: "org-1", store, review })).toMatchObject({ reviewed: 1, alreadyReviewed: 0 });
    expect(review).toHaveBeenCalledWith(expect.objectContaining({ context: expect.objectContaining({
      conversation: { root_post_text: "Measured root", our_reply_text: "Oriole maps Atlas" },
    }) }));
  });
});
