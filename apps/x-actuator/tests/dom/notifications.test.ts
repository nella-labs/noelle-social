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
    ]);
  });

  it("returns [] when the focused tweet is not on the page", () => {
    expect(harvestThread(mount(thread), "999")).toEqual([]);
  });

  it("returns [] for a focused tweet with no ancestors", () => {
    expect(harvestThread(mount(thread), "100")).toEqual([]);
  });
});

describe("conversationFrom", () => {
  const chain = [
    { tweet_id: "100", handle: "carol", text: "shipping is hard" },
    { tweet_id: "200", handle: "demooperator", text: "only if you ship rarely" },
  ];

  it("picks the root and our last turn", () => {
    expect(conversationFrom(chain, "demooperator")).toEqual({
      root_post_id: "100",
      root_post_text: "shipping is hard",
      our_reply_id: "200",
      our_reply_text: "only if you ship rarely",
    });
  });

  it("omits our reply when we authored the root itself", () => {
    // Someone replying to our own post: the root already carries our words, so
    // repeating it as "you then said" would double it in the prompt.
    expect(conversationFrom([{ tweet_id: "100", handle: "demooperator", text: "we shipped" }], "demooperator")).toEqual({
      root_post_id: "100",
      root_post_text: "we shipped",
    });
  });

  it("omits our reply when we never spoke in the chain", () => {
    expect(conversationFrom([{ tweet_id: "100", handle: "carol", text: "hi" }], "demooperator")).toEqual({
      root_post_id: "100",
      root_post_text: "hi",
    });
  });

  it("is empty for an empty chain", () => {
    expect(conversationFrom([], "demooperator")).toEqual({});
  });
});

describe("stripAt", () => {
  it("normalizes handles", () => {
    expect(stripAt("  @DemoOperator ")).toBe("demooperator");
    expect(stripAt("demooperator")).toBe("demooperator");
  });
});

// Against the REAL captured markup, not hand-shaped fixtures. This is the pair
// that caught the bug the synthetic tests could not: on a permalink page X
// renders the FOCAL tweet's timestamp with no self-permalink anchor, so its id
// is unreadable — and harvestThread used to identify it by id match, so it
// returned [] for every real conversation and the sweep ingested nothing.
describe("harvestThread against real captured thread markup", () => {
  const fx = (name: string) =>
    readFileSync(join(here, "..", "fixtures", name), "utf8");

  it("thread-page.html: returns the ancestors above the focal reply", () => {
    document.body.innerHTML = fx("thread-page.html");
    // The focal tweet's id is exactly what the page does NOT render, so the
    // caller passes the id it navigated to and harvestThread must still work.
    expect(harvestThread(document.body, "1900000000000000003")).toEqual([
      {
        tweet_id: "1900000000000000001",
        handle: "carol",
        text: "shipping daily is overrated, most teams cannot sustain it",
      },
      {
        tweet_id: "1900000000000000002",
        handle: "demooperator",
        text: "it is only unsustainable when every ship needs a meeting first",
      },
    ]);
  });

  it("thread-page.html: the chain yields a usable conversation for the drafter", () => {
    document.body.innerHTML = fx("thread-page.html");
    const chain = harvestThread(document.body, "1900000000000000003");
    expect(conversationFrom(chain, "demooperator")).toEqual({
      root_post_id: "1900000000000000001",
      root_post_text: "shipping daily is overrated, most teams cannot sustain it",
      our_reply_id: "1900000000000000002",
      our_reply_text: "it is only unsustainable when every ship needs a meeting first",
    });
  });

  it("thread-page.html: the focal cell's reply context still names us", () => {
    document.body.innerHTML = fx("thread-page.html");
    const cells = Array.from(document.querySelectorAll("article[data-testid='tweet']"));
    // third cell is the focal reply
    expect(replyContextHandles(cells[2]!)).toEqual(["demooperator"]);
  });

  it("status-page.html: a focal tweet with no ancestors yields an empty chain", () => {
    // The sweep DROPS empty chains, so this is the 'no usable context' path,
    // not a crash — and it must not mis-report the reply below the focal one
    // as an ancestor.
    document.body.innerHTML = fx("status-page.html");
    expect(harvestThread(document.body, "1802000000000000001")).toEqual([]);
  });
});

