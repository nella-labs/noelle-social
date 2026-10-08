import { describe, it, expect, vi } from "vitest";
import {
  LinkedInActivityInSchema,
  XActivityInSchema,
  ActionableRedditResponseSchema,
  RedditActivityInSchema,
} from "@noelle/contracts";
import {
  buildActionable,
  isPriorityReadyRow,
  buildActionableX,
  isPriorityReadyXRow,
  buildActionableReddit,
  bodyHasExternalLink,
  bodyHasExternalRedditLink,
  capActionableXPerAuthor,
  shouldHaltForChallenge,
  capActionablePerAuthor,
  resolveRedditDailyWriteCap,
  resolveXDailyWriteCap,
  dedupeAlreadyCommented,
  dedupeAlreadyRepliedReddit,
  dedupeAlreadyRepliedX,
  fetchXRepliedTweetIds,
  intentAdvanced,
  type JoinedRow,
  type XJoinedRow,
  type RedditJoinedRow,
} from "./actuator.js";

const base: JoinedRow = {
  approval_id: "11111111-1111-1111-1111-111111111111",
  draft_id: "22222222-2222-2222-2222-222222222222",
  lead_id: "33333333-3333-3333-3333-333333333333",
  draft_payload: { kind: "reply", body: "hello", angle: "technical" },
  lead_payload: {
    authorName: "Jane Doe",
    authorPublicId: "jane-doe",
    postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:7300000000000000000/",
  },
  author_handle: "jane-doe",
  author_id: "fsd-jane-doe",
  wp_name: "Jane Doe",
};

