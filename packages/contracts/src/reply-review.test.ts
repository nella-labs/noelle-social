import { describe, expect, it } from "vitest";
import { passesUnattendedReplyReview } from "./reply-review.js";

describe("unattended reply review", () => {
  const passed = { pass: true, judgeOk: true, scores: { voice: 0.8 } };

  it("requires a real passing judge and the configured voice floor", () => {
    expect(passesUnattendedReplyReview(passed, 0.7)).toBe(true);
    expect(passesUnattendedReplyReview(passed, 0.81)).toBe(false);
    expect(passesUnattendedReplyReview({ ...passed, pass: false }, 0.7)).toBe(false);
    expect(passesUnattendedReplyReview({ ...passed, judgeOk: false }, 0.7)).toBe(false);
  });

  it("holds absent and fail-open review records", () => {
    expect(passesUnattendedReplyReview(null, 0)).toBe(false);
    expect(passesUnattendedReplyReview({ pass: true, scores: { voice: 1 } }, 0)).toBe(false);
    expect(passesUnattendedReplyReview({ pass: true, judgeOk: true }, 0)).toBe(false);
  });
});
