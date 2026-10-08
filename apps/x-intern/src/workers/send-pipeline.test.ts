import { describe, expect, it, vi } from "vitest";
import { runDrafterTick } from "./drafter-tick.js";
import { runSendTick, type PendingDraft } from "./send-tick.js";
import type { OutboundIn } from "@noelle/contracts";

/**
 * End-to-end loop, in-memory:
 *
 *   1. Drafter sees one classified lead
 *   2. Nella returns strong anchors (so the relevance gate passes — same default
 *      threshold the drafter-relevance-tuning plan introduces)
 *   3. Codex runner returns three valid JSON drafts
 *   4. Drafter calls `postOutbound`. The mock writes 1 lead + 3 drafts + 3
 *      pending approvals into an in-memory store, mirroring api-vm/outbound.
 *   5. Reviewer "approves" the empathetic angle → flips that approval to
 *      'sent' and the two siblings to 'skipped' (mirroring api-vm/drafts).
 *   6. Send-worker claim query: select drafts joined to approvals where
 *      a.status='sent' AND d.sent_external_id IS NULL. We project that
 *      manually from the store.
 *   7. runSendTick posts via a stubbed XClient that returns a fake tweet id.
 *   8. markSent stamps sent_external_id + sent_url onto the in-memory draft.
 *   9. Assert: exactly one draft has sent_external_id; the other two drafts
 *      are still pending-from-X (sent_external_id IS NULL) but their
 *      approvals are 'skipped' so they will never be re-claimed.
 */

interface FakeApproval {
  id: string;
  draft_id: string;
  lead_id: string;
  status: "pending" | "sent" | "skipped" | "errored";
  skip_reason: string | null;
}
interface FakeDraft {
  id: string;
  lead_id: string;
  angle: "empathetic" | "technical" | "contrarian";
  body: string;
  sent_external_id: string | null;
  sent_url: string | null;
}

describe("approval → send pipeline (end-to-end, in-memory)", () => {
  it("drafter writes 3 approvals; approving one sends only that draft and skips the others", async () => {
    const store = {
      approvals: [] as FakeApproval[],
      drafts: [] as FakeDraft[],
    };
    const lead = {
      id: "lead-1",
      external_id: "post-xyz",
      payload: { text: "we keep losing context across long agent sessions" },
      author_handle: "alice",
      author_id: "1",
      status: "drafting" as const,
      tier: "T2" as const,
      classifier_label: "ai-agents" as const,
      classifier_score: 0.78,
    };

    // ---- Drafter side (mocked Nella + runner) -------------------------
    const nella = {
      search: vi.fn().mockResolvedValue([
        { path: "voice.md", snippet: "ship daily", score: 8.0, filePath: "voice.md", startLine: 1, endLine: 1, highlights: [] },
      ]),
    };
    const runner = {
      draft: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          drafts: [
            { angle: "empathetic", body: "Yes, agents forget. We hit the same wall daily — only ships when we externalise context.", char_count: 96 },
            { angle: "technical", body: "Root cause: sliding-window summaries lose mid-tail facts. Fix is structured external memory + retrieval.", char_count: 104 },
            { angle: "contrarian", body: "Curious: is it really 'long sessions' or just bad re-retrieval after model reset? Different fix.", char_count: 96 },
          ],
        }),
        engine: "codex",
        model: "gpt-5",
      }),
    };

    // Fake `postOutbound` mirrors apps/api-vm/src/routes/outbound.ts —
    // one lead row, three draft rows, three pending approval rows.
    const postOutbound = vi
      .fn(async (body: OutboundIn) => {
        const leadStoreId = `dbl-${body.leadId}`;
        body.drafts.forEach((d, i) => {
          store.drafts.push({
            id: d.id,
            lead_id: leadStoreId,
            angle: d.angle as FakeDraft["angle"],
            body: d.body,
            sent_external_id: null,
            sent_url: null,
          });
          store.approvals.push({
            id: `appr-${d.id}`,
            draft_id: d.id,
            lead_id: leadStoreId,
            status: "pending",
            skip_reason: null,
          });
          // Suppress the "i is unused" warning without changing the lint config.
          void i;
        });
        return { id: store.approvals[0]!.id, approval_id: store.approvals[0]!.id };
      });
    const markStatus = vi.fn().mockResolvedValue(undefined);

    await runDrafterTick({
      log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead as never],
      runner: runner as never,
      kb: nella as never,
      postOutbound,
      markStatus,
    });

    // Sanity: outbound mock fired with 3 drafts; store has 3 approvals + 3 drafts.
    expect(postOutbound).toHaveBeenCalledTimes(1);
    expect(store.drafts).toHaveLength(3);
    expect(store.approvals).toHaveLength(3);
    expect(store.approvals.every((a) => a.status === "pending")).toBe(true);

    // ---- Reviewer side (mirrors api-vm /api/drafts/:id/send) ----------
    // The operator sends the empathetic angle.
    const empatheticDraft = store.drafts.find((d) => d.angle === "empathetic")!;
    const empatheticApproval = store.approvals.find(
      (a) => a.draft_id === empatheticDraft.id,
    )!;

    // Flip THIS approval to sent.
    empatheticApproval.status = "sent";

    // Flip siblings to skipped(sibling-angle-sent) — same lead_id, other ids.
    for (const a of store.approvals) {
      if (a.lead_id === empatheticApproval.lead_id && a.id !== empatheticApproval.id && a.status === "pending") {
        a.status = "skipped";
        a.skip_reason = "sibling-angle-sent";
      }
    }

    // ---- Send worker claim query (projected from the store) -----------
    const pending: PendingDraft[] = store.approvals
      .filter((a) => a.status === "sent")
      .map((a) => {
        const draft = store.drafts.find((d) => d.id === a.draft_id)!;
        return {
          draft_id: draft.id,
          body: draft.body,
          in_reply_to_id: lead.external_id,
          lead_id: a.lead_id,
        };
      })
      .filter(({ draft_id }) =>
        store.drafts.find((d) => d.id === draft_id)?.sent_external_id == null,
      );

    expect(pending).toHaveLength(1);
    expect(pending[0]!.draft_id).toBe(empatheticDraft.id);

    // ---- Send tick with a stubbed XClient -----------------------------
    const xClient = {
      createTweet: vi.fn().mockResolvedValue({
        id: "T-real",
        url: "https://x.com/me/status/T-real",
      }),
      verifyCredentials: vi.fn(),
      userTweets: vi.fn(),
      searchTimeline: vi.fn(),
    };
    const outcomes = await runSendTick({
      log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
      pendingDrafts: pending,
      xClient: xClient as never,
      markSent: async ({ draftId, sentExternalId, sentUrl }) => {
        const d = store.drafts.find((x) => x.id === draftId)!;
        d.sent_external_id = sentExternalId;
        d.sent_url = sentUrl;
      },
      markErrored: async () => {},
    });

    // ---- Final assertions --------------------------------------------
    expect(outcomes).toEqual([
      {
        draftId: empatheticDraft.id,
        leadId: empatheticApproval.lead_id,
        status: "sent",
        sentExternalId: "T-real",
        sentUrl: "https://x.com/me/status/T-real",
      },
    ]);
    // The empathetic draft has a tweet id; the other two never will.
    const sentDraft = store.drafts.find((d) => d.id === empatheticDraft.id)!;
    expect(sentDraft.sent_external_id).toBe("T-real");
    expect(sentDraft.sent_url).toBe("https://x.com/me/status/T-real");
    expect(
      store.drafts.filter((d) => d.sent_external_id != null),
    ).toHaveLength(1);
