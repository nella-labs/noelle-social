// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  MAX_AGE_MINUTES,
  ageBuckets,
  conversationFrom,
  harvestNotifications,
  harvestThread,
  readSelfHandle,
  replyContextHandles,
  selectRepliesToMe,
  stripAt,
  tweetPostedAt,
} from "../../src/content/notifications.js";

const here = dirname(fileURLToPath(import.meta.url));

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

/** A notifications-timeline cell. `replyingTo` empty ⇒ a bare mention. */
const cell = (opts: {
  handle: string;
  id: string;
  text: string;
  replyingTo?: string[];
  at?: string;
  promoted?: boolean;
}) => `
  <article data-testid="tweet">
    ${opts.promoted ? '<div data-testid="placementTracking"><span>Ad</span></div>' : ""}
    <div data-testid="User-Name">
      <span>Some Person</span><span>@${opts.handle}</span>
      <a href="/${opts.handle}/status/${opts.id}"><time datetime="${opts.at ?? "2026-07-26T10:00:00.000Z"}">1h</time></a>
    </div>
    ${
      opts.replyingTo?.length
        ? `<div><div>Replying to ${opts.replyingTo.map((h) => `<a href="/${h}">@${h}</a>`).join(" ")}</div></div>`
        : ""
    }
    <div data-testid="tweetText">${opts.text}</div>
    <button data-testid="like"></button>
  </article>`;

describe("replyContextHandles", () => {
  it("reads the handles out of a 'Replying to' context line", () => {
    const root = mount(cell({ handle: "alice", id: "1", text: "sure", replyingTo: ["demooperator", "bob"] }));
    expect(replyContextHandles(root.querySelector("article")!)).toEqual(["demooperator", "bob"]);
  });

  it("returns [] for a cell with no reply context (a bare mention)", () => {
    const root = mount(cell({ handle: "alice", id: "1", text: "hey @demooperator look at this" }));
    expect(replyContextHandles(root.querySelector("article")!)).toEqual([]);
  });

  it("cannot be faked by a tweet body that starts with the phrase", () => {
    // The body is the untrusted surface: a tweet literally reading
    // "Replying to @demooperator ..." must not register as a reply to us.
    const root = mount(cell({ handle: "alice", id: "1", text: "Replying to @demooperator is fun" }));
    expect(replyContextHandles(root.querySelector("article")!)).toEqual([]);
  });
});

describe("harvestNotifications", () => {
  it("maps a reply cell to a harvest record with an absolute permalink", () => {
    const root = mount(cell({ handle: "alice", id: "555", text: "good point", replyingTo: ["demooperator"] }));
    expect(harvestNotifications(root)).toEqual([
      {
        tweet_id: "555",
        handle: "alice",
        text: "good point",
        url: "https://x.com/alice/status/555",
        posted_at: "2026-07-26T10:00:00.000Z",
        replying_to: ["demooperator"],
      },
    ]);
  });

  it("drops promoted cells", () => {
    const root = mount(cell({ handle: "ads", id: "9", text: "buy", replyingTo: ["demooperator"], promoted: true }));
    expect(harvestNotifications(root)).toEqual([]);
  });

  it("drops cells with no body text", () => {
    const root = mount(`
      <article data-testid="tweet">
        <div data-testid="User-Name"><span>@alice</span><a href="/alice/status/7"><time datetime="2026-07-26T10:00:00.000Z">1h</time></a></div>
        <button data-testid="like"></button>
      </article>`);
    expect(harvestNotifications(root)).toEqual([]);
  });

  it("returns null posted_at when the cell renders no <time>", () => {
    const root = mount(`
      <article data-testid="tweet">
        <div data-testid="User-Name"><span>@alice</span></div>
        <div><div>Replying to <a href="/demooperator">@demooperator</a></div></div>
        <div data-testid="tweetText">hi</div>
        <a href="/alice/status/42"></a>
        <button data-testid="like"></button>
      </article>`);
    expect(harvestNotifications(root)[0]?.posted_at).toBeNull();
  });
});

describe("tweetPostedAt", () => {
  it("reads the ISO datetime attribute", () => {
    const root = mount(cell({ handle: "a", id: "1", text: "x", at: "2026-01-02T03:04:05.000Z" }));
    expect(tweetPostedAt(root.querySelector("article")!)).toBe("2026-01-02T03:04:05.000Z");
  });
});

describe("selectRepliesToMe", () => {
  // Pinned so the recency gate is deterministic: `base` is one hour old.
  const NOW = Date.parse("2026-07-26T12:00:00.000Z");
  const base = {
    tweet_id: "1",
    handle: "alice",
    text: "sure",
    url: "https://x.com/alice/status/1",
    posted_at: "2026-07-26T11:00:00.000Z",
    replying_to: ["demooperator"],
  };
  const pick = (items: (typeof base)[], opts: { selfHandle: string; seen?: string[]; max?: number }) =>
    selectRepliesToMe(items, {
      selfHandle: opts.selfHandle,
      seen: opts.seen ?? [],
      max: opts.max ?? 5,
      nowMs: NOW,
    });

  it("keeps a reply that names me", () => {
    expect(pick([base], { selfHandle: "demooperator" })).toHaveLength(1);
  });

  it("is case- and @-insensitive about my own handle", () => {
    expect(pick([base], { selfHandle: "@DemoOperator" })).toHaveLength(1);
  });

  it("drops a bare mention (no reply context)", () => {
    const mention = { ...base, replying_to: [] };
    expect(pick([mention], { selfHandle: "demooperator" })).toEqual([]);
  });

  it("drops a reply aimed at someone else", () => {
    const other = { ...base, replying_to: ["carol"] };
    expect(pick([other], { selfHandle: "demooperator" })).toEqual([]);
  });

  it("never answers our own tweets", () => {
    const mine = { ...base, handle: "demooperator", replying_to: ["demooperator"] };
    expect(pick([mine], { selfHandle: "demooperator" })).toEqual([]);
  });

  it("drops ids already in the seen ring", () => {
    expect(pick([base], { selfHandle: "demooperator", seen: ["1"] })).toEqual([]);
  });

  it("bounds the batch to max", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ ...base, tweet_id: String(i) }));
    expect(pick(many, { selfHandle: "demooperator", max: 3 })).toHaveLength(3);
  });

  it("returns nothing when the self handle is unknown", () => {
    expect(pick([base], { selfHandle: "" })).toEqual([]);
  });
});

describe("readSelfHandle", () => {
  it("reads the account switcher", () => {
    const root = mount(`
      <button data-testid="SideNav_AccountSwitcher_Button"><span>Alex</span><span>@demooperator</span></button>`);
    expect(readSelfHandle(root)).toBe("demooperator");
  });

  it("falls back to the profile nav link", () => {
    const root = mount(`<a data-testid="AppTabBar_Profile_Link" href="/demooperator"></a>`);
    expect(readSelfHandle(root)).toBe("demooperator");
  });

  it("returns null when neither is present", () => {
    expect(readSelfHandle(mount("<div></div>"))).toBeNull();
  });
});

describe("harvestThread", () => {
  const thread = `
    ${cell({ handle: "carol", id: "100", text: "shipping is hard" })}
    ${cell({ handle: "demooperator", id: "200", text: "only if you ship rarely" })}
    ${cell({ handle: "alice", id: "300", text: "disagree, here's why" })}`;

  it("returns the ancestors above the focused tweet, oldest first", () => {
    expect(harvestThread(mount(thread), "300")).toEqual([
      { tweet_id: "100", handle: "carol", text: "shipping is hard" },
      { tweet_id: "200", handle: "demooperator", text: "only if you ship rarely" },
