// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { locateEngagement, locateRepostConfirm } from "../../src/content/locators.js";
import {
  findBookmarkButton, findRetweetButton, findRetweetConfirm,
} from "../../src/content/selectors.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => readFileSync(join(here, "..", "fixtures", n), "utf8");

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

// jsdom doesn't lay out, so getBoundingClientRect returns zeros — stub it so the
// coordinate logic is exercised deterministically.
function stubRect(x: number, y: number, w = 40, h = 20) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x, y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h, toJSON: () => ({}),
  } as DOMRect);
}

const TID = "1800000000000000001";

describe("engagement action-bar selectors", () => {
  it("findBookmarkButton / findRetweetButton resolve their action-bar buttons", () => {
    const root = mount(fx("tweet-actionbar.html"));
    const tweet = root.querySelector("article[data-testid='tweet']")!;
    expect(findBookmarkButton(tweet)?.getAttribute("data-testid")).toBe("bookmark");
    expect(findRetweetButton(tweet)?.getAttribute("data-testid")).toBe("retweet");
  });

  it("findRetweetConfirm resolves the confirm item by testid, null when the menu is gone", () => {
    expect(findRetweetConfirm(mount(fx("tweet-actionbar.html")))?.getAttribute("data-testid")).toBe("retweetConfirm");
    // Remove the menu → no confirm.
    const root = mount(fx("tweet-actionbar.html"));
    root.querySelector("[role='menu']")!.remove();
    expect(findRetweetConfirm(root)).toBeNull();
  });

  it("findRetweetConfirm falls back to the 'Repost' menuitem when testid is gone (never grabs Quote)", () => {
    const root = mount(`
      <div role="menu">
        <div role="menuitem">Quote</div>
        <div role="menuitem">Repost</div>
      </div>`);
    const btn = findRetweetConfirm(root);
    expect(btn?.textContent).toBe("Repost");
    expect(btn?.textContent).not.toBe("Quote");
  });
});

describe("locateEngagement (varied engagement on a specific tweet)", () => {
  it("locates the bookmark button on the tweet matched by tweet_id", () => {
    document.body.innerHTML = fx("tweet-actionbar.html");
    stubRect(300, 150);
    const res = locateEngagement(document.body, "bookmark", TID);
    expect(res.ok).toBe(true);
    expect(res.rect).toEqual({ x: 300, y: 150, width: 40, height: 20 });
    expect(res.observed?.engagement).toBe("bookmark");
  });

  it("locates the repost (retweet) button too", () => {
    document.body.innerHTML = fx("tweet-actionbar.html");
    stubRect(340, 150);
    expect(locateEngagement(document.body, "repost", TID).ok).toBe(true);
  });

  it("re-locates the like (heart) on the tweet by id — the FRESH-rect fallback path", () => {
    // After a repost-confirm miss (or a "Show more" reflow) the background must
    // re-measure the heart instead of clicking the pre-scroll rect; this is the
    // locator that serves that fresh rect.
    document.body.innerHTML = fx("tweet-actionbar.html");
    stubRect(260, 150);
    const res = locateEngagement(document.body, "like", TID);
    expect(res.ok).toBe(true);
    expect(res.rect).toEqual({ x: 260, y: 150, width: 40, height: 20 });
    expect(res.observed?.engagement).toBe("like");
  });

  it("like re-locate misses when the heart is gone (already liked → testid swapped)", () => {
    document.body.innerHTML = fx("tweet-actionbar.html");
    document.querySelector("button[data-testid='like']")!.setAttribute("data-testid", "unlike");
    const res = locateEngagement(document.body, "like", TID);
    expect(res.ok).toBe(false);
    expect(res.skipReason).toBe("engagement-not-found(like)");
  });

  it("skips (→ caller falls back to a plain like) when the tweet_id is unknown/absent", () => {
    document.body.innerHTML = fx("tweet-actionbar.html");
    expect(locateEngagement(document.body, "bookmark", null).ok).toBe(false);
    const gone = locateEngagement(document.body, "bookmark", "999");
    expect(gone.ok).toBe(false);
    expect(gone.skipReason).toBe("engagement-tweet-gone(bookmark)");
  });
});

describe("locateRepostConfirm", () => {
  it("returns the confirm item's rect when the menu is open", () => {
    document.body.innerHTML = fx("tweet-actionbar.html");
    stubRect(200, 260);
    const res = locateRepostConfirm(document.body);
    expect(res.ok).toBe(true);
    expect(res.rect).toEqual({ x: 200, y: 260, width: 40, height: 20 });
  });

  it("skips (→ caller falls back to a plain like) when the menu isn't open", () => {
    document.body.innerHTML = `<article data-testid="tweet"><div role="group"></div></article>`;
    const res = locateRepostConfirm(document.body);
    expect(res.ok).toBe(false);
    expect(res.skipReason).toBe("repost-confirm-not-found");
  });
});
