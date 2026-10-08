// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  MAX_AGE_MINUTES,
  ageBuckets,
  ageMinutesFromText,
  cardAgeMinutes,
  isUiChrome,
  withinAgeWindow,
  activityUrnFrom,
  cardPostContext,
  commentIdFrom,
  isReplyType,
  notificationTypeFrom,
  cardHeadline,
  cardSnippet,
  harvestNotifications,
  isReplyHeadline,
  publicIdFrom,
  selectRepliesToMe,
} from "../../src/content/notifications.js";

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

const card = (opts: { headline: string; snippet?: string; publicId?: string; urn?: string }) => `
  <article class="nt-card">
    <div class="nt-card__text--headline">${opts.headline}</div>
    ${opts.snippet ? `<p>${opts.snippet}</p>` : ""}
    <span>3h</span>
    ${opts.publicId === undefined ? '<a href="/in/alice-smith"></a>' : opts.publicId ? `<a href="/in/${opts.publicId}"></a>` : ""}
    <a href="/feed/update/urn:li:activity:${opts.urn ?? "7300000000000000000"}/"></a>
  </article>`;

describe("isReplyHeadline", () => {
  it("accepts a comment on our post", () => {
    expect(isReplyHeadline("Alice Smith commented on your post")).toBe(true);
  });

  it("accepts a reply to our comment", () => {
    expect(isReplyHeadline("Alice Smith replied to your comment")).toBe(true);
  });

  it("accepts a comment that mentions us", () => {
    expect(isReplyHeadline("Alice Smith mentioned you in a comment")).toBe(true);
  });

  it("rejects a reaction", () => {
    expect(isReplyHeadline("Alice Smith likes your post")).toBe(false);
    expect(isReplyHeadline("Alice Smith reacted to your comment")).toBe(false);
  });

  it("rejects a follow and a profile view", () => {
    expect(isReplyHeadline("Alice Smith follows you")).toBe(false);
    expect(isReplyHeadline("3 people viewed your profile")).toBe(false);
  });

  it("rejects a comment on somebody ELSE's post", () => {
    // "commented on a post you follow" is not a reply to us and must never
    // enter the conversation lane.
    expect(isReplyHeadline("Alice Smith commented on a post you follow")).toBe(false);
  });
});

describe("publicIdFrom", () => {
  it("reads the /in/ segment", () => {
    expect(publicIdFrom("/in/alice-smith")).toBe("alice-smith");
    expect(publicIdFrom("https://www.linkedin.com/in/alice-smith/?x=1")).toBe("alice-smith");
  });

  it("survives a malformed percent-escape instead of throwing", () => {
    // decodeURIComponent throws URIError on a bad escape. Unguarded, one such
    // href would blow up the whole harvest and lose every other notification
    // on the page with it.
    expect(() => publicIdFrom("/in/alice%E0%A4%A")).not.toThrow();
    expect(publicIdFrom("/in/alice%E0%A4%A")).toBe("alice%E0%A4%A");
  });

  it("decodes a well-formed escape", () => {
    expect(publicIdFrom("/in/jos%C3%A9-garcia")).toBe("josé-garcia");
  });

  it("returns null for a non-profile href", () => {
    expect(publicIdFrom("/feed/update/urn:li:activity:1/")).toBeNull();
    expect(publicIdFrom(null)).toBeNull();
  });
});

describe("activityUrnFrom", () => {
  it("normalizes every LinkedIn post-link shape onto one urn", () => {
    const urn = "urn:li:activity:7481524546924343296";
    expect(activityUrnFrom("/feed/update/urn:li:activity:7481524546924343296/")).toBe(urn);
    expect(activityUrnFrom("/posts/slug-activity-7481524546924343296-ek0Y")).toBe(urn);
  });

  it("returns null when there's no id", () => {
    expect(activityUrnFrom("/feed/")).toBeNull();
    expect(activityUrnFrom(undefined)).toBeNull();
  });
});

describe("cardHeadline / cardSnippet", () => {
  it("reads the headline", () => {
    const root = mount(card({ headline: "Alice Smith commented on your post", snippet: "great point" }));
    expect(cardHeadline(root.querySelector("article")!)).toBe("Alice Smith commented on your post");
  });

  it("reads the comment snippet, not the headline or the timestamp", () => {
    const root = mount(card({ headline: "Alice Smith commented on your post", snippet: "this is the actual comment" }));
    const el = root.querySelector("article")!;
    expect(cardSnippet(el, cardHeadline(el))).toBe("this is the actual comment");
  });

  it("returns empty when the card shows no snippet", () => {
    const root = mount(card({ headline: "Alice Smith commented on your post" }));
    const el = root.querySelector("article")!;
    expect(cardSnippet(el, cardHeadline(el))).toBe("");
  });
});

