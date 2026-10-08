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
    expect(() =>
      LinkedInActivityInSchema.parse({ session_id: "44444444-4444-4444-4444-444444444444", events: [] }),
    ).toThrow();
  });
});

const xBase: XJoinedRow = {
  approval_id: "11111111-1111-1111-1111-111111111111",
  draft_id: "22222222-2222-2222-2222-222222222222",
  lead_id: "33333333-3333-3333-3333-333333333333",
  draft_payload: { kind: "reply", body: "nice ship", verifier_meta: {
    pass: true, judgeOk: true, scores: { voice: 0.9, grounding: 0.9, relevance: 0.9, format: 0.9 },
  } },
  lead_payload: { authorName: "Jack" },
  author_handle: "jackfriks",
  external_id: "123",
  auto_send_target_at: null,
};

describe("buildActionableX", () => {
  it("withholds every reply without a real passing review", () => {
    const onOmit = vi.fn();
    const rows: XJoinedRow[] = [
      { ...xBase, draft_payload: { kind: "reply", body: "missing" } },
      { ...xBase, draft_payload: { kind: "reply", body: "failed", verifier_meta: { ...xBase.draft_payload!.verifier_meta!, pass: false } } },
      { ...xBase, draft_payload: { kind: "reply", body: "fake pass", verifier_meta: { ...xBase.draft_payload!.verifier_meta!, judgeOk: false } } },
    ];
    expect(buildActionableX(rows, onOmit).replies).toHaveLength(0);
    expect(onOmit.mock.calls.map(([reason]) => reason)).toEqual(["verify-missing", "verify-failed", "verify-no-valid-judge"]);
  });

  it("priority rows require observed source, Jev verdict, and passing review", () => {
    const observed = { ...xBase, lead_payload: { source: "extension_observed", classifier: { judge: "jev" } } };
    expect(isPriorityReadyXRow(observed)).toBe(true);
    expect(isPriorityReadyXRow({ ...observed, lead_payload: { source: "apify", classifier: { judge: "jev" } } })).toBe(false);
    expect(isPriorityReadyXRow({ ...observed, lead_payload: { source: "extension_observed", classifier: { judge: "legacy" } } })).toBe(false);
    expect(isPriorityReadyXRow({ ...observed, draft_payload: { kind: "reply", body: "no review" } })).toBe(false);
  });
  it("omits an autosend-owned approval (auto_send_target_at stamped) — duplicate-sender guard", () => {
    // On X, a stamped approval is claimed + posted by the x-intern API-autosend
    // pipeline. Serving it to the browser actuator too would post the SAME
    // reply twice. The SQL already filters these; this pure guard is the
    // belt-and-braces layer.
    const spy = vi.fn();
    const out = buildActionableX(
      [{ ...xBase, auto_send_target_at: "2026-07-17T18:00:00.000Z" }],
      spy,
    );
    expect(out.replies).toHaveLength(0);
    expect(spy).toHaveBeenCalledWith("autosend-owned", expect.anything());
  });

  it("builds the x.com permalink from handle + tweet id, reply-only", () => {
    const out = buildActionableX([xBase]);
    expect(out.replies).toHaveLength(1);
    expect(out.replies[0]).toMatchObject({
      kind: "reply",
      body: "nice ship",
      target: {
        type: "post",
        url: "https://x.com/jackfriks/status/123",
        tweet_id: "123",
        author_handle: "jackfriks",
        author_name: "Jack",
      },
    });
  });

  it("prefers edited_body over body", () => {
    const out = buildActionableX([{ ...xBase, draft_payload: { ...xBase.draft_payload!, body: "raw", edited_body: "edited" } }]);
    expect(out.replies[0]!.body).toBe("edited");
  });

  it("omits a row with no tweet id (can't locate the tweet)", () => {
    const spy = vi.fn();
    const out = buildActionableX([{ ...xBase, external_id: null }], spy);
    expect(out.replies).toHaveLength(0);
    expect(spy).toHaveBeenCalledWith("no-tweet-id", expect.anything());
  });

  it("falls back to x.com/i/status/:id when the handle is missing", () => {
    const out = buildActionableX([{ ...xBase, author_handle: null, lead_payload: null }]);
    expect(out.replies[0]!.target.url).toBe("https://x.com/i/status/123");
    expect(out.replies[0]!.target.author_handle).toBeNull();
  });

  it("omits a non-reply kind (X never DMs / reposts here)", () => {
    const spy = vi.fn();
    const out = buildActionableX([{ ...xBase, draft_payload: { kind: "dm", body: "hi" } }], spy);
    expect(out.replies).toHaveLength(0);
    expect(spy).toHaveBeenCalledWith("unsupported-kind", expect.anything());
  });

  it("omits an empty body", () => {
    const out = buildActionableX([{ ...xBase, draft_payload: { kind: "reply", body: "   " } }]);
    expect(out.replies).toHaveLength(0);
  });

  it("REGRESSION: omits auto-send-scheduled rows — they are owned by the x-intern API autosend pipeline", () => {
    // The duplicate-post scenario: an operator pre-stages an inbox autosend
    // batch (stamping approvals.auto_send_target_at) and later runs a browser
    // Drain. claimAutoSendDue (apps/x-intern/src/lib/send-db.ts) fires those
    // rows via the official API the moment reply_send_enabled is on — if
    // actionable-x served the SAME pending rows to the extension, the same
    // reply would post publicly twice (mark-sent only dedupes the DB, not the
    // public post). The SQL query excludes them at the source; this is the
    // testable belt on the builder.
    const spy = vi.fn();
    const out = buildActionableX(
      [
        { ...xBase, auto_send_target_at: "2026-07-17T10:00:00.000Z" },
        { ...xBase, approval_id: "44444444-4444-4444-4444-444444444444", auto_send_target_at: new Date() },
      ],
      spy,
    );
    expect(out.replies).toHaveLength(0);
    expect(spy).toHaveBeenCalledTimes(2);
    // Canonical omit reason is "autosend-owned" (the first-merged sibling port
    // named it; this regression test keeps its Date-stamp + multi-row coverage).
    expect(spy).toHaveBeenCalledWith("autosend-owned", expect.anything());
    // Unstamped (null or absent) rows keep flowing to the actuator.
    expect(buildActionableX([{ ...xBase, auto_send_target_at: null }]).replies).toHaveLength(1);
    expect(buildActionableX([xBase]).replies).toHaveLength(1);
  });
});

