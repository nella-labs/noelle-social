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
    expect(shouldHaltForChallenge({ flagEnabled: false, recentChallengeCount: 5 })).toBe(false);
    expect(shouldHaltForChallenge({ flagEnabled: false, recentChallengeCount: null })).toBe(false);
  });
});

describe("capActionablePerAuthor (P5 per-author daily cap)", () => {
  const empty: ReadonlySet<string> = new Set();
  // Build a reply row spread from base, with distinct approval_id/lead_id.
  const reply = (over: Partial<JoinedRow>): JoinedRow => ({ ...base, ...over });
  const cap = (rows: JoinedRow[], args: { cap: number; writtenHandles?: ReadonlySet<string>; writtenIds?: ReadonlySet<string> }) =>
    capActionablePerAuthor(buildActionable(rows), rows, {
      cap: args.cap,
      writtenHandles: args.writtenHandles ?? empty,
      writtenIds: args.writtenIds ?? empty,
    });

  it("cap=1 collapses two comments from the same author to the newest (first) one", () => {
    const r1 = reply({ approval_id: "a-1", lead_id: "l-1" }); // newest first in rows order
    const r2 = reply({ approval_id: "a-2", lead_id: "l-2" });
    const out = cap([r1, r2], { cap: 1 });
    expect(out.comments).toHaveLength(1);
    expect(out.comments[0]!.approval_id).toBe("a-1");
  });

  it("cap=1 across a comment AND a dm to the same author → only one survives", () => {
    const r1 = reply({ approval_id: "a-1", lead_id: "l-1" }); // comment
    const r2 = reply({ approval_id: "a-2", lead_id: "l-2", draft_payload: { kind: "dm", body: "hi", dm_send_approved: true } });
    const out = cap([r1, r2], { cap: 1 });
    expect(out.comments.length + out.dms.length).toBe(1);
  });

  it("two different authors, cap=1 → both kept", () => {
    const r1 = reply({ approval_id: "a-1", lead_id: "l-1", author_handle: "jane-doe", author_id: "fsd-jane", lead_payload: { authorPublicId: "jane-doe", postUrl: base.lead_payload!.postUrl } });
    const r2 = reply({ approval_id: "a-2", lead_id: "l-2", author_handle: "bob", author_id: "fsd-bob", lead_payload: { authorPublicId: "bob", postUrl: base.lead_payload!.postUrl } });
    const out = cap([r1, r2], { cap: 1 });
    expect(out.comments).toHaveLength(2);
  });

  it("writtenHandles excludes an author already actioned today; a different author is still served", () => {
    const r1 = reply({ approval_id: "a-1", lead_id: "l-1", author_handle: "jane-doe", author_id: "fsd-jane", lead_payload: { authorPublicId: "jane-doe", postUrl: base.lead_payload!.postUrl } });
    const r2 = reply({ approval_id: "a-2", lead_id: "l-2", author_handle: "bob", author_id: "fsd-bob", lead_payload: { authorPublicId: "bob", postUrl: base.lead_payload!.postUrl } });
    const out = cap([r1, r2], { cap: 1, writtenHandles: new Set(["jane-doe"]) });
    expect(out.comments).toHaveLength(1);
    expect(out.comments[0]!.approval_id).toBe("a-2");
  });

  it("cross-lane exclusion by author_id even when handle is null", () => {
    const r1 = reply({
      approval_id: "a-1", lead_id: "l-1", author_handle: null, author_id: "fsd-a",
      lead_payload: { authorPublicId: null, postUrl: base.lead_payload!.postUrl },
    });
    const out = cap([r1], { cap: 1, writtenIds: new Set(["fsd-a"]) });
    expect(out.comments).toHaveLength(0);
  });

  it("cap=2 keeps two writes for one author, drops the 3rd", () => {
    const rows = ["a-1", "a-2", "a-3"].map((id, i) => reply({ approval_id: id, lead_id: `l-${i}` }));
    const out = cap(rows, { cap: 2 });
    expect(out.comments).toHaveLength(2);
    expect(out.comments.map((c) => c.approval_id)).toEqual(["a-1", "a-2"]);
  });

  it("fail-safe: cap=0 / NaN treated as 1", () => {
    const rows = [reply({ approval_id: "a-1", lead_id: "l-1" }), reply({ approval_id: "a-2", lead_id: "l-2" })];
    expect(cap(rows, { cap: 0 }).comments).toHaveLength(1);
    expect(cap(rows, { cap: NaN }).comments).toHaveLength(1);
  });

  it("unknown-author rows never merge and are never excluded by the written sets", () => {
    const r1 = reply({
      approval_id: "a-1", lead_id: "l-1", author_handle: null, author_id: null,
      lead_payload: { authorPublicId: null, postUrl: base.lead_payload!.postUrl },
    });
    const r2 = reply({
      approval_id: "a-2", lead_id: "l-2", author_handle: null, author_id: null,
      lead_payload: { authorPublicId: null, postUrl: base.lead_payload!.postUrl },
    });
    const out = cap([r1, r2], { cap: 1, writtenHandles: new Set(["jane-doe"]), writtenIds: new Set(["fsd-jane-doe"]) });
    expect(out.comments).toHaveLength(2);
  });
});

