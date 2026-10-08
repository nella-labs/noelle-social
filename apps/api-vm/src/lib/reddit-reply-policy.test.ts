import { describe, expect, it } from "vitest";
import { buildActionableReddit, type RedditJoinedRow } from "./reddit-reply-policy.js";

const source: RedditJoinedRow = {
  approval_id: "a",
  draft_id: "d",
  lead_id: "l",
  external_id: "t3_abc123",
  author_handle: "u/builder",
  lead_payload: { subreddit: "SaaS", url: "https://www.reddit.com/r/SaaS/comments/abc123/title/" },
  draft_payload: { kind: "reply", body: " Original " },
};

describe("shared Reddit queue and claim policy", () => {
  it("uses the effective saved body and coherent parent target", () => {
    const reply = buildActionableReddit([
      { ...source, draft_payload: { ...source.draft_payload, edited_body: " Café " } },
    ]).replies[0];
    expect(reply).toMatchObject({ body: "Café", target: { post_id: "abc123", author: "builder" } });
  });
  it("keeps the selected comment bound to the same source thread", () => {
    const selected = {
      kind: "comment" as const,
      commentId: "def456",
      permalink: source.lead_payload!.url + "def456/",
    };
    expect(
      buildActionableReddit([
        { ...source, draft_payload: { ...source.draft_payload, reply_target: selected } },
      ]).replies[0]?.target,
    ).toMatchObject({ type: "comment", post_id: "abc123", comment_id: "def456" });
    expect(
      buildActionableReddit([
        {
          ...source,
          draft_payload: {
            ...source.draft_payload,
            reply_target: {
              ...selected,
              permalink: "https://www.reddit.com/r/SaaS/comments/other9/title/def456/",
            },
          },
        },
      ]).replies,
    ).toEqual([]);
  });
  it("preserves human review and explicit link policy before dispatch", () => {
    expect(
      buildActionableReddit([
        { ...source, draft_payload: { ...source.draft_payload, human_review_required: true } },
      ]).replies,
    ).toEqual([]);
    const linked = { ...source, draft_payload: { body: "https://example.test" } };
    expect(
      buildActionableReddit([linked], undefined, { blockExternalLinks: true }).replies,
    ).toEqual([]);
    expect(
      buildActionableReddit([linked], undefined, { blockExternalLinks: false }).replies,
    ).toHaveLength(1);
  });
});