describe("x activity payload validation", () => {
  it("rejects an empty events array", () => {
    expect(() =>
      XActivityInSchema.parse({ session_id: "44444444-4444-4444-4444-444444444444", events: [] }),
    ).toThrow();
  });
  it("accepts a like/reply/skip event batch", () => {
    const parsed = XActivityInSchema.parse({
      session_id: "44444444-4444-4444-4444-444444444444",
      events: [
        { type: "reply", approval_id: "11111111-1111-1111-1111-111111111111", at: "2026-07-10T20:00:00.000Z" },
        { type: "like", tweet_id: "123", author_handle: "jackfriks", at: "2026-07-10T20:01:00.000Z" },
        { type: "skip", reason: "reply-failed", at: "2026-07-10T20:02:00.000Z" },
      ],
    });
    expect(parsed.events).toHaveLength(3);
  });
});

describe("bodyHasExternalLink", () => {
  it("flags a non-x.com link", () => {
    expect(bodyHasExternalLink("check this out https://example.com/thing")).toBe(true);
    expect(bodyHasExternalLink("read https://blog.substack.com/p/x")).toBe(true);
  });
  it("allows x.com / twitter.com / t.co links", () => {
    expect(bodyHasExternalLink("see https://x.com/foo/status/1")).toBe(false);
    expect(bodyHasExternalLink("via https://www.twitter.com/foo")).toBe(false);
    expect(bodyHasExternalLink("shortened https://t.co/abcd")).toBe(false);
    expect(bodyHasExternalLink("sub https://mobile.x.com/foo")).toBe(false);
  });
  it("is false for a plain no-link reply", () => {
    expect(bodyHasExternalLink("just a normal reply, no links here")).toBe(false);
  });
});

describe("buildActionableX external-link guard", () => {
  const linkRow: XJoinedRow = { ...xBase, draft_payload: { ...xBase.draft_payload!, body: "great, see https://example.com/x" } };

  it("withholds a reply with an external link when blockExternalLinks is on", () => {
    const spy = vi.fn();
    const out = buildActionableX([linkRow], spy, { blockExternalLinks: true });
    expect(out.replies).toHaveLength(0);
    expect(spy).toHaveBeenCalledWith("external-link", expect.anything());
  });
  it("serves it when the guard is off (default/no opts)", () => {
    expect(buildActionableX([linkRow]).replies).toHaveLength(1);
    expect(buildActionableX([linkRow], undefined, { blockExternalLinks: false }).replies).toHaveLength(1);
  });
  it("still serves a clean reply with the guard on", () => {
    expect(buildActionableX([xBase], undefined, { blockExternalLinks: true }).replies).toHaveLength(1);
  });
});

