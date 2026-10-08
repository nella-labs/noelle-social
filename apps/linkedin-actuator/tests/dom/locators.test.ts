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
      expect(res.observed).toMatchObject({ box: true, wf: 1, en: 1, vis: 1 });
    });

    it("a zero-rect enabled submit reports en=1,vis=0 (the layout-race bucket)", () => {
      document.body.innerHTML = fx("comment-box-2026.html");
      stubRect(0, 0, 0, 0); // every rect zero
      const res = diagnoseCommentSubmit(document.body);
      expect(res.observed).toMatchObject({ en: 1, vis: 0 });
      expect(res.observed?.top).toBe("Comment_zr");
    });
  });

  describe("readCommentBox (post-submit verification)", () => {
    it("reports a populated box as NOT posted (text still sitting there)", () => {
      document.body.innerHTML =
        "<div role='textbox' contenteditable='true'>my reply that never landed</div>";
      const res = readCommentBox(document.body);
      expect(res.ok).toBe(true);
      expect(res.observed).toMatchObject({ present: true, empty: false });
    });

    it("reports an emptied box as posted (LinkedIn cleared the composer)", () => {
      document.body.innerHTML = "<div role='textbox' contenteditable='true'></div>";
      const res = readCommentBox(document.body);
      expect(res.observed).toMatchObject({ present: true, empty: true });
    });

    it("treats zero-width-space-only content as empty (posted)", () => {
      document.body.innerHTML = `<div role='textbox' contenteditable='true'>${'\u200B'}</div>`;
      expect(readCommentBox(document.body).observed).toMatchObject({ empty: true });
    });

    it("reports a vanished composer as posted (present:false)", () => {
      document.body.innerHTML = "<div>composer gone after posting</div>";
      const res = readCommentBox(document.body);
      expect(res.ok).toBe(true);
      expect(res.observed).toMatchObject({ present: false, empty: true });
    });
  });

  it.each(["like", "celebrate", "support"])("retains an existing %s post reaction", (state) => {
    document.body.innerHTML = `<main><button aria-label="Reaction button state: ${state}">Like</button></main>`;
    stubRect(20, 30);
    expect(locatePostLike(document.body)).toMatchObject({ ok: false, skipReason: "already-liked" });
  });
  it("locates the current unreacted post button", () => {
    document.body.innerHTML = '<main><button aria-label="Reaction button state: no reaction">Like</button></main>';
    stubRect(20, 30);
    expect(locatePostLike(document.body)).toMatchObject({ ok: true, x: 40, y: 40 });
  });

  it("detectChallenge true on a real captcha vendor iframe", () => {
    document.body.innerHTML = "<iframe src='https://client-api.arkoselabs.com/v2/enforcement'></iframe>";
    expect(detectChallenge(document.body)).toBe(true);
  });

  it("detectChallenge false on ordinary content mentioning a 'security check'", () => {
    document.body.innerHTML = "<div>please verify your identity for this security check</div>";
    expect(detectChallenge(document.body)).toBe(false);
  });

  it("locateMessageCompose returns coords + rect when DM compose box is present", () => {
    document.body.innerHTML = fx("dm-compose.html");
    stubRect(20, 30);
    const res = locateMessageCompose(document.body);
    expect(res.ok).toBe(true);
    expect(res.x).toBe(40); // 20 + 40/2
    expect(res.y).toBe(40); // 30 + 20/2
    expect(res.rect).toEqual({ x: 20, y: 30, width: 40, height: 20 });
  });

  it("locateMessageSend returns selector-not-found when msg-form absent", () => {
    document.body.innerHTML = "<div>no form here</div>";
    const res = locateMessageSend(document.body);
    expect(res.ok).toBe(false);
    expect(res.skipReason).toBe("selector-not-found");
  });

  // `.msg-form` matches the messaging overlay that persists on EVERY LinkedIn
  // page, including while minimised, where it measures 0x0. Without this guard
  // rectFrom synthesizes a 4x4 box around {0,0} and the trusted click lands in
  // the viewport corner — on LinkedIn's global nav, not a composer. That click
  // now fires on every navigation, so the guard is what keeps the clear safe.
  it("locateMessageCompose refuses a zero-rect (hidden) overlay instead of returning a corner click", () => {
    document.body.innerHTML = fx("dm-compose.html");
    stubRect(0, 0, 0, 0);
    const res = locateMessageCompose(document.body);
    expect(res.ok).toBe(false);
    expect(res.skipReason).toBe("compose-zero-rect");
  });

  it("locateMessageSend refuses a zero-rect Send for the same reason", () => {
    document.body.innerHTML = fx("dm-compose.html");
    stubRect(0, 0, 0, 0);
    const res = locateMessageSend(document.body);
    expect(res.ok).toBe(false);
    expect(res.skipReason).toBe("send-zero-rect");
  });

  it("readMessageCompose reports an absent composer as present:false", () => {
    document.body.innerHTML = "<div>no form here</div>";
    const res = readMessageCompose(document.body);
    expect(res.ok).toBe(true);
    expect(res.observed?.present).toBe(false);
    expect(res.observed?.empty).toBe(true);
  });

  // The whole point of the read: an operator's half-typed DM must register as
  // NON-empty, so runClearComposer's emptiness-first check is what decides
  // whether the box is touched at all.
  it("readMessageCompose distinguishes an empty box from one holding text", () => {
    document.body.innerHTML = fx("dm-compose.html");
    const box = document.querySelector<HTMLElement>(".msg-form [contenteditable='true']")!;
    box.textContent = "";
    expect(readMessageCompose(document.body).observed?.empty).toBe(true);
    box.textContent = "half-typed message";
    const dirty = readMessageCompose(document.body);
    expect(dirty.observed?.present).toBe(true);
    expect(dirty.observed?.empty).toBe(false);
  });

  // The rich editor leaves a zero-width space behind after a clear; an otherwise
  // cleared box must still read empty or the clear loop would never converge.
  it("readMessageCompose treats a zero-width leftover as empty", () => {
    document.body.innerHTML = fx("dm-compose.html");
    const box = document.querySelector<HTMLElement>(".msg-form [contenteditable='true']")!;
    box.textContent = "​﻿";
    expect(readMessageCompose(document.body).observed?.empty).toBe(true);
  });
});