describe("harvestNotifications", () => {
  it("maps a reply card to a harvest record", () => {
    const root = mount(card({ headline: "Alice Smith commented on your post", snippet: "great point" }));
    expect(harvestNotifications(root)).toEqual([
      {
        // no commentUrn on this href, so it falls back to (post, person)
        external_id: "urn:li:activity:7300000000000000000:alice-smith",
        public_id: "alice-smith",
        name: "Alice Smith",
        text: "great point",
        url: "https://www.linkedin.com/feed/update/urn:li:activity:7300000000000000000/",
        activity_urn: "urn:li:activity:7300000000000000000",
        post_context: "",
        // read from the card's unclassed "3h" — the structural fallback
        age_minutes: 180,
      },
    ]);
  });

  it("drops a reaction card", () => {
    const root = mount(card({ headline: "Alice Smith likes your post", snippet: "x" }));
    expect(harvestNotifications(root)).toEqual([]);
  });

  it("drops a card with no readable snippet rather than filing a textless lead", () => {
    const root = mount(card({ headline: "Alice Smith commented on your post" }));
    expect(harvestNotifications(root)).toEqual([]);
  });

  it("drops a card with no profile link", () => {
    const root = mount(card({ headline: "Alice Smith commented on your post", snippet: "hi", publicId: "" }));
    expect(harvestNotifications(root)).toEqual([]);
  });

  it("dedupes the same (post, person) rendered twice as the list re-renders", () => {
    const one = card({ headline: "Alice Smith commented on your post", snippet: "great point" });
    expect(harvestNotifications(mount(one + one))).toHaveLength(1);
  });

  it("keeps two different people on the same post apart", () => {
    const root = mount(
      card({ headline: "Alice Smith commented on your post", snippet: "great point" }) +
        card({ headline: "Bob Jones commented on your post", snippet: "agreed", publicId: "bob-jones" }),
    );
    expect(harvestNotifications(root).map((i) => i.public_id)).toEqual(["alice-smith", "bob-jones"]);
  });

  it("keeps the same person on two different posts apart", () => {
    const root = mount(
      card({ headline: "Alice Smith commented on your post", snippet: "one", urn: "7300000000000000001" }) +
        card({ headline: "Alice Smith commented on your post", snippet: "two", urn: "7300000000000000002" }),
    );
    expect(harvestNotifications(root)).toHaveLength(2);
  });
});

describe("selectRepliesToMe", () => {
  const item = {
    external_id: "urn:li:activity:1:alice",
    public_id: "alice",
    name: "Alice",
    text: "hi",
    url: "https://www.linkedin.com/feed/update/urn:li:activity:1/",
    activity_urn: "urn:li:activity:1",
    post_context: "",
    age_minutes: 60,
  };

  it("keeps a fresh card", () => {
    expect(selectRepliesToMe([item], { seen: [], max: 5 })).toHaveLength(1);
  });

  it("drops one already in the seen ring", () => {
    expect(selectRepliesToMe([item], { seen: [item.external_id], max: 5 })).toEqual([]);
  });

  it("bounds the batch", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ ...item, external_id: String(i) }));
    expect(selectRepliesToMe(many, { seen: [], max: 3 })).toHaveLength(3);
  });
});

// Safety property against the repo's REAL captured LinkedIn markup: the
// notification harvester must produce NOTHING on any page that is not the
// notifications page. `cardsIn` falls back to bare `article`/`li` selectors, so
// without this a feed post could be mistaken for a notification card and filed
// as a conversation lead.
describe("harvestNotifications on real non-notification pages", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const fx = (name: string) => readFileSync(join(here, "..", "fixtures", name), "utf8");

  for (const file of [
    "feed-post.html",
    "feed-2026-obfuscated.html",
    "feed-drifted.html",
    "commented-post.html",
    "long-post.html",
    "sponsored-post.html",
  ]) {
    it(`${file} yields no notifications`, () => {
      document.body.innerHTML = fx(file);
      expect(harvestNotifications(document.body)).toEqual([]);
    });
  }
});