describe("capActionableXPerAuthor", () => {
  const reply = (over: Partial<XJoinedRow>): XJoinedRow => ({ ...xBase, ...over });
  const empty: ReadonlyMap<string, number> = new Map();

  it("cap=1 keeps only the first (newest) reply per author, drops the rest", () => {
    const rows = [
      reply({ approval_id: "a-1", lead_id: "l-1", external_id: "200", author_handle: "jack" }), // newest first
      reply({ approval_id: "a-2", lead_id: "l-2", external_id: "100", author_handle: "jack" }),
      reply({ approval_id: "a-3", lead_id: "l-3", external_id: "150", author_handle: "sara" }),
    ];
    const out = capActionableXPerAuthor(buildActionableX(rows), rows, { cap: 1, writtenCounts: empty });
    const ids = out.replies.map((r) => r.approval_id);
    expect(ids).toContain("a-1"); // jack's newest
    expect(ids).not.toContain("a-2"); // jack's older, over cap
    expect(ids).toContain("a-3"); // sara, distinct author
  });

  it("drops an author already replied-to today", () => {
    const rows = [reply({ approval_id: "a-1", author_handle: "jack" })];
    const out = capActionableXPerAuthor(buildActionableX(rows), rows, { cap: 1, writtenCounts: new Map([["jack", 1]]) });
    expect(out.replies).toHaveLength(0);
  });

  it("cap=2 serves one more reply after one send, then withholds the next", () => {
    const rows = [
      reply({ approval_id: "a-1", lead_id: "l-1", external_id: "200", author_handle: "jack" }),
      reply({ approval_id: "a-2", lead_id: "l-2", external_id: "100", author_handle: "jack" }),
    ];
    const out = capActionableXPerAuthor(buildActionableX(rows), rows, {
      cap: 2, writtenCounts: new Map([["jack", 1]]),
    });
    expect(out.replies.map((r) => r.approval_id)).toEqual(["a-1"]);
  });

  it("cap<1 fails safe to 1", () => {
    const rows = [
      reply({ approval_id: "a-1", lead_id: "l-1", author_handle: "jack" }),
      reply({ approval_id: "a-2", lead_id: "l-2", author_handle: "jack" }),
    ];
    const out = capActionableXPerAuthor(buildActionableX(rows), rows, { cap: 0, writtenCounts: empty });
    expect(out.replies).toHaveLength(1);
  });
});

describe("dedupeAlreadyRepliedX (persistent dedup-by-link)", () => {
  it("drops a reply whose tweet id was already replied to", () => {
    const built = buildActionableX([xBase]); // tweet_id "123"
    expect(built.replies).toHaveLength(1);
    const out = dedupeAlreadyRepliedX(built, new Set(["123"]));
    expect(out.replies).toHaveLength(0);
  });

  it("keeps a reply whose tweet id is NOT in the replied set", () => {
    const built = buildActionableX([xBase]);
    const out = dedupeAlreadyRepliedX(built, new Set(["999"]));
    expect(out.replies).toHaveLength(1);
  });

  it("empty replied set is an identity passthrough", () => {
    const built = buildActionableX([xBase]);
    const out = dedupeAlreadyRepliedX(built, new Set());
    expect(out.replies).toHaveLength(1);
  });

  it("drops only the already-replied tweet, keeps a fresh one in the same batch", () => {
    const fresh: XJoinedRow = {
      ...xBase,
      approval_id: "44444444-4444-4444-4444-444444444444",
      lead_id: "55555555-5555-5555-5555-555555555555",
      external_id: "456",
    };
    const built = buildActionableX([xBase, fresh]);
    expect(built.replies).toHaveLength(2);
    const out = dedupeAlreadyRepliedX(built, new Set(["123"]));
    expect(out.replies).toHaveLength(1);
    expect(out.replies[0]!.target.tweet_id).toBe("456");
  });

  it("collapses two leads that resolve to the same tweet once one is replied", () => {
    const sibling: XJoinedRow = {
      ...xBase,
      approval_id: "44444444-4444-4444-4444-444444444444",
      lead_id: "55555555-5555-5555-5555-555555555555",
      // same external_id "123" — a second lead on the same tweet
    };
    const built = buildActionableX([xBase, sibling]);
    expect(built.replies).toHaveLength(2);
    const out = dedupeAlreadyRepliedX(built, new Set(["123"]));
    expect(out.replies).toHaveLength(0);
  });

  it("an ambiguous-dropped tweet id (skip-stamped, approval still pending) blocks re-serving", () => {
    // Cross-session shape of the round-3 blocker: the extension dispatched a
    // submit, could not confirm landing, dropped the draft WITHOUT markSent and
    // stamped tweet_id on the skip row. The approval is still 'pending', so
    // Source B misses it — the skip-stamped id from Source A must block it.
    const built = buildActionableX([xBase]); // pending approval on tweet "123"
    const out = dedupeAlreadyRepliedX(built, new Set(["123"])); // "123" via a skip row
    expect(out.replies).toHaveLength(0);
  });
});

