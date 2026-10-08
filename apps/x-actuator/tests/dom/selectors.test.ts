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
    ))).toBe(true);
    expect(isPostUnavailable(mount(
      "<div><span>Hmm...this page doesn’t exist. Try searching for something else.</span></div>",
    ))).toBe(true);
    expect(isPostUnavailable(mount(
      "<div><span>This account doesn’t exist</span></div>",
    ))).toBe(true);
  });

  it("trusts [data-testid='error-detail'] unconditionally (structural signal)", () => {
    expect(isPostUnavailable(mount(
      "<div data-testid='error-detail'><span>Something went wrong. Try reloading.</span></div>",
    ))).toBe(true);
    // Even with a tweet article elsewhere on the page (e.g. sidebar content),
    // the dedicated error container is authoritative.
    expect(isPostUnavailable(mount(
      "<div data-testid='error-detail'><span>Hmm...this page doesn’t exist.</span></div>" +
      "<article data-testid='tweet'><div data-testid='tweetText'>trending tweet</div></article>",
    ))).toBe(true);
  });

  it("does not trip on an ordinary tweet", () => {
    expect(isPostUnavailable(mount(
      "<article data-testid='tweet'><div data-testid='tweetText'>shipping a deleted-branch cleaner today, protected by tests</div></article>",
    ))).toBe(false);
  });

  it("does NOT trip on a quote-tweet of a deleted post (tombstone inside a healthy target)", () => {
    // Everyday repliable target: the outer tweet is alive; the embedded quote
    // card renders the EXACT interstitial phrase. A positive here would fire a
    // durable markSkipped on a valid pending approval.
    expect(isPostUnavailable(mount(
      "<article data-testid='tweet'>" +
        "<div data-testid='tweetText'>lol what did it say</div>" +
        "<div role='link'><span>This post was deleted by the post author. <a>Learn more</a></span></div>" +
      "</article>",
    ))).toBe(false);
  });

  it("does NOT trip on thread prose mentioning deletion on a healthy permalink", () => {
    // A reply saying "this tweet has been deleted" (or quoting any interstitial
    // phrase) is ordinary prose; the page renders tweet articles, so the phrase
    // probe must not be trusted.
    expect(isPostUnavailable(mount(
      "<article data-testid='tweet'><div data-testid='tweetText'>original post</div></article>" +
      "<article data-testid='tweet'><div data-testid='tweetText'>this tweet has been deleted from my memory. these posts are protected by irony</div></article>",
    ))).toBe(false);
  });
});

describe("replyBoxText", () => {
  it("is null when no composer exists (posted → torn down, or never rendered)", () => {
    expect(replyBoxText(mount("<div>no composer here</div>"))).toBeNull();
  });

  it("reads the composer text, stripping zero-width residue", () => {
    const root = mount(composer("still sitting here"));
    expect(findReplyBox(root)).not.toBeNull();
    expect(replyBoxText(root)).toBe("still sitting here");
    // a "cleared" box that only holds editor residue must read as empty —
    // this is the posted-confirmation signal the background polls for
    expect(replyBoxText(mount(composer("​﻿")))).toBe("");
    expect(replyBoxText(mount(composer("")))).toBe("");
  });
});

const enableSubmit = (root: ParentNode) => {
  const btn = root.querySelector<HTMLButtonElement>("button[data-testid='tweetButtonInline']")!;
  btn.disabled = false;
  btn.removeAttribute("aria-disabled");
  return btn;
};