describe("ambient read-action locators", () => {
  it("locateAmbientExpand finds a truncated post's see-more toggle + hints", () => {
    document.body.innerHTML = fx("long-post.html");
    stubRect(100, 200);
    const res = locateAmbientExpand(document.body, makeRng(1));
    expect(res.ok).toBe(true);
    expect(res.rect).toEqual({ x: 100, y: 200, width: 40, height: 20 });
    expect(res.observed?.activity_urn).toBe("urn:li:activity:7300000000000001111");
    expect(typeof res.observed?.wordCount).toBe("number");
  });

  it("locateAmbientExpand skips when nothing is truncated", () => {
    document.body.innerHTML = fx("feed-post.html");
    const res = locateAmbientExpand(document.body, makeRng(1));
    expect(res.ok).toBe(false);
    expect(res.skipReason).toBe("no-truncated-post");
  });

  it("locateAmbientComments finds the comments toggle on a post with a discussion", () => {
    document.body.innerHTML = fx("commented-post.html");
    stubRect(60, 90);
    const res = locateAmbientComments(document.body, makeRng(2));
    expect(res.ok).toBe(true);
    expect(res.x).toBe(80); // 60 + 40/2
    expect(res.observed?.activity_urn).toBe("urn:li:activity:7300000000000002222");
  });

  it("locateAmbientComments falls back to the action-bar Comment on a plain post", () => {
    document.body.innerHTML = fx("feed-post.html");
    stubRect(10, 20);
    const res = locateAmbientComments(document.body, makeRng(3));
    expect(res.ok).toBe(true); // feed-post exposes an action-bar Comment button
  });

  it("locateAmbientComments skips when no post exposes comments", () => {
    document.body.innerHTML = "<div>nope</div>";
    const res = locateAmbientComments(document.body, makeRng(4));
    expect(res.ok).toBe(false);
    expect(res.skipReason).toBe("no-commentable-post");
  });
});

describe("locateReaction (varied reactions from the open flyout)", () => {
  it("returns the requested reaction's rect + observed.reaction", () => {
    document.body.innerHTML = fx("reaction-menu.html");
    stubRect(300, 150);
    const res = locateReaction(document.body, "PRAISE");
    expect(res.ok).toBe(true);
    expect(res.rect).toEqual({ x: 300, y: 150, width: 40, height: 20 });
    expect(res.observed?.reaction).toBe("PRAISE");
  });

  it("resolves Support (EMPATHY) too", () => {
    document.body.innerHTML = fx("reaction-menu.html");
    stubRect(340, 150);
    expect(locateReaction(document.body, "EMPATHY").ok).toBe(true);
  });

  it("skips (so the caller falls back to a plain like) when the flyout isn't open", () => {
    document.body.innerHTML = fx("feed-post.html");
    const res = locateReaction(document.body, "PRAISE");
    expect(res.ok).toBe(false);
    expect(res.skipReason).toBe("reaction-not-found(PRAISE)");
  });
});

describe("locatePostLike (reply-also-likes)", () => {
  it("locates the post's like button on the open post page", () => {
    document.body.innerHTML = fx("feed-post.html"); // has an unliked React Like button