describe("fetchXRepliedTweetIds (the dedup union's evidence sources)", () => {
  type SqlParam = Parameters<typeof fetchXRepliedTweetIds>[0];
  // Fake postgres.js tagged template: records the raw SQL text, returns canned rows.
  function fakeSql(rows: Array<{ tweet_id: string }>) {
    const queries: string[] = [];
    const sql = ((strings: TemplateStringsArray, ..._vals: unknown[]) => {
      queries.push(strings.raw.join("?")); // "?" marks each bound parameter
      return Promise.resolve(rows);
    }) as unknown as SqlParam;
    return { sql, queries };
  }

  it("builds the set from the returned rows", async () => {
    const { sql } = fakeSql([{ tweet_id: "123" }, { tweet_id: "456" }]);
    expect(await fetchXRepliedTweetIds(sql, "org-1", ["123", "456"])).toEqual(new Set(["123", "456"]));
  });

  // THE round-3 regression: the union previously read ONLY type='reply' rows,
  // so an ambiguous-dropped submit (a type='skip' row stamped with tweet_id,
  // approval left 'pending') was invisible to the dedup and the same reply was
  // re-served — and re-posted — in a later session. The evidence query must
  // read skip rows too, and must still exclude 'like' rows (liked ≠ replied).
  it("reads tweet_id-stamped skip rows (ambiguous-dropped), not just confirmed replies", async () => {
    const { sql, queries } = fakeSql([]);
    await fetchXRepliedTweetIds(sql, "org-1", ["123", "456"]);
    expect(queries).toHaveLength(1);
    const q = queries[0]!;
    expect(q).toMatch(/type in \('reply', 'skip'\)/);
    expect(q).toMatch(/tweet_id is not null/);
    expect(q).not.toMatch(/'like'/);
    // …and still unions the authoritative 'sent'-approvals history (Source B):
    expect(q).toMatch(/union/);
    expect(q).toMatch(/status = 'sent'/);
    expect(q).toMatch(/from noelle\.x_reply_claims/);
  });

  it("propagates a query error so the route can fail CLOSED (empty queue)", async () => {
    const sql = (() => Promise.reject(new Error("boom"))) as unknown as SqlParam;
    await expect(fetchXRepliedTweetIds(sql, "org-1", ["123", "456"])).rejects.toThrow("boom");
  });
});

describe("resolveXDailyWriteCap (daily write-cap fail-safe, ports #426)", () => {
  it("a non-numeric env value falls back to 40 (never NaN → never fail-open)", () => {
    expect(resolveXDailyWriteCap("garbage")).toBe(40);
  });
  it("an unset env value stays CAPPED at 40 — unlike LinkedIn, unset ≠ unlimited", () => {
    expect(resolveXDailyWriteCap(undefined)).toBe(40);
  });
  it("a negative env value falls back to 40", () => {
    expect(resolveXDailyWriteCap("-3")).toBe(40);
  });
  it("a valid numeric env value is honored (0 is respected = serve nothing)", () => {
    expect(resolveXDailyWriteCap("25")).toBe(25);
    expect(resolveXDailyWriteCap("0")).toBe(0);
  });
  it("only the explicit sentinel lifts the cap (case/whitespace tolerant)", () => {
    expect(resolveXDailyWriteCap("off")).toBe(Number.POSITIVE_INFINITY);
    expect(resolveXDailyWriteCap("unlimited")).toBe(Number.POSITIVE_INFINITY);
    expect(resolveXDailyWriteCap(" OFF ")).toBe(Number.POSITIVE_INFINITY);
  });
  it("with the sentinel the trim branch never fires and telemetry reports null", () => {
    const cap = resolveXDailyWriteCap("off");
    const remaining = Math.max(0, cap - 0); // usage query is skipped ⇒ used = 0
    expect(10 > remaining).toBe(false); // any served length ≤ Infinity
    expect(Number.isFinite(cap) ? cap : null).toBeNull(); // x-health writeCap shape
  });
  it("with env='garbage' the served queue is TRIMMED to the fallback cap (the old Number(env ?? 40) parse left it un-trimmed)", () => {
    const cap = resolveXDailyWriteCap("garbage"); // 40 (not NaN)
    const usedToday = 38;
    const remaining = Math.max(0, cap - usedToday); // 2
    const served = Array.from({ length: 5 }, (_, i) => i); // 5 pending replies
    // The bug being fixed: `served.length > NaN` is ALWAYS false → the cap never trims.
    expect(served.length > Number("garbage")).toBe(false); // documents the old fail-OPEN
    // The fix: a finite cap trims the queue down to the remaining budget.
    expect(served.length > remaining).toBe(true);
    expect(served.slice(0, remaining)).toHaveLength(2);
  });
});

