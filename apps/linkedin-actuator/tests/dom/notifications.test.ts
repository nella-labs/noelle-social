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
    expect(isReplyType(null)).toBe(false);
  });

  it("gives the actuator a canonical post permalink, not the tracking link", () => {
    expect(harvest()[0]!.url).toBe("https://www.linkedin.com/feed/update/urn:li:ugcPost:7486054278927835136/");
  });

  it("carries the quoted original post as free conversation context", () => {
    expect(harvest()[0]!.post_context).toMatch(/^Happy to share that I finished first/);
  });
});

// LinkedIn renders human-readable ages instead of an ISO time attribute.
// Parse the supported units before applying the recency window.
describe("ageMinutesFromText", () => {
  it("reads the forms LinkedIn actually renders", () => {
    expect(ageMinutesFromText("2h")).toBe(120);
    expect(ageMinutesFromText("6h")).toBe(360);
    expect(ageMinutesFromText("10h")).toBe(600);
    expect(ageMinutesFromText("23h")).toBe(1380);
    expect(ageMinutesFromText("1d")).toBe(1440);
    expect(ageMinutesFromText("45m")).toBe(45);
    expect(ageMinutesFromText("2w")).toBe(20160);
  });

  it("reads 'now' as zero", () => {
    expect(ageMinutesFromText("now")).toBe(0);
    expect(ageMinutesFromText("just now")).toBe(0);
  });

  it("does NOT read months as minutes", () => {
    // The bug this ordering exists to prevent: "3mo" matching the /m/ rule
    // would make a quarter-old notification look three minutes fresh, and it
    // would sail through the window and get answered.
    expect(ageMinutesFromText("3mo")).toBe(129_600);
    expect(ageMinutesFromText("1mo")).toBe(43_200);
    expect(ageMinutesFromText("3m")).toBe(3);
  });

  it("tolerates spacing and long unit spellings", () => {
    expect(ageMinutesFromText("6 h")).toBe(360);
    expect(ageMinutesFromText(" 2 hours ")).toBe(120);
    expect(ageMinutesFromText("15 minutes")).toBe(15);
  });

  it("returns null rather than guessing", () => {
    expect(ageMinutesFromText("")).toBeNull();
    expect(ageMinutesFromText(null)).toBeNull();
    expect(ageMinutesFromText("yesterday")).toBeNull();
    expect(ageMinutesFromText("Alice Smith")).toBeNull();
  });
});

describe("cardAgeMinutes", () => {
  it("reads the real .nt-card__time-ago element", () => {
    const root = mount(`
      <article class="nt-card">
        <p class="nt-card__time-ago t-12 t-black--light t-normal">6h</p>
      </article>`);
    expect(cardAgeMinutes(root.querySelector("article")!)).toBe(360);
  });

  it("falls back structurally when the class is renamed", () => {
    // Same rule as the rest of this file: nothing depends on one class name.
    // A rename must degrade, not silently zero every card's age — which would
    // make the actor answer nothing and look identical to an empty inbox.
    const root = mount(`
      <article class="nt-card">
        <div class="nt-card__headline">Alice Smith commented on your post</div>
        <span class="totally-renamed">2h</span>
      </article>`);
    expect(cardAgeMinutes(root.querySelector("article")!)).toBe(120);
  });

  it("is not fooled by prose that merely contains a number", () => {
    const root = mount(`
      <article class="nt-card">
        <div class="nt-card__headline">Alice replied: we tried this at 40k rows</div>
      </article>`);
    expect(cardAgeMinutes(root.querySelector("article")!)).toBeNull();
  });

  it("returns null when the card renders no age at all", () => {
    const root = mount(`<article class="nt-card"><p>great point</p></article>`);
    expect(cardAgeMinutes(root.querySelector("article")!)).toBeNull();
  });
});

