// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { locateLikeTarget, locatePostLike, locateCommentBox, locateCommentSubmit, diagnoseCommentSubmit, readCommentBox, detectChallenge } from "../../src/content/locators.js";
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

const enableSubmit = () => {
  const btn = document.body.querySelector<HTMLButtonElement>("button[data-testid='tweetButtonInline']")!;
  btn.disabled = false;
  btn.removeAttribute("aria-disabled");
};

describe("locateCommentBox (protocol name; the X reply composer)", () => {
  it("locates the reply box coords + rect", () => {
    document.body.innerHTML = fx("reply-composer.html");
    stubRect(50, 60);
    const res = locateCommentBox(document.body);
    expect(res.ok).toBe(true);
    expect(res.x).toBe(70); // 50 + 40/2
    expect(res.y).toBe(70); // 60 + 20/2
    expect(res.rect).toEqual({ x: 50, y: 60, width: 40, height: 20 });
  });

  it("skips when no box found", () => {
    document.body.innerHTML = "<div>nope</div>";
    const res = locateCommentBox(document.body);
    expect(res.ok).toBe(false);
    expect(res.skipReason).toBe("selector-not-found");
  });

  it("refuses the DM composer as the reply box", () => {
    // With the reply composer missing, the only contenteditable is the DM
    // drawer's — typing there would deliver the reply as a private message.
    document.body.innerHTML =
      "<aside data-testid='DMDrawer'>" +
      "<div role='textbox' contenteditable='true' data-testid='dmComposerTextInput'></div>" +
      "<button data-testid='dmComposerSendButton' type='submit' aria-label='Send'></button></aside>";
    stubRect(50, 60);
    const res = locateCommentBox(document.body);
    expect(res.ok).toBe(false);
    expect(res.skipReason).toBe("selector-not-found");
  });

  it("skips a zero-rect (hidden) box instead of typing at the viewport corner", () => {
    document.body.innerHTML = fx("reply-composer.html");
    stubRect(0, 0, 0, 0);
    const res = locateCommentBox(document.body);
    expect(res.ok).toBe(false);
    expect(res.skipReason).toBe("box-zero-rect");
  });
});

describe("locateCommentSubmit (anchored locator + diagnostics descriptor)", () => {
  it("skips with submit-zero-rect when the button has no box (never a corner click)", () => {
    // A zero rect used to flow through as ok → rectFrom synthesized a 4x4 box
    // at {-2,-2} and the trusted click landed at the viewport corner.
    document.body.innerHTML = fx("reply-composer.html");
    enableSubmit();
    stubRect(0, 0, 0, 0);
    const res = locateCommentSubmit(document.body);
    expect(res.ok).toBe(false);
    expect(res.skipReason).toBe("submit-zero-rect");
  });

  it("returns coords + rect + the observed via/aria/text/type descriptor", () => {
    document.body.innerHTML = fx("reply-composer.html");
    enableSubmit();
    stubRect(50, 60);
    const res = locateCommentSubmit(document.body);
    expect(res.ok).toBe(true);
    expect(res.x).toBe(70);
    expect(res.y).toBe(70);
    expect(res.rect).toEqual({ x: 50, y: 60, width: 40, height: 20 });
    // The descriptor rides the background's not-cleared diagnostics.
    expect(res.observed?.via).toBe("testid:tweetButtonInline");
    expect(res.observed?.aria).toBe(""); // the inline submit has no aria-label
    expect(res.observed?.text).toBe("Reply");
    expect(res.observed?.type).toBe("button");
  });

  it("skips submit-not-found while the submit is disabled (poll waits for enable)", () => {
    document.body.innerHTML = fx("reply-composer.html");
    stubRect(50, 60);
    const res = locateCommentSubmit(document.body);
    expect(res.ok).toBe(false);
    expect(res.skipReason).toBe("submit-not-found");
  });

  it("skips submit-not-found when nothing matches", () => {
    document.body.innerHTML = "<div>nope</div>";
    const res = locateCommentSubmit(document.body);
    expect(res.ok).toBe(false);
    expect(res.skipReason).toBe("submit-not-found");
  });
});