// A reddit lead: post id (t3 stripped) in external_id, subreddit + comments-page
// permalink in payload, post author in author_handle. No reply_target ⇒ post target.
const redditBase: RedditJoinedRow = {
  approval_id: "11111111-1111-1111-1111-111111111111",
  draft_id: "22222222-2222-2222-2222-222222222222",
  lead_id: "33333333-3333-3333-3333-333333333333",
  draft_payload: { kind: "reply", body: "great point, here's my take" },
  lead_payload: {
    subreddit: "SaaS",
    url: "https://www.reddit.com/r/SaaS/comments/abc123/some_title/",
    author_handle: "founder_jane",
  },
  author_handle: "founder_jane",
  external_id: "abc123",
};

describe("buildActionableReddit", () => {
  it.each([
    ["foreign thread", "/r/SaaS/comments/other9/title/def456/"],
    ["foreign host", "https://example.test/r/SaaS/comments/abc123/title/def456/"],
    ["different comment", "/r/SaaS/comments/abc123/title/other9/"],
    ["different subreddit", "/r/Other/comments/abc123/title/def456/"],
  ])("withholds a persisted comment-grounded reply with %s", (_, permalink) => {
    const row: RedditJoinedRow = { ...redditBase, draft_payload: { kind: "reply", body: "comment-specific detail",
      reply_target: { kind: "comment", commentId: "def456", permalink } } };
    expect(buildActionableReddit([row]).replies).toEqual([]);
  });
  it("does not repair a source post mismatch or an invalid declared ID from an alias", () => {
    for (const change of [
      { external_id: "other9" },
      { external_id: "abc123!", lead_payload: { ...redditBase.lead_payload, original_post_id: "abc123" } },
      { lead_payload: { ...redditBase.lead_payload, original_post_id: "other9" } },
      { lead_payload: { ...redditBase.lead_payload, original_post_url: "https://www.reddit.com/r/SaaS/comments/other9/title/" } },
    ]) expect(buildActionableReddit([{ ...redditBase, ...change }]).replies).toEqual([]);
  });
  it("maps a row with no reply_target to a POST target (source post comments permalink)", () => {
    const out = buildActionableReddit([redditBase]);
    expect(out.replies).toHaveLength(1);
    expect(out.replies[0]).toMatchObject({
      kind: "reply",
      body: "great point, here's my take",
      target: {
        type: "post",
        url: "https://www.reddit.com/r/SaaS/comments/abc123/some_title/",
        post_id: "abc123",
        subreddit: "SaaS",
        author: "founder_jane",
      },
    });
    // A post target never carries a comment_id.
    expect(out.replies[0]!.target).not.toHaveProperty("comment_id");
  });

  it("maps a reply_target.kind='comment' row to a COMMENT target (permalink + t1 id + comment author)", () => {
    const row: RedditJoinedRow = {
      ...redditBase,
      draft_payload: {
        kind: "reply",
        body: "replying under the top comment",
        reply_target: {
          kind: "comment",
          commentId: "t1_def456", // t1_ prefix stripped in output
          permalink: "/r/SaaS/comments/abc123/some_title/def456/", // relative → absolutized
          author: "u/topcommenter", // u/ prefix stripped in output
        },
      },
    };
    const out = buildActionableReddit([row]);
    expect(out.replies).toHaveLength(1);
    expect(out.replies[0]!.target).toEqual({
      type: "comment",
      url: "https://www.reddit.com/r/SaaS/comments/abc123/some_title/def456/",
      post_id: "abc123",
      comment_id: "def456",
      subreddit: "SaaS",
      author: "topcommenter",
    });
  });

  it("drops a reply whose body carries an external (non-reddit) link, guard on", () => {
    const spy = vi.fn();
    const row: RedditJoinedRow = { ...redditBase, draft_payload: { kind: "reply", body: "see https://example.com/x" } };
    const out = buildActionableReddit([row], spy, { blockExternalLinks: true });
    expect(out.replies).toHaveLength(0);
    expect(spy).toHaveBeenCalledWith("external-link", expect.anything());
  });

  it("allows a reddit-internal link with the guard on", () => {
    const row: RedditJoinedRow = { ...redditBase, draft_payload: { kind: "reply", body: "see https://www.reddit.com/r/SaaS/x" } };
    expect(buildActionableReddit([row], undefined, { blockExternalLinks: true }).replies).toHaveLength(1);
  });

  it("drops an empty body", () => {
    const out = buildActionableReddit([{ ...redditBase, draft_payload: { kind: "reply", body: "   " } }]);
    expect(out.replies).toHaveLength(0);
  });

  it("prefers edited_body over body", () => {
    const out = buildActionableReddit([{ ...redditBase, draft_payload: { kind: "reply", body: "raw", edited_body: "edited" } }]);
    expect(out.replies[0]!.body).toBe("edited");
  });

  it("omits a non-reply kind (Reddit is reply-only)", () => {
    const spy = vi.fn();
    const out = buildActionableReddit([{ ...redditBase, draft_payload: { kind: "dm", body: "hi" } }], spy);
    expect(out.replies).toHaveLength(0);
    expect(spy).toHaveBeenCalledWith("unsupported-kind", expect.anything());
  });

  it("omits a post-target row whose comments permalink can't be resolved", () => {
    const spy = vi.fn();
    const row: RedditJoinedRow = { ...redditBase, lead_payload: { subreddit: "SaaS", author_handle: "founder_jane" } };
    const out = buildActionableReddit([row], spy);
    expect(out.replies).toHaveLength(0);
    expect(spy).toHaveBeenCalledWith("no-post-url", expect.anything());
  });

  it("FAILS CLOSED: a comment target missing its comment id is dropped", () => {
    const spy = vi.fn();
    const row: RedditJoinedRow = {
      ...redditBase,
      draft_payload: { kind: "reply", body: "x", reply_target: { kind: "comment", permalink: "/r/SaaS/comments/abc/c/" } },
    };
    const out = buildActionableReddit([row], spy);
    expect(out.replies).toHaveLength(0);
    expect(spy).toHaveBeenCalledWith("no-comment-id", expect.anything());
  });

  it("FAILS CLOSED: a comment target missing its permalink is dropped", () => {
    const spy = vi.fn();
    const row: RedditJoinedRow = {
      ...redditBase,
      draft_payload: { kind: "reply", body: "x", reply_target: { kind: "comment", commentId: "def456" } },
    };
    const out = buildActionableReddit([row], spy);
    expect(out.replies).toHaveLength(0);
    expect(spy).toHaveBeenCalledWith("no-comment-permalink", expect.anything());
  });

  it("strips a leading t3_ from external_id for post_id, and falls back to payload.original_post_id", () => {
    expect(buildActionableReddit([{ ...redditBase, external_id: "t3_abc123" }]).replies[0]!.target.post_id).toBe("abc123");
    const noExt: RedditJoinedRow = {
      ...redditBase,
      external_id: null,
      lead_payload: { ...redditBase.lead_payload, original_post_id: "zzz999",
        url: "https://www.reddit.com/r/SaaS/comments/zzz999/title/" },
    };
    expect(buildActionableReddit([noExt]).replies[0]!.target.post_id).toBe("zzz999");
  });

  it("produces a schema-valid response (the target discriminated union parses)", () => {
    const commentRow: RedditJoinedRow = {
      ...redditBase,
      draft_payload: { kind: "reply", body: "y", reply_target: { kind: "comment", commentId: "def456", permalink: "/r/SaaS/comments/abc123/title/def456/" } },
    };
    expect(() => ActionableRedditResponseSchema.parse(buildActionableReddit([redditBase, commentRow]))).not.toThrow();
  });
});