describe("buildActionable", () => {
  it("maps a reply to a comment item with a post target + activity urn", () => {
    const out = buildActionable([base]);
    expect(out.comments).toHaveLength(1);
    expect(out.dms).toHaveLength(0);
    expect(out.comments[0]!.target.activity_urn).toBe("urn:li:activity:7300000000000000000");
    expect(out.comments[0]!.body).toBe("hello");
  });

  it("uses edited_body over body", () => {
    const out = buildActionable([{ ...base, draft_payload: { kind: "reply", body: "raw", edited_body: "edited" } }]);
    expect(out.comments[0]!.body).toBe("edited");
  });

  it("omits a reply whose post URL cannot be derived", () => {
    const out = buildActionable([{ ...base, lead_payload: { authorName: "Jane", authorPublicId: "jane-doe" } }]);
    expect(out.comments).toHaveLength(0);
  });

  it("FAILS CLOSED: a dm without dm_send_approved is dropped", () => {
    const out = buildActionable([{ ...base, draft_payload: { kind: "dm", body: "hi there" } }]);
    expect(out.dms).toHaveLength(0);
  });

  it("includes a dm only when dm_send_approved is true", () => {
    const out = buildActionable([{ ...base, draft_payload: { kind: "dm", body: "hi there", dm_send_approved: true } }]);
    expect(out.dms).toHaveLength(1);
    expect(out.dms[0]!.target.url).toBe("https://www.linkedin.com/in/jane-doe/");
  });

  it("calls onOmit with 'no-post-url' when a reply has no post URL", () => {
    const spy = vi.fn();
    const row: JoinedRow = { ...base, lead_payload: { authorName: "Jane", authorPublicId: "jane-doe" } };
    const out = buildActionable([row], spy);
    expect(out.comments).toHaveLength(0);
    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith("no-post-url", row);
  });

  it("derives activity_urn from the real LinkedIn slug URL (…-activity-<id>-<code>)", () => {
    // Regression: real LinkedIn post links are the /posts/…-activity-<id>-<code>
    // slug form, NOT urn:li:activity:. The old regex returned null → activity_urn
    // was null for every real post (breaking the dedup key). Now normalized.
    const link = "https://www.linkedin.com/posts/jeshuasoh_shelterforhope-activity-7481524546924343296-ek0Y";
    const out = buildActionable([{ ...base, lead_payload: { authorPublicId: "jeshuasoh", original_post_url: link } }]);
    expect(out.comments[0]!.target.activity_urn).toBe("urn:li:activity:7481524546924343296");
  });

  it("serves a reply whose URL lives under original_post_url (real LinkedIn shape)", () => {
    // Regression: LinkedIn leads store the post link as original_post_url/url,
    // NOT postUrl. Reading only postUrl dropped every reply as no-post-url.
    const link = "https://www.linkedin.com/posts/jane-doe_activity-7301234567890000000-abcd";
    const row: JoinedRow = {
      ...base,
      lead_payload: { authorName: "Jane Doe", authorPublicId: "jane-doe", original_post_url: link, url: link },
    };
    const out = buildActionable([row]);
    expect(out.comments).toHaveLength(1);
    expect(out.comments[0]!.target.url).toBe(link);
  });

  it("prefers postUrl, then original_post_url, then url", () => {
    const only = (lp: JoinedRow["lead_payload"]) =>
      buildActionable([{ ...base, lead_payload: lp }]).comments[0]?.target.url;
    expect(only({ authorPublicId: "j", postUrl: "P", original_post_url: "O", url: "U" })).toBe("P");
    expect(only({ authorPublicId: "j", original_post_url: "O", url: "U" })).toBe("O");
    expect(only({ authorPublicId: "j", url: "U" })).toBe("U");
  });

  describe("verifier gate (P5 unattended precondition)", () => {
    const gate = { requireVerify: true, voiceFloor: 0.7 };
    const vm = (voice: number, pass = true) => ({
      pass,
      judgeOk: true,
      judgeProvider: "jev" as const,
      scores: { voice, grounding: 1, relevance: 1, format: 1 },
      reasons: [] as string[],
      attempts: 1,
    });

    it("gate off (undefined) + no verifier_meta → served (byte-identical to today)", () => {
      const out = buildActionable([base]);
      expect(out.comments).toHaveLength(1);
    });

    it("gate on + no verifier_meta → omitted 'verify-missing' (fail closed)", () => {
      const spy = vi.fn();
      const out = buildActionable([base], spy, gate);
      expect(out.comments).toHaveLength(0);
      expect(spy).toHaveBeenCalledWith("verify-missing", base);
    });

    it("gate on + pass:false → omitted 'verify-failed'", () => {
      const spy = vi.fn();
      const row: JoinedRow = { ...base, draft_payload: { kind: "reply", body: "hello", verifier_meta: vm(0.9, false) } };
      const out = buildActionable([row], spy, gate);
      expect(out.comments).toHaveLength(0);
      expect(spy).toHaveBeenCalledWith("verify-failed", row);
    });

    it("gate on + pass:true but voice below floor → omitted 'verify-low-voice'", () => {
      const spy = vi.fn();
      const row: JoinedRow = { ...base, draft_payload: { kind: "reply", body: "hello", verifier_meta: vm(0.6) } };
      const out = buildActionable([row], spy, gate);
      expect(out.comments).toHaveLength(0);
      expect(spy).toHaveBeenCalledWith("verify-low-voice", row);
    });

    it("gate on + pass:true & voice >= floor → served", () => {
      const row: JoinedRow = { ...base, draft_payload: { kind: "reply", body: "hello", verifier_meta: vm(0.8) } };
      const out = buildActionable([row], undefined, gate);
      expect(out.comments).toHaveLength(1);
    });

    it("does not send a fail-open pass with no valid judge verdict", () => {
      const row: JoinedRow = { ...base, draft_payload: {
        kind: "reply", body: "hello", verifier_meta: { ...vm(0.9), judgeOk: false },
      } };
      expect(buildActionable([row], undefined, gate).comments).toHaveLength(0);
    });

    it("gate on does NOT touch the DM branch (DMs are human-approved)", () => {
      const row: JoinedRow = { ...base, draft_payload: { kind: "dm", body: "hi there", dm_send_approved: true } };
      const out = buildActionable([row], undefined, gate);
      expect(out.dms).toHaveLength(1);
      expect(out.comments).toHaveLength(0);
    });
  });
});

describe("priority-ready LinkedIn replies", () => {
  it("requires extension source and Jev qualification", () => {
    const eligible: JoinedRow = { ...base, lead_payload: {
      ...base.lead_payload,
      source: "extension_observed",
      classifier: { provider: "jev" },
    } };
    expect(isPriorityReadyRow(eligible)).toBe(true);
    expect(isPriorityReadyRow({ ...eligible, lead_payload: { ...eligible.lead_payload, classifier: { provider: "fallback" } } })).toBe(false);
    expect(isPriorityReadyRow(base)).toBe(false);
    expect(isPriorityReadyRow({ ...eligible, draft_payload: { kind: "dm", body: "hi", dm_send_approved: true } })).toBe(false);
  });
});

describe("shouldHaltForChallenge (P5 circuit-breaker)", () => {
  it("halts on a live challenge in the window", () => {
    expect(shouldHaltForChallenge({ flagEnabled: true, recentChallengeCount: 1 })).toBe(true);
  });
  it("does not halt on a clean window (no behavior change on a healthy account)", () => {
    expect(shouldHaltForChallenge({ flagEnabled: true, recentChallengeCount: 0 })).toBe(false);
  });
  it("FAILS CLOSED: a null count (query error) halts", () => {
    expect(shouldHaltForChallenge({ flagEnabled: true, recentChallengeCount: null })).toBe(true);
  });
  it("flag disabled is a true no-op regardless of count", () => {