describe("locateCommentSubmit (enabled-only, bare markup)", () => {
  it("returns a rect for an enabled reply submit", () => {
    document.body.innerHTML = "<button data-testid='tweetButtonInline'>Reply</button>";
    stubRect(50, 60);
    const res = locateCommentSubmit(document.body);
    expect(res.ok).toBe(true);
    expect(res.rect).toEqual({ x: 50, y: 60, width: 40, height: 20 });
  });

  it("skips a DISABLED submit (X enables it only once the editor registers text)", () => {
    document.body.innerHTML = "<button data-testid='tweetButtonInline' disabled>Reply</button>";
    expect(locateCommentSubmit(document.body).ok).toBe(false);
    document.body.innerHTML = "<button data-testid='tweetButton' aria-disabled='true'>Reply</button>";
    expect(locateCommentSubmit(document.body).ok).toBe(false);
  });
});

describe("diagnoseCommentSubmit (failure-cause split, real rects)", () => {
  it("uses getBoundingClientRect for the zero-rect test: enabled submit → en=1,vis=1", () => {
    document.body.innerHTML = fx("reply-composer.html");
    enableSubmit();
    stubRect(50, 60); // non-zero → visible
    const res = diagnoseCommentSubmit(document.body);
    expect(res.ok).toBe(true);
    expect(res.observed).toMatchObject({ box: true, wf: 1, en: 1, vis: 1 });
  });

  it("a zero-rect enabled submit reports en=1,vis=0 (the layout-race bucket)", () => {
    document.body.innerHTML = fx("reply-composer.html");
    enableSubmit();
    stubRect(0, 0, 0, 0); // every rect zero
    const res = diagnoseCommentSubmit(document.body);
    expect(res.observed).toMatchObject({ en: 1, vis: 0 });
    expect(res.observed?.top).toBe("Reply_zr");
  });
});

describe("readCommentBox (post-submit verification)", () => {
  it("reports a populated box as NOT posted (text still sitting there)", () => {
    document.body.innerHTML =
      "<div data-testid='tweetTextarea_0' contenteditable='true' role='textbox'>my reply that never landed</div>";
    const res = readCommentBox(document.body);
    expect(res.ok).toBe(true);
    expect(res.observed).toMatchObject({ present: true, empty: false });
  });

  it("reports an emptied box as posted (X cleared the composer)", () => {
    document.body.innerHTML = "<div data-testid='tweetTextarea_0' contenteditable='true' role='textbox'></div>";
    const res = readCommentBox(document.body);
    expect(res.observed).toMatchObject({ present: true, empty: true });
  });

  it("treats zero-width-space-only content as empty (posted)", () => {
    document.body.innerHTML = `<div data-testid='tweetTextarea_0' contenteditable='true' role='textbox'>${'\u200B'}</div>`;
    expect(readCommentBox(document.body).observed).toMatchObject({ empty: true });
  });

  it("reports a vanished composer as posted (present:false — the modal unmounted)", () => {
    document.body.innerHTML = "<div>composer gone after posting</div>";
    const res = readCommentBox(document.body);
    expect(res.ok).toBe(true);
    expect(res.observed).toMatchObject({ present: false, empty: true });
  });
});

describe("locateLikeTarget diagnostics + drift resistance", () => {
  it("the no-likeable skip reason carries btns + path diagnostics", () => {
    document.body.innerHTML = "<div>no tweets, no like buttons</div>";
    const res = locateLikeTarget(document.body, { preferWatchlist: false, watchlistNames: [] }, makeRng(1));
    expect(res.ok).toBe(false);
    // btns=0 (no like buttons anywhere) + a path= field so a skip row in the DB
    // says whether the timeline just wasn't loaded vs the tab was off-home.
    expect(res.skipReason).toMatch(/^no-likeable-tweet\(tweets=0,withBtn=0,btns=0,path=/);
  });

  it("likes the real tweet (not the ad) on drifted markup with no article wrappers", () => {
    document.body.innerHTML = fx("feed-drifted.html");
    stubRect(100, 200);
    const res = locateLikeTarget(document.body, { preferWatchlist: false, watchlistNames: [] }, makeRng(1));
    expect(res.ok).toBe(true);
    expect(res.observed?.tweet_id).toBe("1801000000000000001"); // Alice's, never BrandCo's ad
    expect(res.observed?.author_handle).toBe("alice");
  });
});

describe("locatePostLike (reply-also-likes)", () => {
  it("locates the FOCAL tweet's like button on the open status page", () => {
    document.body.innerHTML = fx("status-page.html");
    stubRect(30, 40);
    // The focal tweet has no self-permalink → the id lookup misses → the
    // permalink-less article is picked (never the reply below, which has one).