describe("dedupeAlreadyRepliedReddit (persistent dedup-by-thread, ports #420)", () => {
  it("drops a reply whose thread was already replied to", () => {
    const built = buildActionableReddit([redditBase]); // target.post_id = "abc123"
    expect(built.replies).toHaveLength(1);
    const out = dedupeAlreadyRepliedReddit(built, new Set(["abc123"]));
    expect(out.replies).toHaveLength(0);
  });

  it("keeps a reply whose thread is NOT in the replied set", () => {
    const built = buildActionableReddit([redditBase]);
    const out = dedupeAlreadyRepliedReddit(built, new Set(["zzz999"]));
    expect(out.replies).toHaveLength(1);
  });

  it("empty replied set is an identity passthrough", () => {
    const built = buildActionableReddit([redditBase]);
    const out = dedupeAlreadyRepliedReddit(built, new Set());
    expect(out.replies).toHaveLength(1);
  });

  it("a COMMENT-target reply in an already-replied thread is dropped too (per-THREAD grain)", () => {
    const row: RedditJoinedRow = {
      ...redditBase,
      draft_payload: {
        kind: "reply",
        body: "replying under the top comment",
        reply_target: { kind: "comment", commentId: "def456", permalink: "/r/SaaS/comments/abc123/x/def456/" },
      },
    };
    const built = buildActionableReddit([row]);
    expect(built.replies[0]!.target.post_id).toBe("abc123"); // the PARENT post's id
    const out = dedupeAlreadyRepliedReddit(built, new Set(["abc123"]));
    expect(out.replies).toHaveLength(0);
  });

  it("derives an absent legacy post_id from its known permalink for persistent dedup", () => {
    const row: RedditJoinedRow = { ...redditBase, external_id: null };
    const built = buildActionableReddit([row]);
    expect(built.replies[0]!.target.post_id).toBe("abc123");
    const out = dedupeAlreadyRepliedReddit(built, new Set(["abc123"]));
    expect(out.replies).toHaveLength(0);
  });

  it("drops only the already-replied thread, keeps a fresh one in the same batch", () => {
    const fresh: RedditJoinedRow = {
      ...redditBase,
      approval_id: "44444444-4444-4444-4444-444444444444",
      lead_id: "55555555-5555-5555-5555-555555555555",
      external_id: "zzz999",
      lead_payload: { ...redditBase.lead_payload, url: "https://www.reddit.com/r/SaaS/comments/zzz999/other/" },
    };
    const built = buildActionableReddit([redditBase, fresh]);
    expect(built.replies).toHaveLength(2);
    const out = dedupeAlreadyRepliedReddit(built, new Set(["abc123"]));
    expect(out.replies).toHaveLength(1);
    expect(out.replies[0]!.target.post_id).toBe("zzz999");
  });
});

