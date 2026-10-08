// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  findFeedTweets, findLikeButton, findLikeButtons, isPromoted, tweetId, tweetAuthorHandle,
  findChallenge, findReplyBox, findReplySubmit, findReplySubmitInfo, replyBoxText,
  diagnoseReplySubmit, isPostUnavailable, isReplyRestricted,
} from "../../src/content/selectors.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string) => readFileSync(join(here, "..", "fixtures", name), "utf8");

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

/** A healthy /status/ permalink: focal tweet + mounted reply composer. */
const liveTweetPage = (text: string) => `
  <div data-testid="primaryColumn">
    <article data-testid="tweet">
      <div data-testid="User-Name"><span>Jane Doe</span><span>@jane</span></div>
      <div data-testid="tweetText">${text}</div>
      <button data-testid="reply"></button>
      <button data-testid="like"></button>
    </article>
    <div data-testid="tweetTextarea_0" contenteditable="true" role="textbox"></div>
  </div>`;

describe("isPostUnavailable (dead /status/ permalink)", () => {
  it("is TRUE on the 404 error-detail page", () => {
    expect(isPostUnavailable(mount(fx("post-unavailable.html")))).toBe(true);
  });

  it("is TRUE on the deleted-post tombstone / gone-account text variants", () => {
    expect(
      isPostUnavailable(mount("<main><div data-testid='cellInnerDiv'>This Post was deleted by the Post author. Learn more</div></main>")),
    ).toBe(true);
    // Typographic apostrophe, no error-detail testid — the phrase alone must trip.
    expect(
      isPostUnavailable(mount("<main><span>Hmm...this page doesn’t exist. Try searching for something else.</span></main>")),
    ).toBe(true);
    expect(
      isPostUnavailable(mount("<main><span>Account suspended</span> <span>X suspends accounts that violate the X Rules.</span></main>")),
    ).toBe(true);
  });

  it("is FALSE on a live tweet permalink (no false positive)", () => {
    expect(isPostUnavailable(mount(liveTweetPage("Shipping a new feature today — thread below.")))).toBe(false);
  });

  it("is FALSE on a live tweet that merely QUOTES the dead-page phrases", () => {
    expect(
      isPostUnavailable(
        mount(liveTweetPage("lol X told me \"Hmm...this page doesn't exist\" and \"This post was deleted by the post author\" again")),
      ),
    ).toBe(false);
  });

  it("is FALSE on a slow, still-hydrating page (no tweets yet, no error cell)", () => {
    expect(isPostUnavailable(mount("<div data-testid='primaryColumn'><div role='progressbar'></div></div>"))).toBe(false);
  });

  // REGRESSION: X renders the exact tombstone copy as a standalone cell (NOT
  // inside an article) on HEALTHY conversation pages — a deleted PARENT above a
  // live focal reply, or a deleted mid-thread reply below it. The phrase probe
  // must stand down whenever any live tweet is rendered, or a valid approved
  // reply gets durably markSkipped.
  it("is FALSE when a deleted-PARENT tombstone cell sits above a LIVE focal tweet", () => {
    expect(
      isPostUnavailable(
        mount(`
          <div data-testid="primaryColumn">
            <div data-testid="cellInnerDiv">This Post was deleted by the Post author. Learn more</div>
            <article data-testid="tweet">
              <div data-testid="tweetText">Replying to the thread above — still here!</div>
              <button data-testid="reply"></button>
            </article>
            <div data-testid="tweetTextarea_0" contenteditable="true" role="textbox"></div>
          </div>`),
      ),
    ).toBe(false);
  });

  it("is FALSE when a deleted mid-thread reply's tombstone sits BELOW the live focal tweet", () => {
    expect(
      isPostUnavailable(
        mount(`
          <div data-testid="primaryColumn">
            <article data-testid="tweet">
              <div data-testid="tweetText">The focal tweet, alive and well.</div>
              <button data-testid="reply"></button>
            </article>
            <div data-testid="tweetTextarea_0" contenteditable="true" role="textbox"></div>
            <div data-testid="cellInnerDiv">This Post is unavailable.</div>
            <article data-testid="tweet">
              <div data-testid="tweetText">A surviving child reply below the tombstone.</div>
            </article>
          </div>`),
      ),
    ).toBe(false);
  });

  it("is TRUE on [data-testid='error-detail'] even with a tweet rendered (structural cell trusted unconditionally)", () => {
    expect(
      isPostUnavailable(
        mount(`
          <div data-testid="primaryColumn">
            <div data-testid="error-detail"><span>Hmm...this page doesn’t exist.</span></div>
            <article data-testid="tweet"><div data-testid="tweetText">stray cached tweet</div></article>
          </div>`),
      ),
    ).toBe(true);
  });
});