describe("dedupeAlreadyCommented (persistent dedup-by-link)", () => {
  const urn = "urn:li:activity:7300000000000000000"; // base's post URN
  const otherUrn = "urn:li:activity:7399999999999999999";

  it("drops a comment whose post URN is already commented on", () => {
    const built = buildActionable([base]);
    expect(built.comments).toHaveLength(1);
    const out = dedupeAlreadyCommented(built, new Set([urn]));
    expect(out.comments).toHaveLength(0);
  });

  it("keeps a comment whose post URN is NOT in the commented set", () => {
    const built = buildActionable([base]);
    const out = dedupeAlreadyCommented(built, new Set([otherUrn]));
    expect(out.comments).toHaveLength(1);
  });

  it("empty commented set is an identity passthrough", () => {
    const built = buildActionable([base]);
    const out = dedupeAlreadyCommented(built, new Set());
    expect(out.comments).toHaveLength(1);
  });

  it("keeps a comment with no derivable activity_urn (nothing to dedup by link)", () => {
    // A post URL with no urn:li:activity → target.activity_urn is null → never dropped.
    const link = "https://www.linkedin.com/posts/jane-doe_some-slug-abcd";
    const built = buildActionable([{ ...base, lead_payload: { authorPublicId: "jane-doe", url: link } }]);
    expect(built.comments[0]!.target.activity_urn).toBeNull();
    const out = dedupeAlreadyCommented(built, new Set([urn]));
    expect(out.comments).toHaveLength(1);
  });

  it("blocks a slug-URL post whose activity id was already replied to", () => {
    // The replied-set holds normalized urns (urn:li:activity:<external_id>); a
    // fresh queue item on the SAME post via the slug URL must still be dropped.
    const id = "7481524546924343296";
    const link = `https://www.linkedin.com/posts/jane_slug-activity-${id}-ek0Y`;
    const built = buildActionable([{ ...base, lead_payload: { authorPublicId: "jane", original_post_url: link } }]);
    expect(built.comments[0]!.target.activity_urn).toBe(`urn:li:activity:${id}`);
    const out = dedupeAlreadyCommented(built, new Set([`urn:li:activity:${id}`]));
    expect(out.comments).toHaveLength(0);
  });

  // THE INCIDENT. A conversation reply used to be exempted from this dedup, on
  // the reasoning that answering someone who replied to us is a second comment
  // on that post by design. That is only true if the answer can be THREADED
  // under their comment — and Lyra's actuator posts at POST level. So the
  // exemption did not thread anything: it published a SECOND top-level comment
  // from the operator on a thread he had already commented on. Five reached
  // LinkedIn before it was caught.
  it("drops a conversation reply to an already-commented post — no duplicate top-level comment", () => {
    const built = buildActionable([base]);
    expect(built.comments).toHaveLength(1);
    const out = dedupeAlreadyCommented(built, new Set([urn]));
    expect(out.comments).toHaveLength(0);
  });

  it("the exemption parameter, if ever passed, is still scoped to the given lead ids", () => {
    // Kept as a parameter for a future caller that genuinely CAN thread. This
    // pins that it never widens to other leads on the same post.
    const other: JoinedRow = {
      ...base,
      approval_id: "66666666-6666-6666-6666-666666666666",
      lead_id: "77777777-7777-7777-7777-777777777777",
    };
    const built = buildActionable([base, other]);
    const out = dedupeAlreadyCommented(built, new Set([urn]), new Set([base.lead_id]));
    expect(out.comments.map((c) => c.lead_id)).toEqual([base.lead_id]);
  });

  it("never touches DMs (profile-targeted, not post-targeted)", () => {
    const built = buildActionable([{ ...base, draft_payload: { kind: "dm", body: "hi", dm_send_approved: true } }]);
    expect(built.dms).toHaveLength(1);
    const out = dedupeAlreadyCommented(built, new Set([urn]));
    expect(out.dms).toHaveLength(1);
  });

  // THE INTERLOCK. Being exempt from "do not comment twice on this post" is
  // only legitimate if we are not commenting on the post at all — i.e. the item
  // carries a threading target the actuator will actually use. The first
  // version exempted every conversation reply and published five duplicate
  // top-level comments on the operator's own threads.
  it("keeps a conversation reply that CAN thread", () => {
    const built = buildActionable([base]);
    built.comments[0]!.target.comment_urn = "urn:li:comment:7487199472029192192";
    const threaded = new Set(
      built.comments.filter((c) => Boolean(c.target.comment_urn)).map((c) => c.lead_id),
    );
    expect(dedupeAlreadyCommented(built, new Set([urn]), threaded).comments).toHaveLength(1);
  });

  it("still drops one that CANNOT thread — no target, no exemption", () => {
    const built = buildActionable([base]);
    expect(built.comments[0]!.target.comment_urn ?? null).toBeNull();
    const threaded = new Set(
      built.comments.filter((c) => Boolean(c.target.comment_urn)).map((c) => c.lead_id),
    );
    expect(threaded.size).toBe(0);
    expect(dedupeAlreadyCommented(built, new Set([urn]), threaded).comments).toHaveLength(0);
  });

  it("drops only the already-commented post, keeps a fresh one in the same batch", () => {
    const fresh: JoinedRow = {
      ...base,
      approval_id: "44444444-4444-4444-4444-444444444444",
      lead_id: "55555555-5555-5555-5555-555555555555",
      lead_payload: { authorPublicId: "bob", postUrl: `https://www.linkedin.com/feed/update/${otherUrn}/` },
    };
    const built = buildActionable([base, fresh]);
    expect(built.comments).toHaveLength(2);
    const out = dedupeAlreadyCommented(built, new Set([urn]));
    expect(out.comments).toHaveLength(1);
    expect(out.comments[0]!.target.activity_urn).toBe(otherUrn);
  });
});

describe("activity payload validation", () => {
  it("rejects an empty events array", () => {
