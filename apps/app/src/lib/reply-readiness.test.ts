import { expect, test } from "vitest";
import type { LinkedInApprovalView, PendingApprovalRow } from "./queries";
import { isLinkedInReplyReady, isXReplyReady } from "./reply-readiness";
import { visibleLinkedInReviewRows, visibleXReviewRows } from "./dm-visibility";

const goodReview = { pass: true, judgeOk: true, scores: { voice: 0.8 } };

function xRow(id: string, leadId: string, kind: "reply" | "dm", review: unknown): PendingApprovalRow {
  return {
    approval: { id, lead_id: leadId, status: "pending" },
    draft: { lead_id: leadId, payload: { kind, body: "A useful response", verifier_meta: review } },
    lead: { payload: { author_handle: "ada", post_id: "123", post_text: "A source post" } },
  } as unknown as PendingApprovalRow;
}

function linkedinRow(id: string, kind: "reply" | "dm", review: unknown): LinkedInApprovalView {
  return {
    approvalId: id,
    status: "pending",
    kind,
    authorPublicId: "ada",
    authorName: "Ada",
    postText: "A source post",
    postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:123/",
    body: "A useful response",
    verifierMeta: review,
  } as LinkedInApprovalView;
}

test("only a genuinely reviewed pending X reply is ready, never its companion DM", () => {
  expect(isXReplyReady(xRow("good", "lead-1", "reply", goodReview))).toBe(true);
  expect(isXReplyReady(xRow("uncertain", "lead-2", "reply", { pass: true }))).toBe(false);
  expect(isXReplyReady(xRow("dm", "lead-1", "dm", goodReview))).toBe(false);
  const blocked = xRow("blocked", "lead-3", "reply", goodReview);
  (blocked.draft!.payload as Record<string, unknown>).human_review_required = true;
  expect(isXReplyReady(blocked)).toBe(false);
});

test("LinkedIn readiness applies the voice floor and keeps failed drafts visible", () => {
  expect(isLinkedInReplyReady(linkedinRow("good", "reply", goodReview), 0.7)).toBe(true);
  expect(isLinkedInReplyReady(linkedinRow("low", "reply", { ...goodReview, scores: { voice: 0.6 } }), 0.7)).toBe(false);
  expect(isLinkedInReplyReady(linkedinRow("invalid", "reply", { ...goodReview, judgeOk: false }), 0.7)).toBe(false);
  expect(isLinkedInReplyReady(linkedinRow("dm", "dm", goodReview), 0.7)).toBe(false);
  expect(isLinkedInReplyReady(linkedinRow("good", "reply", goodReview), null)).toBe(false);
  expect(visibleLinkedInReviewRows([
    linkedinRow("failed", "reply", null),
    linkedinRow("good", "reply", goodReview),
  ], false).map((row) => row.approvalId)).toEqual(["good"]);
});

test("a passing reply angle represents its X lead even when a failed angle came first", () => {
  const rows = visibleXReviewRows([
    xRow("failed", "lead-1", "reply", null),
    xRow("ready", "lead-1", "reply", goodReview),
    xRow("dm", "lead-1", "dm", goodReview),
  ], true);
  expect(rows.map((row) => row.approval.id)).toEqual(["ready", "dm"]);
  expect(rows.filter(isXReplyReady)).toHaveLength(1);
});

test("identical LinkedIn text on distinct post URLs stays two reviewable posts", () => {
  const first = linkedinRow("first", "reply", goodReview);
  const second = { ...linkedinRow("second", "reply", goodReview), postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:456/" };
  expect(visibleLinkedInReviewRows([first, second], false).map((row) => row.approvalId))
    .toEqual(["first", "second"]);
});

test.each([null, 0, {}, [], "", "   "])("an authoritative cleared or invalid X edit stays unready: %j", (edit) => {
  const row = xRow("cleared", "lead-1", "reply", goodReview);
  (row.draft!.payload as Record<string, unknown>).edited_body = edit;
  expect(isXReplyReady(row)).toBe(false);
});

test("readiness uses the recorded selected bundle angle and a valid edited body", () => {
  const row = xRow("bundle", "lead-1", "reply", goodReview);
  row.draft!.payload = {
    kind: "reply", angle: "technical", angles: { technical: { body: "Selected reply" } },
    verifier_meta: goodReview,
  };
  expect(isXReplyReady(row)).toBe(true);
  (row.draft!.payload as Record<string, unknown>).edited_body = "Confirmed edit";
  expect(isXReplyReady(row)).toBe(true);
});
