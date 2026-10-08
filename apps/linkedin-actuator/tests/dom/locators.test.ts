// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { locateLikeTarget, locateCommentBox, locatePostCommentAction, locateCommentSubmit, diagnoseCommentSubmit, readCommentBox, detectChallenge, locateMessageCompose, readMessageCompose, locateMessageSend, locateAmbientExpand, locateAmbientComments, locatePostLike, locateReaction } from "../../src/content/locators.js";
import { makeRng } from "../../src/lib/rng.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => readFileSync(join(here, "..", "fixtures", n), "utf8");

// jsdom doesn't lay out, so getBoundingClientRect returns zeros — stub it so
// coordinate logic is exercised deterministically.
function stubRect(x: number, y: number, w = 40, h = 20) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x, y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h, toJSON: () => ({}),
  } as DOMRect);
}

describe("content locators", () => {
  it("locates the like button and returns its center coords + rect + observed", () => {
    document.body.innerHTML = fx("feed-post.html");
    stubRect(100, 200);
    const res = locateLikeTarget(document.body, { preferWatchlist: false, watchlistNames: [] }, makeRng(1));
    expect(res.ok).toBe(true);
    expect(res.x).toBe(120); // 100 + 40/2
    expect(res.y).toBe(210); // 200 + 20/2
    expect(res.rect).toEqual({ x: 100, y: 200, width: 40, height: 20 });
    expect(res.observed?.activity_urn).toBe("urn:li:activity:7300000000000000000");
    // Content hints for the reading model ride the same observed payload.
    expect(typeof res.observed?.wordCount).toBe("number");
    expect(res.observed?.hasMedia).toBe(false);
    expect(res.observed?.isTruncated).toBe(false);
    // No "…more" on this fixture → no seeMoreRect key emitted.
    expect(res.observed?.seeMoreRect).toBeUndefined();
  });

  it("skips when no likeable post is present", () => {
    document.body.innerHTML = fx("sponsored-post.html");
    const res = locateLikeTarget(document.body, { preferWatchlist: false, watchlistNames: [] }, makeRng(1));
    expect(res.ok).toBe(false);
    expect(res.skipReason).toMatch(/^no-likeable-post/);
  });

  it("the skip reason carries btns + path diagnostics", () => {
    document.body.innerHTML = "<div>no posts, no like buttons</div>";
    const res = locateLikeTarget(document.body, { preferWatchlist: false, watchlistNames: [] }, makeRng(1));
    expect(res.ok).toBe(false);
    // btns=0 (no React Like buttons anywhere) + a path= field so a skip row in
    // the DB says whether the feed just wasn't loaded vs the tab was off-feed.
    expect(res.skipReason).toMatch(/btns=0/);
    expect(res.skipReason).toMatch(/path=/);
  });

  it("likes a real post on drifted markup where every container class was renamed", () => {
    document.body.innerHTML = fx("feed-drifted.html");
    stubRect(100, 200);
    const res = locateLikeTarget(document.body, { preferWatchlist: false, watchlistNames: [] }, makeRng(1));
    // Fallback recovers the posts; the sponsored one is skipped, Alice's is liked.
    expect(res.ok).toBe(true);
    expect(res.observed?.author_name).toBe("Alice Rivera");
  });

  it("locates the comment box coords + rect", () => {
    document.body.innerHTML = fx("comment-box.html");
    stubRect(50, 60);
    const res = locateCommentBox(document.body);
    expect(res.ok).toBe(true);
    expect(res.x).toBe(70);
    expect(res.y).toBe(70);
    expect(res.rect).toEqual({ x: 50, y: 60, width: 40, height: 20 });
  });

  it("locates a current anchored plaintext-only editor and keeps the zero-rect guard", () => {
    document.body.innerHTML =
      '<div componentkey="commentBox-current">' +
      '<div role="textbox" contenteditable="plaintext-only" aria-label="Text editor for creating comment"></div>' +
      "</div>";
    stubRect(50, 60);
    expect(locateCommentBox(document.body)).toMatchObject({
      ok: true,
      x: 70,
      y: 70,
      rect: { x: 50, y: 60, width: 40, height: 20 },
    });

    vi.restoreAllMocks();
    stubRect(0, 0, 0, 0);
    expect(locateCommentBox(document.body)).toMatchObject({ ok: false, skipReason: "box-zero-rect" });
  });

  it("skips comment when no box found", () => {
    document.body.innerHTML = "<div>nope</div>";
    const res = locateCommentBox(document.body);
    expect(res.ok).toBe(false);
    expect(res.skipReason).toBe("selector-not-found");
  });

  it("locates the current post Comment action while its composer is collapsed", () => {
    document.body.innerHTML = fx("comment-collapsed-2026.html");
    stubRect(50, 60);
    expect(locateCommentBox(document.body)).toMatchObject({ ok: false, skipReason: "selector-not-found" });

    const action = locatePostCommentAction(document.body);
    expect(action).toMatchObject({ ok: true, x: 70, y: 70 });
    expect(action.rect).toEqual({ x: 50, y: 60, width: 40, height: 20 });

    document.querySelector("[role='listitem']")!.insertAdjacentHTML("beforeend",
      '<div componentkey="commentBox-abc"><div contenteditable="true" role="textbox" aria-label="Text editor for creating comment"><p data-placeholder="Add a comment..."></p></div></div>');
    expect(locateCommentBox(document.body).ok).toBe(true);
  });

  it("does not mistake a comment count, thread Reply, or composer submit for the post Comment action", () => {
    document.body.innerHTML = fx("comment-collapsed-2026.html");
    document.querySelector("[componentkey='post-comment-action']")!.remove();
    document.querySelector("[role='listitem']")!.insertAdjacentHTML("beforeend",
      '<div componentkey="commentButtonSection-abc"><button type="button">Comment</button></div>');
    expect(locatePostCommentAction(document.body)).toMatchObject({ ok: false, skipReason: "comment-action-not-found" });
  });

  it("recognizes the count-only 2026 post action without choosing the composer submit", () => {
    document.body.innerHTML = fx("comment-box-2026.html");
    stubRect(50, 60);
    expect(locatePostCommentAction(document.body)).toMatchObject({ ok: true, x: 70, y: 70 });
  });

  it("refuses a chat-pane textbox as the comment box", () => {
    // With the composer missing, the first contenteditable can be an open
    // messaging bubble — typing there (or the ⌘/Ctrl+Enter chord, which
    // messaging treats as send) would deliver the comment as a private DM.
    // The box search skips messaging textboxes, so this page has NO box.
    document.body.innerHTML =
      "<aside class='msg-overlay-list-bubble'><form class='msg-form'>" +
      "<div role='textbox' contenteditable='true' aria-label='Write a message…'></div>" +
      "<button type='submit'>Send</button></form></aside>";
    stubRect(50, 60);
    const res = locateCommentBox(document.body);
    expect(res.ok).toBe(false);
    expect(res.skipReason).toBe("selector-not-found");
  });

  it("skips a zero-rect (hidden) comment box instead of typing at the viewport corner", () => {
    document.body.innerHTML = "<div role='textbox' contenteditable='true'></div>";
    stubRect(0, 0, 0, 0);
    const res = locateCommentBox(document.body);
    expect(res.ok).toBe(false);
    expect(res.skipReason).toBe("box-zero-rect");
  });

  describe("locateCommentSubmit (2026 anchored locator + diagnostics)", () => {
    it("skips with submit-zero-rect when the button has no box (never a corner click)", () => {
      // A zero rect used to flow through as ok → rectFrom synthesized a 4x4 box
      // at {-2,-2} and the trusted click landed at the viewport corner.
      document.body.innerHTML = fx("comment-box.html");
      stubRect(0, 0, 0, 0);
      const res = locateCommentSubmit(document.body);
      expect(res.ok).toBe(false);
      expect(res.skipReason).toBe("submit-zero-rect");
    });

    it("returns coords + rect + the observed via/aria/text/type descriptor (2026 composer)", () => {
      document.body.innerHTML = fx("comment-box-2026.html");
      stubRect(50, 60);
      const res = locateCommentSubmit(document.body);
      expect(res.ok).toBe(true);
      expect(res.x).toBe(70);
      expect(res.y).toBe(70);
      expect(res.rect).toEqual({ x: 50, y: 60, width: 40, height: 20 });
      // The descriptor rides the background's not-cleared diagnostics.
      expect(res.observed?.via).toMatch(/^composer:\d+$/);
      expect(res.observed?.aria).toBe(""); // the 2026 submit has no aria-label
      expect(res.observed?.text).toBe("Comment");
      expect(res.observed?.type).toBe("button"); // the live commentButtonSection submit is type=button
    });

    it("describes the legacy BEM submit too (via/aria/text/type)", () => {
      document.body.innerHTML = fx("comment-box.html");
      stubRect(50, 60);
      const res = locateCommentSubmit(document.body);
      expect(res.ok).toBe(true);
      expect(res.observed?.via).toMatch(/^composer:\d+$/);
      expect(res.observed?.aria).toBe("Post comment");
      expect(res.observed?.text).toBe("Post");
      expect(res.observed?.type).toBe("button");
    });

    it("skips submit-not-found when nothing matches", () => {
      document.body.innerHTML = "<div>nope</div>";
      const res = locateCommentSubmit(document.body);
      expect(res.ok).toBe(false);
      expect(res.skipReason).toBe("submit-not-found");
    });
  });

  describe("diagnoseCommentSubmit (failure-cause split, real rects)", () => {
    it("uses getBoundingClientRect for the zero-rect test: enabled submit → en=1,vis=1", () => {
      document.body.innerHTML = fx("comment-box-2026.html");
      stubRect(50, 60); // non-zero → visible
      const res = diagnoseCommentSubmit(document.body);
      expect(res.ok).toBe(true);