describe("isReplyRestricted ('Who can reply?' limited-reply post)", () => {
  it("is TRUE on the restricted permalink (disabled reply icon + banner, no composer)", () => {
    expect(isReplyRestricted(mount(fx("reply-restricted.html")))).toBe(true);
  });

  it("is TRUE on the structural signal alone (disabled focal reply icon, no composer)", () => {
    expect(
      isReplyRestricted(
        mount(
          "<article data-testid='tweet'><div data-testid='tweetText'>quiet post</div><button data-testid='reply' disabled></button></article>",
        ),
      ),
    ).toBe(true);
  });

  it("is TRUE on the 'Only accounts … can reply' banner variant", () => {
    expect(
      isReplyRestricted(mount("<main><div data-testid='cellInnerDiv'>Only accounts @jane follows can reply</div></main>")),
    ).toBe(true);
  });

  it("is FALSE on a normal permalink with an open composer (no false positive)", () => {
    expect(isReplyRestricted(mount(liveTweetPage("Shipping a new feature today — thread below.")))).toBe(false);
  });

  it("is FALSE on a live tweet that merely QUOTES the restriction phrases", () => {
    // Enabled reply icon + mounted composer; the phrases live INSIDE the tweet body.
    expect(
      isReplyRestricted(mount(liveTweetPage("X's \"Who can reply?\" setting means only people I mentioned can reply — wild feature"))),
    ).toBe(false);
  });

  // REGRESSION: X shows the "Who can reply?" banner to ELIGIBLE repliers too
  // (accounts the author mentioned/follows) — with the composer mounted. A
  // mounted composer means this account CAN reply; the phrase branch must not
  // durably skip a reply Vega could have posted.
  it("is FALSE when the 'Who can reply?' banner shows but the composer IS mounted (eligible replier)", () => {
    expect(
      isReplyRestricted(
        mount(`
          <div data-testid="primaryColumn">
            <article data-testid="tweet">
              <div data-testid="tweetText">Limited-reply post, but we're mentioned.</div>
              <button data-testid="reply"></button>
            </article>
            <div data-testid="cellInnerDiv">
              <span>Who can reply?</span>
              <span>People @jane mentioned can reply</span>
            </div>
            <div data-testid="tweetTextarea_0" contenteditable="true" role="textbox"></div>
          </div>`),
      ),
    ).toBe(false);
  });

  it("is FALSE with a mounted composer even if a disabled reply icon exists elsewhere on the page", () => {
    // Composer-mounted gate must also win over the structural branch.
    expect(
      isReplyRestricted(
        mount(`
          <div data-testid="primaryColumn">
            <article data-testid="tweet">
              <div data-testid="tweetText">focal</div>
              <button data-testid="reply" aria-disabled="true" disabled></button>
            </article>
            <div data-testid="tweetTextarea_0" contenteditable="true" role="textbox"></div>
          </div>`),
      ),
    ).toBe(false);
  });
});

const composer = (text: string) =>
  `<div data-testid='tweetTextarea_0' contenteditable='true' role='textbox'>${text}</div>`;

describe("isPostUnavailable", () => {
  it("detects X's dead-target interstitials (phrase probe, no tweet articles on the page)", () => {
    expect(isPostUnavailable(mount(
      "<div><span>This post was deleted by the post author. <a>Learn more</a></span></div>",
    ))).toBe(true);
    expect(isPostUnavailable(mount(
      "<div><span>These posts are protected. Only approved followers can see them.</span></div>",