// external_id has a 200-char cap in the contract, and the server parses a sweep
// as ONE batch — so a single oversized id would 400 the whole request and lose
// every other item with it. A real LinkedIn notification href carries
// commentUrn/dashCommentUrn tracking params and runs past 270 chars, so the raw
// href can never be part of the id.
describe("external_id stability and length", () => {
  const realisticHref =
    "/feed/update/urn:li:activity:7300000000000000000/?commentUrn=urn%3Ali%3Acomment%3A%28activity%3A7300000000000000000%2C7300000000000000123%29&dashCommentUrn=urn%3Ali%3Afsd_comment%3A%287300000000000000123%2Curn%3Ali%3Aactivity%3A7300000000000000000%29";

  const cardWithHref = (href: string) => `
    <article class="nt-card">
      <div class="nt-card__text--headline">Alice Smith commented on your post</div>
      <p>great point</p>
      <a href="/in/alice-smith"></a>
      <a href="${href}"></a>
    </article>`;

  it("stays well under the 200-char contract limit on a real tracking-param href", () => {
    document.body.innerHTML = cardWithHref(realisticHref);
    const [item] = harvestNotifications(document.body);
    expect(item).toBeDefined();
    expect(item!.external_id.length).toBeLessThanOrEqual(200);
    // The href exposes a real comment urn, so that is the id — it distinguishes
    // two comments by the same person on the same post.
    expect(item!.external_id).toBe("urn:li:comment:7300000000000000123");
  });

  it("is STABLE across the OTHER tracking params that vary between renders", () => {
    document.body.innerHTML = cardWithHref(realisticHref);
    const a = harvestNotifications(document.body)[0]!.external_id;
    document.body.innerHTML = cardWithHref(realisticHref + "&trk=some_other_tracking_param&lipi=xyz");
    expect(harvestNotifications(document.body)[0]!.external_id).toBe(a);
  });

  it("distinguishes two comments by the SAME person on the SAME post", () => {
    // The old (post, person) key collapsed these into one, so the second
    // comment was reported as a duplicate and never answered.
    const other = realisticHref.replace("7300000000000000123", "7300000000000000999");
    document.body.innerHTML = cardWithHref(realisticHref) + cardWithHref(other);
    const ids = harvestNotifications(document.body).map((i) => i.external_id);
    expect(new Set(ids).size).toBe(2);
  });

  it("skips a card whose activity urn cannot be derived rather than filing an unkeyable lead", () => {
    document.body.innerHTML = cardWithHref("/feed/update/something-with-no-id/");
    expect(harvestNotifications(document.body)).toEqual([]);
  });
});

// REAL markup captured from a logged-in linkedin.com/notifications
// (fixtures/notification-card.html). This one card disproved four assumptions;
// each is locked below so a future edit cannot silently reintroduce them.
describe("real captured LinkedIn notification card", () => {
  const here2 = dirname(fileURLToPath(import.meta.url));
  const card = () => readFileSync(join(here2, "..", "fixtures", "notification-card.html"), "utf8");
  const el = () => {
    document.body.innerHTML = card();
    return document.querySelector("article.nt-card")!;
  };

  it("cardsIn finds it via data-view-name='notification-card-container'", () => {
    document.body.innerHTML = card();
    // The guessed value was "notification-card"; the real one has -container.
    expect(document.querySelectorAll("[data-view-name='notification-card-container']").length).toBe(1);
    expect(document.querySelectorAll("[data-view-name='notification-card']").length).toBe(0);
  });

  it("cardHeadline reads the real headline and drops the a11y text", () => {
    // The real class is nt-card__headline, and the anchor contains a
    // .visually-hidden "Unread notification." that must not pollute the match.
    expect(cardHeadline(el())).toBe("Your comment has gained 371 impressions.");
  });

  it("cardHeadline is not fooled by the settings dropdown's *__headline items", () => {
    expect(cardHeadline(el())).not.toMatch(/notification preferences|Delete notification/);
  });

  it("REJECTS it — an impressions notification is not a reply", () => {
    expect(isReplyHeadline(cardHeadline(el()))).toBe(false);
    document.body.innerHTML = card();
    expect(harvestNotifications(document.body)).toEqual([]);
  });

  it("parses the PERCENT-ENCODED ugcPost urn the real link carries", () => {
    const href = el().querySelector("a.nt-card__headline")!.getAttribute("href");
    // The old /activity[-:](\d+)/ regex returned null here, which skipped every
    // real card and made the LinkedIn sweep harvest nothing at all.
    expect(activityUrnFrom(href)).toBe("urn:li:ugcPost:7486054278927835136");
  });

  it("extracts the REAL comment id from the link's commentUrn param", () => {
    const href = el().querySelector("a.nt-card__headline")!.getAttribute("href");
    expect(commentIdFrom(href)).toBe("7486091099183251456");
  });

  it("cardSnippet returns the COMMENT, not the much longer original post", () => {
    const c = el();
    const snippet = cardSnippet(c, cardHeadline(c));
    expect(snippet).toMatch(/^a week to teach yourself advanced econometrics/);
    expect(snippet).not.toMatch(/Happy to share that I finished first/);
  });

  it("cardPostContext returns the original post as free thread context", () => {
    expect(cardPostContext(el())).toMatch(/^Happy to share that I finished first/);
  });
});

