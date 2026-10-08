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
