import { describe, expect, it } from "vitest";
import { buildActionable, buildActionableX, type JoinedRow, type XJoinedRow } from "./actuator.js";

const base = {
  approval_id: "approval", draft_id: "draft", lead_id: "lead", author_handle: "ada",
  draft_payload: { kind: "reply" as const, body: "A saved draft", human_review_required: true },
  lead_payload: { authorName: "Ada", original_post_url: "https://www.linkedin.com/feed/update/urn:li:activity:123/" },
};

describe("manual reply review gates", () => {
  const linkedin: JoinedRow = { ...base, author_id: "ada", wp_name: null };
  const x: XJoinedRow = { ...base, external_id: "123", auto_send_target_at: null };

  it("stays in review on LinkedIn even when the ordinary queue is enabled", () => {
    expect(buildActionable([linkedin]).comments).toEqual([]);
  });

  it("stays in review on X even when the ordinary queue is enabled", () => {
    expect(buildActionableX([x]).replies).toEqual([]);
  });

  it("releases X only after an explicit approval and a genuine passing review", () => {
    const approved = { ...base.draft_payload, human_send_approved: true };
    expect(buildActionable([{ ...linkedin, draft_payload: approved }]).comments).toHaveLength(1);
    expect(buildActionableX([{ ...x, draft_payload: approved }]).replies).toHaveLength(0);
    const verified = { ...approved, verifier_meta: {
      pass: true, judgeOk: true,
      scores: { voice: 0.9, grounding: 0.9, relevance: 0.9, format: 0.9 },
    } };
    expect(buildActionableX([{ ...x, draft_payload: verified }]).replies).toHaveLength(1);
  });
});