describe("bodyHasExternalRedditLink", () => {
  it("flags a non-reddit link", () => {
    expect(bodyHasExternalRedditLink("check https://example.com/thing")).toBe(true);
    expect(bodyHasExternalRedditLink("read https://blog.substack.com/p/x")).toBe(true);
  });
  it("allows reddit.com / redd.it links", () => {
    expect(bodyHasExternalRedditLink("see https://www.reddit.com/r/x")).toBe(false);
    expect(bodyHasExternalRedditLink("old https://old.reddit.com/r/x")).toBe(false);
    expect(bodyHasExternalRedditLink("img https://i.redd.it/abc.png")).toBe(false);
    expect(bodyHasExternalRedditLink("short https://redd.it/abc")).toBe(false);
  });
  it("is false for a plain no-link reply", () => {
    expect(bodyHasExternalRedditLink("just a normal reply, no links here")).toBe(false);
  });
});

describe("resolveRedditDailyWriteCap (daily write-cap fail-safe, FIX 5)", () => {
  it("a non-numeric env value falls back to 8 (never NaN → never fail-open)", () => {
    expect(resolveRedditDailyWriteCap("eight")).toBe(8);
  });
  it("an unset env value falls back to 8", () => {
    expect(resolveRedditDailyWriteCap(undefined)).toBe(8);
  });
  it("a negative env value falls back to 8", () => {
    expect(resolveRedditDailyWriteCap("-3")).toBe(8);
  });
  it("a valid numeric env value is honored (0 is respected = serve nothing)", () => {
    expect(resolveRedditDailyWriteCap("5")).toBe(5);
    expect(resolveRedditDailyWriteCap("0")).toBe(0);
  });
  it("only the explicit sentinel lifts the cap — unset never means unlimited (ports #426 as opt-in)", () => {
    expect(resolveRedditDailyWriteCap("off")).toBe(Number.POSITIVE_INFINITY);
    expect(resolveRedditDailyWriteCap("unlimited")).toBe(Number.POSITIVE_INFINITY);
    expect(resolveRedditDailyWriteCap(" Unlimited ")).toBe(Number.POSITIVE_INFINITY);
    // near-miss strings are garbage, not sentinels → fail-safe default
    expect(resolveRedditDailyWriteCap("offf")).toBe(8);
  });
  it("with the sentinel the trim branch never fires and reddit-health reports null", () => {
    const cap = resolveRedditDailyWriteCap("off");
    const remaining = Math.max(0, cap - 0); // usage query is skipped ⇒ used = 0
    expect(10 > remaining).toBe(false); // any served length ≤ Infinity
    expect(Number.isFinite(cap) ? cap : null).toBeNull(); // reddit-health writeCap shape
  });
  it("with env='eight' the served queue is TRIMMED to the fallback cap (NaN would leave it un-trimmed)", () => {
    const cap = resolveRedditDailyWriteCap("eight"); // 8 (not NaN)
    const usedToday = 5;
    const remaining = Math.max(0, cap - usedToday); // 3
    const served = Array.from({ length: 10 }, (_, i) => i); // 10 pending replies
    // The bug being fixed: `served.length > NaN` is ALWAYS false → the cap never trims.
    expect(served.length > Number("eight")).toBe(false); // documents the old fail-OPEN
    // The fix: a finite cap trims the queue down to the remaining budget.
    expect(served.length > remaining).toBe(true);
    expect(served.slice(0, remaining)).toHaveLength(3);
  });
});