describe("findChallenge (tight — no false positives on normal content)", () => {
  it("is FALSE on a tweet that mentions verify/unusual/suspicious activity", () => {
    // Regression (#406): the old text probe halted valid runs on tweets that
    // merely used these words — and a challenge halt arms the multi-day
    // auto-start cooldown, so one stray tweet cost days of autonomy.
    expect(findChallenge(mount(fx("reply-composer.html")))).toBe(false);
    expect(
      findChallenge(mount("<article data-testid='tweet'>Please verify your identity — suspicious, your account has been locked they said</article>")),
    ).toBe(false);
  });

  it("is FALSE on an ad iframe that merely contains 'captcha' in the src", () => {
    // The old generic iframe[src*='captcha'] scan was the ad-iframe
    // false-positive channel (#407); only the actual vendors are trusted.
    expect(findChallenge(mount("<iframe src='https://ads.example.com/nocaptcha-banner'></iframe>"))).toBe(false);
  });

  it("is TRUE on a real captcha vendor iframe (arkose / funcaptcha)", () => {
    expect(findChallenge(mount("<iframe src='https://client-api.arkoselabs.com/v2/enforcement'></iframe>"))).toBe(true);
    expect(findChallenge(mount("<iframe src='https://x.com/x/funcaptcha/frame'></iframe>"))).toBe(true);
  });

  it("is TRUE on the /account/access lock interstitial URL", () => {
    history.pushState({}, "", "/account/access");
    try {
      expect(findChallenge(mount("<div>anything</div>"))).toBe(true);
    } finally {
      history.pushState({}, "", "/");
    }
  });
});

describe("findReplySubmit (testid fast path)", () => {
  it("returns null while the inline submit is DISABLED (wait, never a no-op click)", () => {
    // X keeps tweetButtonInline disabled until the editor model registers
    // text; clicking a disabled hit is a silent no-op phantom (#407).
    expect(findReplySubmit(mount(fx("reply-composer.html")))).toBeNull();
  });

  it("returns the enabled inline submit, via testid", () => {
    const root = mount(fx("reply-composer.html"));
    enableSubmit(root);
    const hit = findReplySubmitInfo(root);
    expect(hit?.el.getAttribute("data-testid")).toBe("tweetButtonInline");
    expect(hit?.via).toBe("testid:tweetButtonInline");
  });

  it("finds the modal composer's tweetButton too", () => {
    const hit = findReplySubmitInfo(
      mount("<div role='dialog'><div data-testid='tweetTextarea_0' contenteditable='true' role='textbox'></div><button data-testid='tweetButton' type='button'>Reply</button></div>"),
    );
    expect(hit?.via).toBe("testid:tweetButton");
  });

  it("never returns the action-bar reply icon or the DM Send while the submit is disabled", () => {
    const root = mount(fx("reply-composer.html"));
    // Decoys ARE present — the test is meaningful.
    expect(root.querySelector("button[data-testid='reply']")).not.toBeNull();
    expect(root.querySelector("button[data-testid='dmComposerSendButton']")).not.toBeNull();
    expect(findReplySubmit(root)).toBeNull();
  });
});

