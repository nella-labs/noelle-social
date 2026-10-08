// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { harvestVisibleTweets } from "../../src/content/discovery.js";
import { isPromoted } from "../../src/content/selectors.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, "..", "fixtures", "feed-current.html"), "utf8");
const statusFixture = readFileSync(join(here, "..", "fixtures", "status-discovery-current.html"), "utf8");
const focalUrl = "https://x.com/levie/status/2101427997597446636";

describe("X browser discovery", () => {
  const rect = Element.prototype.getBoundingClientRect;
  beforeEach(() => {
    Element.prototype.getBoundingClientRect = function () {
      return { top: 0, bottom: 500, left: 0, right: 500, width: 500, height: 500, x: 0, y: 0, toJSON() { return {}; } };
    };
  });
  afterEach(() => { Element.prototype.getBoundingClientRect = rect; });

  it.each(["feed", "focal"])("preserves the raw %s source date for server calendar validation", (surface) => {
    document.body.innerHTML = surface === "feed" ? fixture : statusFixture;
    const rawDate = "2026-02-30T10:00:00Z";
    document.querySelector("article time[datetime]")!.setAttribute("datetime", rawDate);
    const posts = harvestVisibleTweets(document.body, "demooperator2", surface === "feed" ? "https://x.com/home" : focalUrl);
    expect(posts[0]?.postedAt).toBe(rawDate);
  });

  it("extracts the primary full text, author, canonical ID, date, likes and replies from the current feed", () => {
    document.body.innerHTML = fixture;
    expect(harvestVisibleTweets(document.body)).toEqual([{
      tweetId: "2101481430098288767",
      url: "https://x.com/jackfriks/status/2101481430098288767",
      text: "brb adding $10K MRR to my b2b SaaS overnight\nthe implementation is finally working",
      authorHandle: "jackfriks",
      authorName: "jack friks",
      postedAt: "2026-09-20T01:19:51.000Z",
      likeCount: 40,
      replyCount: 7,
    }]);
  });

  it("extracts the focal post from a permalink when its timestamp link is outside User-Name", () => {
    document.body.innerHTML = statusFixture;
    expect(harvestVisibleTweets(document.body, "demooperator2", focalUrl)).toEqual([{
      tweetId: "2101427997597446636",
      url: focalUrl,
      text: "Building something useful takes more than a clever demo.\nThe product has to keep working after the first customer tries it, and after the hundredth customer brings a different workflow.",
      authorHandle: "levie",
      authorName: "Aaron Levie",
      postedAt: "2026-09-19T21:47:31.000Z",
      likeCount: 254,
      replyCount: 40,
    }]);
  });

  it("does not treat a quoted focal link in another post as the permalink's primary post", () => {
    document.body.innerHTML = `<div data-testid="SideNav_AccountSwitcher_Button"><span>@self</span></div>
      <article data-testid="tweet"><div data-testid="User-Name"><a href="/other"><span>Other</span></a><a href="/other"><span>@other</span></a></div>
      <div data-testid="tweetText">This is a separate conversation reply.</div>
      <div data-testid="quoteTweet"><a href="/levie/status/2101427997597446636"><time datetime="2026-09-19T21:47:31.000Z">Quoted</time></a></div></article>`;
    expect(harvestVisibleTweets(document.body, "self", focalUrl)).toEqual([]);
  });

  it("does not use a same-author quote as the focal status anchor", () => {
    document.body.innerHTML = `<div data-testid="SideNav_AccountSwitcher_Button"><span>@self</span></div>
      <article data-testid="tweet"><div data-testid="User-Name"><a href="/levie"><span>Aaron Levie</span></a><a href="/levie"><span>@levie</span></a></div>
      <div data-testid="tweetText">A different post by the same author.</div>
      <div data-testid="quoteTweet"><a href="/levie/status/2101427997597446636"><time datetime="2026-09-19T21:47:31.000Z">Quoted</time></a></div></article>`;
    expect(harvestVisibleTweets(document.body, "self", focalUrl)).toEqual([]);
  });

  it("does not infer a permalink identity while reading a feed", () => {
    document.body.innerHTML = statusFixture;
    expect(harvestVisibleTweets(document.body, "demooperator2", "https://x.com/home")).toEqual([]);
  });

  it("skips search cards with a separate Replying to account banner", () => {
    document.body.innerHTML = `${fixture}
      <article data-testid="tweet">
        <div data-testid="User-Name"><a href="/daenbnb"><span>Dae</span></a><a href="/daenbnb"><span>@daenbnb</span></a><a href="/daenbnb/status/2101473890057003190"><time datetime="2026-09-19T23:00:00.000Z">1h</time></a></div>
        <div class="css-g5y9jx r-4qtqp9 r-zl2h9q"><div dir="ltr" id="id__577tc6ds00j">Replying to <div><a href="/tramy2468">@tramy2468</a></div> <span>and</span> <div><a href="/TermixAi">@TermixAi</a></div></div></div>
        <div class="css-g5y9jx"><div dir="auto" data-testid="tweetText">Spot on! This is a reply without its parent context.</div></div>
        <div role="group" aria-label="1 reply, 10 likes"></div>
      </article>`;
    expect(harvestVisibleTweets(document.body).map((item) => item.tweetId)).toEqual(["2101481430098288767"]);
  });

  it("keeps posts that mention Replying to only in their own body or a quoted post", () => {
    document.body.innerHTML = fixture;
    const normal = document.querySelector("article[data-testid='tweet']")!;
    normal.querySelector("[data-testid='tweetText']")!.textContent = "Replying to @alice can be useful advice.";
    normal.querySelector("[data-testid='quoteTweet']")!.insertAdjacentHTML("afterbegin", '<div dir="ltr">Replying to <a href="/bob">@bob</a></div>');
    expect(harvestVisibleTweets(document.body).map((item) => item.tweetId)).toEqual(["2101481430098288767"]);
  });

  it("does not mistake ordinary placement tracking for an Ad, but rejects exact Ad labels", () => {
    document.body.innerHTML = fixture;
    const [normal, ad] = document.querySelectorAll("article[data-testid='tweet']");
    expect(isPromoted(normal!)).toBe(false);
    expect(isPromoted(ad!)).toBe(true);
  });

  it("keeps unknown and old post times eligible without date arithmetic", () => {
    document.body.innerHTML = `<div data-testid="SideNav_AccountSwitcher_Button"><span>@self</span></div>
      <article data-testid="tweet"><div data-testid="User-Name"><a href="/alice"><span>Alice</span></a><a href="/alice/status/2101481430098288769">link</a></div><div data-testid="tweetText">Old but useful</div><button data-testid="reply" aria-label="0 Replies. Reply"></button><button data-testid="like" aria-label="1 Like. Like"></button></article>
      <article data-testid="tweet"><div data-testid="User-Name"><a href="/bob"><span>Bob</span></a><a href="/bob/status/2101481430098288770"><time datetime="2026-09-19T19:00:00.000Z">6h</time></a></div><div data-testid="tweetText">Still useful later</div><button data-testid="reply" aria-label="2 Replies. Reply"></button><button data-testid="like" aria-label="10 Likes. Like"></button></article>`;
    const items = harvestVisibleTweets(document.body);
    expect(items).toHaveLength(2);
    expect(items[0]?.postedAt).toBeUndefined();
    expect(items[1]?.postedAt).toBe("2026-09-19T19:00:00.000Z");
  });

  it("only takes visible complete cards once", () => {
    document.body.innerHTML = fixture;
    const first = document.querySelector("article")!;
    const clone = first.cloneNode(true);
    first.after(clone);
    const hidden = first.cloneNode(true) as Element;
    hidden.querySelector("a[href*='/status/']")?.setAttribute("href", "/jackfriks/status/2101481430098288771");
    first.after(hidden);
    const noId = first.cloneNode(true) as Element;
    noId.querySelectorAll("a[href*='/status/']").forEach((a) => a.remove());
    first.after(noId);
    Element.prototype.getBoundingClientRect = function () {
      const outside = this === hidden;
      return { top: outside ? 10000 : 0, bottom: outside ? 10500 : 500, left: 0, right: 500, width: 500, height: 500, x: 0, y: outside ? 10000 : 0, toJSON() { return {}; } };
    };
    expect(harvestVisibleTweets(document.body)).toHaveLength(1);
  });

  it("does not confuse a quoted status link with the outer post identity", () => {
    document.body.innerHTML = `<div data-testid="SideNav_AccountSwitcher_Button"><span>@self</span></div>
      <article data-testid="tweet"><div data-testid="User-Name"><a href="/alice">Alice</a><a href="/alice">@alice</a></div>
      <div data-testid="tweetText">My words</div>
      <div data-testid="quoteTweet"><div data-testid="User-Name"><a href="/bob/status/2101481430098288772"><time datetime="2026-09-20T01:00:00.000Z">1h</time></a></div><div data-testid="tweetText">Quoted words</div></div></article>`;
    expect(harvestVisibleTweets(document.body)).toEqual([]);
  });

  it("pauses extraction if the signed-in handle is unknown", () => {
    document.body.innerHTML = fixture.replace(/<div data-testid="SideNav_AccountSwitcher_Button">.*?<\/div>/, "");
    expect(harvestVisibleTweets(document.body)).toEqual([]);
  });

  it("waits for Show more instead of qualifying a truncated excerpt", () => {
    document.body.innerHTML = fixture;
    document.querySelector("article [data-testid='tweetText']")?.insertAdjacentHTML("beforeend", "<a data-testid='tweet-text-show-more-link'>Show more</a>");
    expect(harvestVisibleTweets(document.body)).toEqual([]);
  });
});
