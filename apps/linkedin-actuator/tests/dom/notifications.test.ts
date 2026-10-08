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