describe("findReplySubmit — composer-anchored fallback (testid renamed)", () => {
  const renameTestid = (root: ParentNode) => {
    root.querySelector("button[data-testid='tweetButtonInline']")!.removeAttribute("data-testid");
  };

  it("recovers the worded submit through the composer climb when both testids are gone", () => {
    const root = mount(fx("reply-composer.html"));
    const btn = enableSubmit(root);
    renameTestid(root);
    const hit = findReplySubmitInfo(root);
    expect(hit?.el).toBe(btn);
    expect(hit?.via).toMatch(/^composer:\d+$/);
  });

  it("waits (null) on a disabled submit instead of widening toward decoys", () => {
    const root = mount(fx("reply-composer.html"));
    renameTestid(root); // still disabled
    expect(findReplySubmit(root)).toBeNull();
  });

  it("never returns the DM drawer's Send (type=submit) when the composer has no submit", () => {
    const root = mount(fx("reply-composer.html"));
    root.querySelector("button[data-testid='tweetButtonInline']")!.remove();
    expect(findReplySubmit(root)).toBeNull();
  });

  it("rejects an aria-'Reply' icon whose visible text is only a count (shape rule)", () => {
    // A hook-less action-bar icon: wordy via aria, count-only text. It follows
    // the box, so only the shape rule keeps it out.
    const root = mount(
      "<div><div data-testid='tweetTextarea_0' contenteditable='true' role='textbox'>typed</div>" +
        "<button type='button' class='_icon' aria-label='Reply'><span>12</span></button></div>",
    );
    root.querySelector("button")!.textContent = "12";
    expect(findReplySubmit(root)).toBeNull();
  });

  it("accepts an unworded type=submit following the box — unless its name is a different action", () => {
    const ok = mount(
      "<div><div data-testid='tweetTextarea_0' contenteditable='true' role='textbox'>typed</div>" +
        "<button type='submit' class='_sub'><svg></svg></button></div>",
    );
    expect(findReplySubmit(ok)?.className).toBe("_sub");
    const send = mount(
      "<div><div data-testid='tweetTextarea_0' contenteditable='true' role='textbox'>typed</div>" +
        "<button type='submit' class='_send' aria-label='Send'><svg></svg></button></div>",
    );
    // 'Send' would post a DM — the NONREPLY name guard keeps it out even when
    // DM testids are obfuscated away from DM_SEL.
    expect(findReplySubmit(send)).toBeNull();
  });

  it("worded submit wins the tiebreak over an unworded type=submit", () => {
    const root = mount(
      "<div><div data-testid='tweetTextarea_0' contenteditable='true' role='textbox'>x</div>" +
        "<button type='submit' class='_icon'></button>" +
        "<button type='button' class='_reply'>Reply</button></div>",
    );
    expect(findReplySubmit(root)?.className).toBe("_reply");
  });

  it("never returns the left-nav 'Post' compose button (precedes the box)", () => {
    const root = mount(
      "<header><button data-testid='SideNav_NewTweet_Button' type='button'>Post</button></header>" +
        "<main><div data-testid='tweetTextarea_0' contenteditable='true' role='textbox'>typed</div></main>",
    );
    expect(findReplySubmit(root)).toBeNull();
  });

  it("never returns a wordy button inside a tweet article (per-tweet affordance)", () => {
    const root = mount(
      "<div><div data-testid='tweetTextarea_0' contenteditable='true' role='textbox'>typed</div>" +
        "<article data-testid='tweet'><button type='button'>Reply</button></article></div>",
    );
    expect(findReplySubmit(root)).toBeNull();
  });

  it("returns null when there is no composer at all", () => {
    expect(findReplySubmit(mount("<div>nothing</div>"))).toBeNull();
  });
});

describe("replyBoxText (post-submit verification signal)", () => {
  it("reads '' from an empty composer (the DraftJS placeholder is outside the box)", () => {
    const root = mount(fx("reply-composer.html"));
    expect(replyBoxText(root)).toBe("");
  });

  it("returns the trimmed typed text", () => {
    const root = mount(fx("reply-composer.html"));
    findReplyBox(root)!.textContent = "  my reply  ";
    expect(replyBoxText(root)).toBe("my reply");
  });

  it("strips zero-width space / BOM the editor can leave behind", () => {
    const root = mount(fx("reply-composer.html"));
    findReplyBox(root)!.textContent = "\u200B\uFEFF";
    expect(replyBoxText(root)).toBe("");
  });

  it("returns null when there is no composer at all", () => {
    expect(replyBoxText(mount("<div>no composer</div>"))).toBeNull();
  });
});