// REAL markup captured from a logged-in x.com/notifications/mentions
// (fixtures/notifications-mentions.html). This is the part that could not be
// verified from repo evidence alone — the "Replying to" context line carries no
// testid, so it is the one signal separating a reply to us from a bare mention.
describe("harvestNotifications against real mentions markup", () => {
  const fx = () => readFileSync(join(here, "..", "fixtures", "notifications-mentions.html"), "utf8");
  // The fixture was captured on 2026-07-24; pin "now" just after its newest
  // cell so the recency gate sees these as fresh rather than two days stale.
  const NOW = Date.parse("2026-07-24T21:00:00.000Z");

  it("harvests both real reply cells with every field correct", () => {
    document.body.innerHTML = fx();
    expect(harvestNotifications(document.body)).toEqual([
      {
        tweet_id: "2080744715796803921",
        handle: "ada",
        text: "It's an easy way to get a first push\n\nI see so many great builders post into a black hole\n\nZero likes and zero attention",
        url: "https://x.com/ada/status/2080744715796803921",
        posted_at: "2026-07-24T19:59:33.000Z",
        replying_to: ["operator"],
      },
      {
        tweet_id: "2080686254182556109",
        handle: "bram",
        text: "We have a yes from the operator!",
        url: "https://x.com/bram/status/2080686254182556109",
        posted_at: "2026-07-24T16:07:14.000Z",
        replying_to: ["operator", "cleo"],
      },
    ]);
  });

  it("reads a MULTI-handle reply context ('Replying to @operator and @cleo')", () => {
    document.body.innerHTML = fx();
    const cells = Array.from(document.querySelectorAll("article[data-testid='tweet']"));
    expect(replyContextHandles(cells[1]!)).toEqual(["operator", "cleo"]);
  });

  it("selects both as replies to the operator", () => {
    document.body.innerHTML = fx();
    const picked = selectRepliesToMe(harvestNotifications(document.body), {
      selfHandle: "operator",
      seen: [],
      max: 3,
      nowMs: NOW,
    });
    expect(picked.map((p) => p.handle)).toEqual(["ada", "bram"]);
  });

  it("selects NEITHER for a different operator — a reply to someone else is not ours", () => {
    document.body.innerHTML = fx();
    const picked = selectRepliesToMe(harvestNotifications(document.body), {
      selfHandle: "cleo", // named in cell 2's context, but the reply is not TO cleo alone
      seen: [],
      max: 3,
      nowMs: NOW,
    });
    // cleo IS named in the second cell's context, so that one legitimately counts.
    expect(picked.map((p) => p.handle)).toEqual(["bram"]);
  });
});

// REAL structure from the x.com/notifications "All" tab. The subtle fact worth
// locking: likes/follows render as article[data-testid="notification"] while a
// genuine reply renders as article[data-testid="tweet"]. findFeedTweets targets
// "tweet", so the All tab filters itself — but only as long as nobody widens
// that selector. A regression here would ingest every like as a conversation.
describe("the All tab: notification cards are not replies", () => {
  const fx = () => readFileSync(join(here, "..", "fixtures", "notifications-all-tab.html"), "utf8");
  const NOW = Date.parse("2026-07-25T00:00:00.000Z"); // just after the fixture's newest cell

  it("harvests ONLY the genuine reply, not the like or the follow", () => {
    document.body.innerHTML = fx();
    const items = harvestNotifications(document.body);
    expect(items).toHaveLength(1);
    expect(items[0]!.handle).toBe("ada");
    expect(items[0]!.replying_to).toEqual(["operator"]);
  });

  it("a 'liked your reply' card is never selected, even though it quotes our text", () => {
    // The like card contains a data-testid="tweetText" holding OUR OWN reply.
    // Ingesting it would file our own words as somebody talking to us.
    document.body.innerHTML = fx();
    const picked = selectRepliesToMe(harvestNotifications(document.body), {
      selfHandle: "operator",
      seen: [],
      max: 5,
      nowMs: NOW,
    });
    expect(picked).toHaveLength(1);
    expect(picked[0]!.text).not.toMatch(/buzz is the one/);
  });

  it("the notification cards really are present in the fixture (guards the guard)", () => {
    document.body.innerHTML = fx();
    expect(document.querySelectorAll('article[data-testid="notification"]').length).toBe(2);
    expect(document.querySelectorAll('article[data-testid="tweet"]').length).toBe(1);
  });
});

