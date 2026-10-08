// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { locateLikeTarget } from "../../src/content/locators.js";
import { makeRng } from "../../src/lib/rng.js";

// Regression: every rect locateLikeTarget returns must be measured AFTER its
// own scrollIntoView. The in-view filter admits tweets up to 1.4*viewport
// below the fold, so centering the like button can move the page by hundreds
// of px; the background fires trusted CDP clicks straight at these rects (the
// expand branch clicks observed.seeMoreRect with no re-locate), so a rect
// measured pre-scroll lands the click on a DIFFERENT tweet's text, a link, or
// a Follow button on live x.com.
//
// The simulation: getBoundingClientRect returns pre-scroll viewport coords
// until scrollIntoView fires, then everything shifts up by SCROLL_DELTA —
// exactly what a real scrollIntoView does to client rects.

const PRE_TOP = 900; // below the fold (innerHeight 768) but inside the 1.4*vh admit window
const SCROLL_DELTA = 600;
// Offsets of each element inside the tweet card.
const OFFSETS: Record<string, number> = {
  "tweet-text-show-more-link": 40,
  like: 80,
};

let scrolled: boolean;

function rectFor(el: HTMLElement): DOMRect {
  const offset = OFFSETS[el.getAttribute("data-testid") ?? ""] ?? 0;
  const y = PRE_TOP + offset - (scrolled ? SCROLL_DELTA : 0);
  const x = 100;
  const w = 40;
  const h = 20;
  return {
    x, y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h, toJSON: () => ({}),
  } as DOMRect;
}

const TRUNCATED_TWEET = `
  <article data-testid="tweet">
    <div data-testid="User-Name"><span>Nora Kim</span><span>@norakim</span><span>· 2h</span></div>
    <a href="/norakim/status/1800000000000000001"><time datetime="2026-07-10T20:00:00.000Z">2h</time></a>
    <div data-testid="tweetText">a long collapsed tweet body that x truncated behind an expander</div>
    <a data-testid="tweet-text-show-more-link" role="link">Show more</a>
    <div role="group">
      <button data-testid="reply" aria-label="Reply" type="button">3</button>
      <button data-testid="like" aria-label="Like" type="button">12</button>
    </div>
  </article>`;

beforeEach(() => {
  scrolled = false;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return rectFor(this);
  });
  // jsdom has no scrollIntoView; model the one thing it does to client rects.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: () => { scrolled = true; },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

describe("locateLikeTarget stale-rect discipline (scroll first, measure after)", () => {
  it("measures seeMoreRect AFTER scrollIntoView — never a pre-scroll rect", () => {
    document.body.innerHTML = TRUNCATED_TWEET;
    const res = locateLikeTarget(document.body, { preferWatchlist: false, watchlistNames: [] }, makeRng(1));
    expect(res.ok).toBe(true);
    expect(scrolled).toBe(true); // the locate did scroll
    expect(res.observed?.isTruncated).toBe(true);
    const seeMoreRect = res.observed?.seeMoreRect as { x: number; y: number } | undefined;
    expect(seeMoreRect).toBeDefined();
    // Post-scroll coordinates: PRE_TOP + offset - SCROLL_DELTA. A pre-scroll
    // measurement would report y=940 — 600px off, on a different tweet.
    expect(seeMoreRect!.y).toBe(PRE_TOP + 40 - SCROLL_DELTA);
    expect(seeMoreRect!.y).not.toBe(PRE_TOP + 40);
  });

  it("the like rect and seeMoreRect agree on the same (post-scroll) viewport", () => {
    document.body.innerHTML = TRUNCATED_TWEET;
    const res = locateLikeTarget(document.body, { preferWatchlist: false, watchlistNames: [] }, makeRng(1));
    expect(res.ok).toBe(true);
    const seeMoreRect = res.observed?.seeMoreRect as { y: number };
    // Both rects must be measured in the same scroll state: their vertical gap
    // is the in-card offset (80 - 40), not the offset ± the scroll delta.
    expect(res.rect!.y - seeMoreRect.y).toBe(OFFSETS["like"]! - OFFSETS["tweet-text-show-more-link"]!);
    expect(res.rect!.y).toBe(PRE_TOP + 80 - SCROLL_DELTA);
  });

  it("emits no seeMoreRect for a non-truncated tweet", () => {
    document.body.innerHTML = TRUNCATED_TWEET;
    document.querySelector("[data-testid='tweet-text-show-more-link']")!.remove();
    const res = locateLikeTarget(document.body, { preferWatchlist: false, watchlistNames: [] }, makeRng(1));
    expect(res.ok).toBe(true);
    expect(res.observed?.isTruncated).toBe(false);
    expect(res.observed?.seeMoreRect).toBeUndefined();
  });
});