describe("diagnoseReplySubmit (splits the submit-not-found causes)", () => {
  const noZero = () => false; // every element has a real box
  const allZero = () => true; // every element measures zero (no layout)

  it("enabled composer submit → wf=1,en=1,vis=1 (should have been found)", () => {
    const root = mount(fx("reply-composer.html"));
    enableSubmit(root);
    const d = diagnoseReplySubmit(root, noZero);
    expect(d).toMatchObject({ box: true, wf: 1, en: 1, vis: 1 });
    expect(d.top).toBe("Reply_ok");
  });

  it("disabled submit → wf=1,en=0 and top names it disabled (the enable-lag race)", () => {
    const d = diagnoseReplySubmit(mount(fx("reply-composer.html")), noZero);
    expect(d).toMatchObject({ wf: 1, en: 0, vis: 0 });
    expect(d.top).toBe("Reply_dis");
  });

  it("enabled but zero-rect → en=1,vis=0 and top flags the layout skip", () => {
    const root = mount(fx("reply-composer.html"));
    enableSubmit(root);
    const d = diagnoseReplySubmit(root, allZero);
    expect(d).toMatchObject({ wf: 1, en: 1, vis: 0 });
    expect(d.top).toBe("Reply_zr");
  });

  it("submit removed → wf=0 while the region dump still shows the page's buttons", () => {
    const root = mount(fx("reply-composer.html"));
    root.querySelector("button[data-testid='tweetButtonInline']")!.remove();
    const d = diagnoseReplySubmit(root, noZero);
    expect(d.wf).toBe(0);
    expect(d.region.length).toBeGreaterThan(0);
  });

  it("dom descriptor captures the editor + submit state (sanitizer-safe)", () => {
    const root = mount(fx("reply-composer.html"));
    enableSubmit(root);
    const d = diagnoseReplySubmit(root, noZero);
    // The box is the DraftJS contenteditable inside tweetTextarea_0 → pm=1.
    expect(d.dom).toMatch(/\bbx_div\b/);
    expect(d.dom).toMatch(/\bpm_1\b/);
    expect(d.dom).toMatch(/\blen_0\b/);
    // Two contenteditables on the page (reply composer + DM drawer input).
    expect(d.dom).toMatch(/\bnce_2\b/);
    expect(d.dom).toMatch(/\bdis_false\b/);
    // Only sanitizer-safe characters so it survives into the reason verbatim.
    expect(d.dom).toMatch(/^[A-Za-z0-9 _-]+$/);
  });

  it("no box at all → box=false,wf=0", () => {
    const d = diagnoseReplySubmit(mount("<div>nothing here</div>"), noZero);
    expect(d.box).toBe(false);
    expect(d.wf).toBe(0);
  });
});

describe("findFeedTweets container fallback (wrapper-drift resistance)", () => {
  it("recovers every tweet from its like buttons when the article selector misses", () => {
    document.body.innerHTML = fx("feed-drifted.html");
    // Zero article[data-testid='tweet'] — the direct selector finds nothing…
    expect(document.querySelectorAll("article[data-testid='tweet']").length).toBe(0);
    // …but the fallback climbs from the 2 like buttons to 2 tweet containers.
    const tweets = findFeedTweets(document.body);
    expect(tweets).toHaveLength(2);
    // Each climbed container is tweet-sized: it wraps exactly one like button.
    for (const t of tweets) expect(findLikeButtons(t)).toHaveLength(1);
  });

  it("keeps downstream extractors working on the climbed containers", () => {
    document.body.innerHTML = fx("feed-drifted.html");
    const tweets = findFeedTweets(document.body);
    const real = tweets.find((t) => !isPromoted(t))!;
    expect(real).toBeDefined();
    expect(tweetId(real)).toBe("1801000000000000001");
    expect(tweetAuthorHandle(real)).toBe("alice");
    expect(findLikeButton(real)).not.toBeNull();
  });

  it("STILL detects the ad on the climbed container (the failure the promoted bias prevents)", () => {
    document.body.innerHTML = fx("feed-drifted.html");
    const tweets = findFeedTweets(document.body);
    const promoted = tweets.filter((t) => isPromoted(t));
    expect(promoted).toHaveLength(1);
    expect(tweetId(promoted[0]!)).toBe("1801000000000000009");
  });

  it("does NOT fire the fallback when the article selector matches", () => {
    document.body.innerHTML = fx("status-page.html"); // real article[data-testid='tweet'] markup
    const tweets = findFeedTweets(document.body);
    expect(tweets).toHaveLength(2);
    for (const t of tweets) expect(t.tagName).toBe("ARTICLE");
  });
});
