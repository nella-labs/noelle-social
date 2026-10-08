import { describe, expect, it } from "vitest";
import { awaitingHumanReview, readDraftBody } from "./draft-body.js";

describe("saved draft rendering", () => {
  it.each([
    null,
    [],
    "text",
    { body: 7 },
    { body: "old", edited_body: false },
    { body: "old", edited_body: "" },
  ])("withholds unusable effective text", (payload) => expect(readDraftBody(payload)).toBe(""));
  it("preserves the existing nullable-edit fallback and Unicode trimming", () => {
    expect(readDraftBody({ body: "  Café\r\n測定  ", edited_body: null })).toBe("Café\r\n測定");
    expect(readDraftBody({ body: "old", edited_body: "  new  " })).toBe("new");
  });
  it("requires explicit human approval only for flagged drafts", () => {
    expect(awaitingHumanReview({ human_review_required: true })).toBe(true);
    expect(awaitingHumanReview({ human_review_required: true, human_send_approved: true })).toBe(
      false,
    );
    expect(awaitingHumanReview(null)).toBe(false);
  });
});