describe("the 12h recency window", () => {
  const item = (age: number | null) => ({
    external_id: "urn:li:comment:1",
    public_id: "alice",
    name: "Alice",
    text: "a real question for you?",
    url: "https://www.linkedin.com/feed/update/urn:li:activity:1/",
    activity_urn: "urn:li:activity:1",
    post_context: "",
    age_minutes: age,
  });
  const pick = (age: number | null) => selectRepliesToMe([item(age)], { seen: [], max: 5 });

  it("is twelve hours", () => {
    expect(MAX_AGE_MINUTES).toBe(720);
  });

  it("keeps a 2h-old reply", () => {
    expect(pick(120)).toHaveLength(1);
  });

  it("keeps one at exactly 12h (inclusive boundary)", () => {
    expect(pick(720)).toHaveLength(1);
  });

  it("drops one at 12h01m", () => {
    expect(pick(721)).toEqual([]);
  });

  it("keeps an 8h-old overnight reply — the reason for 9h over 6h", () => {
    expect(pick(480)).toHaveLength(1);
  });

  it("drops a 1d-old reply the seen-ring has never seen", () => {
    // The case the window exists for: unseen, therefore "new" by the old rule.
    expect(pick(1440)).toEqual([]);
  });

  it("drops a card whose age could not be read", () => {
    expect(pick(null)).toEqual([]);
  });
});

describe("ageBuckets — the sweep's markup-break signal", () => {
  const mk = (age: number | null) => ({
    external_id: "x", public_id: "a", name: "A", text: "t", url: "u",
    activity_urn: null, post_context: "", age_minutes: age,
  });

  it("counts recent, stale and undated separately", () => {
    expect(ageBuckets([mk(60), mk(480), mk(1440), mk(null)], MAX_AGE_MINUTES)).toEqual({
      recent: 2, stale: 1, undated: 1,
    });
  });

  it("reports all-undated, which is what a time-ago rename looks like", () => {
    expect(ageBuckets([mk(null), mk(null)], MAX_AGE_MINUTES)).toEqual({
      recent: 0, stale: 0, undated: 2,
    });
  });
});

// The fixture includes 2h, 10h and 1d ages. Every supported card must have
// a parsed age rather than silently becoming undated.
describe("the recency window against the real captured notifications page", () => {
  const here2 = dirname(fileURLToPath(import.meta.url));
  const page = () => readFileSync(join(here2, "..", "fixtures", "notifications-page.html"), "utf8");

  it("reads an age for every harvested card — none are undated", () => {
    const items = harvestNotifications(mount(page()));
    expect(items.length).toBeGreaterThan(0);
    expect(items.filter((i) => i.age_minutes === null)).toEqual([]);
  });

  it("keeps the fresh ones and drops the ones older than 6h", () => {
    const items = harvestNotifications(mount(page()));
    // Exact numbers, not ">0": the real page has 2 reply cards at 2h and 1d.
    expect(items.map((i) => i.age_minutes).sort((a, b) => a! - b!)).toEqual([120, 1440]);
    expect(ageBuckets(items, MAX_AGE_MINUTES)).toEqual({ recent: 1, stale: 1, undated: 0 });

    const picked = selectRepliesToMe(items, { seen: [], max: 50 });
    expect(picked.map((p) => p.age_minutes)).toEqual([120]);
  });
});

// Adversarial review found the parser's rules were only START-anchored, so
// non-English time text parsed WRONG rather than null — and always in the
// dangerous direction, toward "just now". The harvest is language-independent
// (it keys on highlightedUpdateType, not prose), so the sweep genuinely does
// run on a non-English UI.
describe("ageMinutesFromText never guesses on foreign-language time text", () => {
  const wrongAndFresh = [
    ["3 sem", "Spanish/French weeks — was read as 3 SECONDS"],
    ["3 semanas", "Spanish weeks"],
    ["1 sem.", "abbreviated weeks"],
    ["3 semaines", "French weeks"],
    ["2 sett", "Italian weeks"],
    ["1 mes", "Spanish month — was read as 1 MINUTE"],
    ["3 meses", "Spanish months"],
    ["3 mesi", "Italian months"],
    ["12 Sep", "an absolute date — was read as 12 seconds"],
  ] as const;

  for (const [text, why] of wrongAndFresh) {
    it(`returns null for "${text}" (${why})`, () => {
      expect(ageMinutesFromText(text)).toBeNull();
    });
  }

  it("a months-old notification can never look minutes old", () => {
    // The property behind all of the above: nothing that is not really recent
    // may parse to a small number. Null is a skip; a small number is a reply.