describe("reddit activity payload validation", () => {
  it("rejects an empty events array", () => {
    expect(() =>
      RedditActivityInSchema.parse({ session_id: "44444444-4444-4444-4444-444444444444", events: [] }),
    ).toThrow();
  });
  it("accepts a reply/skip/upvote event batch (UPVOTE-ONLY — the operator opted in)", () => {
    const parsed = RedditActivityInSchema.parse({
      session_id: "44444444-4444-4444-4444-444444444444",
      events: [
        { type: "reply", approval_id: "11111111-1111-1111-1111-111111111111", post_id: "abc123", comment_id: "def456", subreddit: "SaaS", at: "2026-07-11T20:00:00.000Z" },
        { type: "upvote", post_id: "abc123", subreddit: "SaaS", at: "2026-07-11T20:01:00.000Z" },
        { type: "skip", reason: "throttle", at: "2026-07-11T20:02:00.000Z" },
      ],
    });
    expect(parsed.events).toHaveLength(3);
    expect(parsed.events.map((e) => e.type)).toContain("upvote");
  });
  it("rejects a 'downvote' event — voting is UPVOTE-ONLY, downvotes can never be logged", () => {
    expect(() =>
      RedditActivityInSchema.parse({
        session_id: "44444444-4444-4444-4444-444444444444",
        events: [{ type: "downvote", post_id: "abc123", at: "2026-07-11T20:00:00.000Z" }],
      }),
    ).toThrow();
  });
});

describe("intentAdvanced (remote start/stop long-poll early-return, 0089)", () => {
  it("returns true only when a real commandAt is strictly newer than `since`", () => {
    expect(intentAdvanced(1_000, 999)).toBe(true);
    expect(intentAdvanced(1_000, 1_000)).toBe(false); // equal → the extension already saw it
    expect(intentAdvanced(999, 1_000)).toBe(false);
  });

  it("NEVER early-returns when commandAt is null (no command ever) — guards the busy-loop", () => {
    expect(intentAdvanced(null, 0)).toBe(false);
    expect(intentAdvanced(null, 1_700_000_000_000)).toBe(false);
  });

  it("a fresh extension (since=0) picks up any standing command immediately", () => {
    expect(intentAdvanced(1_700_000_000_000, 0)).toBe(true);
  });
});


describe("Reddit dispatch claim HTTP admission", () => {
  it.each([
    ["invalid_json", "{", 400],
    ["invalid_capture", JSON.stringify({ instance_id: "not-a-uuid" }), 400],
    ["oversize_request", " ".repeat(131073), 413],
  ])("rejects %s before SQL", async (_name, body, status) => {
    const { actuator } = await import("./actuator.js");
    const { __setDbClientForTests, resetDbClientForTests } = await import("../lib/db.js");
    const { resetEnvForTests } = await import("../env.js");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("NOELLE_DATABASE_URL", "postgres://inert:inert@127.0.0.1:9/not-opened");
    vi.stubEnv("NOELLE_HMAC_SECRET", "h".repeat(48));
    vi.stubEnv("NOELLE_ACTUATOR_TOKEN", "inert-token");
    vi.stubEnv("NOELLE_ACTUATOR_ORG_ID", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    resetEnvForTests();
    const unexpectedSql = vi.fn(() => { throw new Error("SQL must not be admitted"); });
    __setDbClientForTests(unexpectedSql as never);
    try {
      const response = await actuator.request("/api/reddit-reply-claim", {
        method: "POST", headers: { authorization: "Bearer inert-token", "content-type": "application/json" }, body,
      });
      expect(response.status).toBe(status);
      expect(unexpectedSql).not.toHaveBeenCalled();
    } finally {
      resetDbClientForTests(); resetEnvForTests(); vi.unstubAllEnvs();
    }
  });
});