// Recency is independent of deduplication: a fresh installation has no seen
// entries but must still reject stale notifications.
describe("the 12h recency window", () => {
  const NOW = Date.parse("2026-07-26T12:00:00.000Z");
  const at = (iso: string | null) => ({
    tweet_id: "1",
    handle: "alice",
    text: "a real question for you?",
    url: "https://x.com/alice/status/1",
    posted_at: iso,
    replying_to: ["demooperator"],
  });
  const pick = (iso: string | null) =>
    selectRepliesToMe([at(iso)], { selfHandle: "demooperator", seen: [], max: 5, nowMs: NOW });

  it("is twelve hours", () => {
    expect(MAX_AGE_MINUTES).toBe(720);
  });

  it("keeps a reply from five minutes ago", () => {
    expect(pick("2026-07-26T11:55:00.000Z")).toHaveLength(1);
  });

  it("keeps a reply from exactly twelve hours ago (the boundary is inclusive)", () => {
    expect(pick("2026-07-26T00:00:00.000Z")).toHaveLength(1);
  });

  it("drops a reply from twelve hours and a minute ago", () => {
    expect(pick("2026-07-25T23:59:00.000Z")).toEqual([]);
  });

  it("keeps an overnight reply the next morning — the reason for 9h over 6h", () => {
    // Posted 1am, sweep runs at 9am: 8h old. Under a 6h window this had aged
    // out while nobody was watching.
    const nine = Date.parse("2026-07-26T09:00:00.000Z");
    const oneAm = "2026-07-26T01:00:00.000Z";
    expect(
      selectRepliesToMe([at(oneAm)], { selfHandle: "demooperator", seen: [], max: 5, nowMs: nine }),
    ).toHaveLength(1);
  });

  it("drops a two-day-old reply that the seen-ring has never seen", () => {
    // The exact case the window exists for: unseen, therefore "new" by the old
    // rule, but answering it is necro-engagement.
    expect(pick("2026-07-24T12:00:00.000Z")).toEqual([]);
  });

  it("drops a reply whose timestamp cannot be read", () => {
    // We cannot prove it is recent, so it does not get answered. It stays out
    // of the seen-ring too, so nothing is permanently lost.
    expect(pick(null)).toEqual([]);
    expect(pick("not a date")).toEqual([]);
  });

  it("keeps a cell timestamped slightly in the future (clock skew)", () => {
    expect(pick("2026-07-26T12:00:30.000Z")).toHaveLength(1);
  });

  it("applies the window on top of the other gates, not instead of them", () => {
    const fresh = { ...at("2026-07-26T11:59:00.000Z"), replying_to: [] };
    expect(selectRepliesToMe([fresh], { selfHandle: "demooperator", seen: [], max: 5, nowMs: NOW })).toEqual([]);
  });
});

describe("ageBuckets — the sweep's markup-break signal", () => {
  const NOW = Date.parse("2026-07-26T12:00:00.000Z");
  const mk = (posted_at: string | null) => ({
    tweet_id: "1", handle: "a", text: "t", url: "u", posted_at, replying_to: ["demooperator"],
  });

  it("counts recent, stale and undated separately", () => {
    const buckets = ageBuckets(
      [
        mk("2026-07-26T11:00:00.000Z"), // 1h
        mk("2026-07-26T04:00:00.000Z"), // 8h — inside 9h, was outside 6h
        mk("2026-07-24T12:00:00.000Z"), // 2d
        mk(null),
      ],
      { nowMs: NOW, maxAgeMinutes: MAX_AGE_MINUTES },
    );
    expect(buckets).toEqual({ recent: 2, stale: 1, undated: 1 });
  });

  it("reports all-undated, which is what a <time> markup change looks like", () => {
    // This is the number that turns a silent "0 replies" into a diagnosis.
    const buckets = ageBuckets([mk(null), mk(null)], { nowMs: NOW, maxAgeMinutes: MAX_AGE_MINUTES });
    expect(buckets.undated).toBe(2);
    expect(buckets.recent).toBe(0);
  });

  it("is empty-safe", () => {
    expect(ageBuckets([], { nowMs: NOW, maxAgeMinutes: MAX_AGE_MINUTES })).toEqual({
      recent: 0, stale: 0, undated: 0,
    });
  });
});