// REAL full notifications page (fixtures/notifications-page.html), captured
// from a logged-in linkedin.com/notifications. Three more assumptions died
// here; each is locked below.
describe("real captured LinkedIn notifications PAGE", () => {
  const here3 = dirname(fileURLToPath(import.meta.url));
  const page = () => readFileSync(join(here3, "..", "fixtures", "notifications-page.html"), "utf8");
  const harvest = () => {
    document.body.innerHTML = page();
    return harvestNotifications(document.body);
  };

  it("harvests exactly the genuine replies and rejects everything else", () => {
    // 6 real cards: a trending post, a reaction on our comment, a reply, an
    // impressions card, a reaction on a comment mentioning us, and a comment
    // written at us. Only the last two are somebody talking TO us.
    expect(harvest().map((i) => i.public_id)).toEqual(["mara-lopez", "nathan-beck"]);
  });

  it("finds reply cards at all — their link is /feed/?highlightedUpdateUrn=, not /feed/update/", () => {
    // The card filter used to require /feed/update/ or 'activity-', which no
    // reply card carries, so it matched ZERO replies and the sweep harvested
    // nothing. This asserts the shape that actually appears.
    document.body.innerHTML = page();
    const hrefs = Array.from(document.querySelectorAll("a.nt-card__headline")).map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.every((h) => !h.includes("/feed/update/"))).toBe(true);
    expect(hrefs.some((h) => h.includes("highlightedUpdateUrn"))).toBe(true);
    expect(harvest()).toHaveLength(2);
  });

  it("keys on THEIR reply id, never on our own comment id", () => {
    // A reply link carries commentUrn (OURS) and replyUrn (THEIRS). Taking the
    // first comment urn returned ours, so every different person replying to
    // one comment of ours collided on a single external_id and only the first
    // was ever answered.
    const [reply] = harvest();
    expect(reply!.external_id).toBe("urn:li:comment:7487199472029192192"); // replyUrn
    expect(reply!.external_id).not.toContain("7486091099183251456"); // our commentUrn
  });

  it("roots the conversation on the POST, not the notification's own activity", () => {
    // highlightedUpdateUrn is the notification's activity and differs per
    // notification; using it would give a different 'root' for every
    // notification on one thread and defeat the turn cap.
    const [reply] = harvest();
    expect(reply!.activity_urn).toBe("urn:li:ugcPost:7486054278927835136");
    expect(reply!.activity_urn).not.toBe("urn:li:activity:7487199521425326080");
  });

  it("reads the commenter's percent-encoded profile id from the left rail", () => {
    // The last open question from the single-card capture: reply cards DO carry
    // a profile link, as a[data-view-name='notification-card-image'].
    expect(harvest()[0]!.public_id).toBe("mara-lopez"); // from "/in/mara%2Dlopez"
  });

  it("uses LinkedIn's own notification type over the headline prose", () => {
    expect(notificationTypeFrom("/feed/?highlightedUpdateType=REPLIED_TO_YOUR_COMMENT&x=1")).toBe("REPLIED_TO_YOUR_COMMENT");
    expect(isReplyType("REPLIED_TO_YOUR_COMMENT")).toBe(true);
    expect(isReplyType("MENTIONED_YOU_IN_THIS")).toBe(true);
    expect(isReplyType("REACTED_TO_YOUR_COMMENT")).toBe(false);
    expect(isReplyType("REACTED_TO_COMMENT_MENTIONING_YOU")).toBe(false);
    expect(isReplyType("COMMENT_VIEWS")).toBe(false);
    expect(isReplyType("TOPIC_TRENDING_CONVERSATION_IN_YOUR_NETWORK")).toBe(false);
