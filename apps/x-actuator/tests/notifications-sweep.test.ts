import { describe, it, expect } from "vitest";
import { isReplyToMe } from "../src/content/notifications.js";
import {
  describeEmptySweep,
  chooseIdleActivity,
  NOTIFICATIONS_URL,
  runNotificationSweep,
  SEEN_KEY,
  SELF_HANDLE_KEY,
  clampText,
  MAX_TEXT,
  mergeSeen,
  notificationSweepDue,
  toInboundItem,
  MAX_PER_SWEEP,
  SEEN_CAP,
  SWEEP_MIN_GAP_MS,
} from "../src/background/notifications.js";

describe("notificationSweepDue", () => {
  it("never sweeps on a run without the flag", () => {
    expect(
      notificationSweepDue({ enabled: false, sinceLastSweepMs: 60 * 60_000, minGapMs: SWEEP_MIN_GAP_MS }),
    ).toBe(false);
  });

  // DISABLED IN CODE. The kill switch (lib/notifications-feature.ts) is checked
  // before the lane flag and the gap, so nothing makes a sweep due while the
  // feature is off. Flip the constant back and this becomes `true` again.
  it("cannot sweep on a fresh notifications run while the feature is off", () => {
    // lastNotifSweepMs is undefined ⇒ the caller passes now-0, a huge gap.
    expect(
      notificationSweepDue({ enabled: true, sinceLastSweepMs: Date.now(), minGapMs: SWEEP_MIN_GAP_MS }),
    ).toBe(false);
  });

  it("holds until the gap has elapsed", () => {
    expect(
      notificationSweepDue({ enabled: true, sinceLastSweepMs: 60_000, minGapMs: SWEEP_MIN_GAP_MS }),
    ).toBe(false);
  });

  it("does not fire at the gap boundary either — the switch wins", () => {
    expect(
      notificationSweepDue({ enabled: true, sinceLastSweepMs: SWEEP_MIN_GAP_MS, minGapMs: SWEEP_MIN_GAP_MS }),
    ).toBe(false);
  });

  it("keeps the cadence in the 10-20 minute band under the caller's jitter", () => {
    // index.ts passes SWEEP_MIN_GAP_MS * rng.float(1, 2).
    expect(SWEEP_MIN_GAP_MS).toBe(10 * 60_000);
    expect(SWEEP_MIN_GAP_MS * 2).toBe(20 * 60_000);
  });
});

describe("mergeSeen", () => {
  it("puts the newest ids first", () => {
    expect(mergeSeen(["a", "b"], ["c"], 10)).toEqual(["c", "a", "b"]);
  });

  it("dedupes a re-seen id instead of growing the ring", () => {
    expect(mergeSeen(["a", "b"], ["b"], 10)).toEqual(["b", "a"]);
  });

  it("caps the ring, dropping the oldest", () => {
    expect(mergeSeen(["a", "b", "c"], ["d"], 2)).toEqual(["d", "a"]);
  });

  it("handles an empty ring", () => {
    expect(mergeSeen([], ["a"], 10)).toEqual(["a"]);
  });

  it("keeps the documented cap sane", () => {
    expect(SEEN_CAP).toBeGreaterThan(MAX_PER_SWEEP * 20);
  });
});

describe("toInboundItem", () => {
  const harvested = {
    tweet_id: "300",
    handle: "alice",
    text: "disagree, here's why",
    url: "https://x.com/alice/status/300",
    posted_at: "2026-07-26T10:00:00.000Z",
    replying_to: ["demooperator"],
  };
  const chain = [
    { tweet_id: "100", handle: "carol", text: "shipping is hard" },
    { tweet_id: "200", handle: "demooperator", text: "only if you ship rarely" },
  ];

  it("carries the reply and its thread context", () => {
    expect(toInboundItem(harvested, chain, "demooperator", "2026-07-26T12:00:00.000Z")).toEqual({
      external_id: "300",
      author_handle: "alice",
      text: "disagree, here's why",
      url: "https://x.com/alice/status/300",
      posted_at: "2026-07-26T10:00:00.000Z",
      conversation: {
        root_post_id: "100",
        root_post_text: "shipping is hard",
        our_reply_id: "200",
        our_reply_text: "only if you ship rarely",
      },
    });
  });

  it("falls back to now when X rendered no timestamp", () => {
    // posted_at feeds the reply-freshness ceiling; a notification we just saw is
    // fresh by construction, so a missing <time> must not drop the conversation.
    const item = toInboundItem({ ...harvested, posted_at: null }, [], "demooperator", "2026-07-26T12:00:00.000Z");
    expect(item.posted_at).toBe("2026-07-26T12:00:00.000Z");
  });

  it("omits the conversation key entirely when the thread couldn't be read", () => {
    expect(toInboundItem(harvested, [], "demooperator", "2026-07-26T12:00:00.000Z")).not.toHaveProperty(
      "conversation",
    );
  });
});

// The ordering invariant that was wrong once and would have made the whole
// feature dead on arrival: you click Auto notifications with an empty approval
// queue (the normal starting state), the supply gate sees both pools empty and
// returns "quiet" — so the sweep never runs, so no leads are ever filed, so the
// pools stay empty forever. The sweep IS the supply; it must be decided first.
describe("chooseIdleActivity", () => {
  it("sweeps on an EMPTY pipeline — the case that deadlocked", () => {
    expect(chooseIdleActivity({ sweepDue: true, pipelineDry: true, idleLike: false })).toBe("sweep");
  });

  it("sweep beats every other idle activity when due", () => {
    expect(chooseIdleActivity({ sweepDue: true, pipelineDry: false, idleLike: true })).toBe("sweep");
    expect(chooseIdleActivity({ sweepDue: true, pipelineDry: true, idleLike: true })).toBe("sweep");
  });

  it("still goes quiet on a dry pipeline when no sweep is due", () => {
    expect(chooseIdleActivity({ sweepDue: false, pipelineDry: true, idleLike: true })).toBe("quiet");
    expect(chooseIdleActivity({ sweepDue: false, pipelineDry: true, idleLike: false })).toBe("quiet");
  });

  it("keeps the pre-existing like/browse behavior when there is supply", () => {
    expect(chooseIdleActivity({ sweepDue: false, pipelineDry: false, idleLike: true })).toBe("like");
    expect(chooseIdleActivity({ sweepDue: false, pipelineDry: false, idleLike: false })).toBe("browse");
  });

  it("a run without the notifications flag is completely unaffected", () => {
    // sweepDue is false for every non-notifications run, so the decision table
    // collapses to exactly the old quiet/like/browse behavior.
    for (const pipelineDry of [true, false]) {
      for (const idleLike of [true, false]) {
        const got = chooseIdleActivity({ sweepDue: false, pipelineDry, idleLike });
        expect(got).toBe(pipelineDry ? "quiet" : idleLike ? "like" : "browse");
      }
    }
  });
});

// The contract caps scraped text at 4000 chars and the server parses a sweep as
// ONE batch, so a single over-long field would 400 the whole request and lose
// every other item with it. X Premium long-form posts reach ~25,000 chars and
// do appear in replies — this is a real case, not a theoretical one.
describe("clampText", () => {
  it("leaves normal text untouched", () => {
    expect(clampText("a short reply")).toBe("a short reply");
  });

  it("passes text exactly at the limit through unchanged", () => {
    const exact = "x".repeat(MAX_TEXT);
    expect(clampText(exact)).toBe(exact);
  });

  it("clamps a long-form post to the contract limit", () => {
    const huge = "x".repeat(25_000);
    const out = clampText(huge);
    expect(out.length).toBe(MAX_TEXT);
    expect(out.endsWith("…")).toBe(true);
  });
});

/**
 * A timestamp inside the 6h recency window. The sweep reads the clock itself,
 * so its fixtures have to be stated relative to now rather than pinned.
 */
const FRESH = () => new Date(Date.now() - 60_000).toISOString();

describe("toInboundItem clamps every scraped field", () => {
  const huge = "y".repeat(25_000);
  it("clamps the reply body AND the thread context", () => {
    const item = toInboundItem(
      {
        tweet_id: "300", handle: "alice", text: huge,
        url: "https://x.com/alice/status/300", posted_at: null, replying_to: ["demooperator"],
      },
      [
        { tweet_id: "100", handle: "carol", text: huge },
        { tweet_id: "200", handle: "demooperator", text: huge },
      ],
      "demooperator",
      "2026-07-26T12:00:00.000Z",
    );
    expect(item.text.length).toBe(MAX_TEXT);
    expect(item.conversation!.root_post_text!.length).toBe(MAX_TEXT);
    expect(item.conversation!.our_reply_text!.length).toBe(MAX_TEXT);
  });
});

// Exercise sweep navigation with injected dependencies. Empty or failed
// notification reads must keep the tab on the notifications page.
describe("runNotificationSweep navigation behaviour", () => {
  const setupChrome = (seen: string[] = []) => {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: { local: { get: async () => ({ [SEEN_KEY]: seen }), set: async () => undefined } },
    };
  };
  const deps = (over: Record<string, unknown>) => ({
    cdp: { wheel: async () => undefined } as never,
    rng: { float: () => 1, int: () => 1, normal: () => 40, gamma: () => 1, next: () => 0.5, pickWeighted: () => 0 } as never,
    sleep: async () => undefined,
    api: { postInboundReplies: async () => ({ accepted: 1, skipped: 0, results: [] }) } as never,
    instanceId: "i",
    wpm: 300,
    stopped: () => false,
    ...over,
  });

  it("with nothing new: opens notifications and NEVER navigates to the feed", async () => {
    setupChrome();
    const urls: string[] = [];
    const out = await runNotificationSweep(1, deps({
      navigate: async (_id: number, url: string) => { urls.push(url); },
      // one cell, but it is a reply to somebody else
      send: async (_id: number, msg: { cmd: string }) =>
        msg.cmd === "readSelfHandle"
          ? { ok: true, handle: "operator" }
          : { ok: true, items: [{ tweet_id: "1", handle: "ada", text: "hi there friend", url: "https://x.com/ada/status/1", posted_at: FRESH(), replying_to: ["someoneelse"] }] },
    }) as never);
    expect(urls).toEqual([NOTIFICATIONS_URL]);
    expect(urls.some((u) => u.includes("/home"))).toBe(false);
    expect(out.fresh).toBe(0);
    expect(out.harvested).toBe(1); // read a cell — distinguishes drift from quiet
  });

  it("when the self-handle cannot be resolved: says so and does not go to the feed", async () => {
    setupChrome();
    const urls: string[] = [];
    const out = await runNotificationSweep(1, deps({
      navigate: async (_id: number, url: string) => { urls.push(url); },
      send: async (_id: number, msg: { cmd: string }) =>
        msg.cmd === "readSelfHandle" ? { ok: true, handle: null } : { ok: true, items: [] },
      configuredHandle: undefined,
    }) as never);
    expect(out.detail).toMatch(/which account is logged in/i);
    expect(urls.some((u) => u.includes("/home"))).toBe(false);
  });

  it("falls back to the operator-configured handle when the DOM read fails", async () => {
    setupChrome();
    const out = await runNotificationSweep(1, deps({
      navigate: async () => undefined,
      send: async (_id: number, msg: { cmd: string }) =>
        msg.cmd === "readSelfHandle"
          ? { ok: true, handle: null }
          : { ok: true, items: [{ tweet_id: "9", handle: "ada", text: "a real question for you?", url: "https://x.com/ada/status/9", posted_at: FRESH(), replying_to: ["operator"] }] },
      configuredHandle: "operator",
    }) as never);
    // It resolved the handle, so the reply WAS recognised as ours.
    expect(out.detail).not.toMatch(/which account/i);
    expect(out.fresh).toBe(1);
  });

  it("after ingesting, returns to notifications — not the feed", async () => {
    setupChrome();
    const urls: string[] = [];
    await runNotificationSweep(1, deps({
      navigate: async (_id: number, url: string) => { urls.push(url); },
      send: async (_id: number, msg: { cmd: string }) => {
        if (msg.cmd === "readSelfHandle") return { ok: true, handle: "operator" };
        if (msg.cmd === "harvestThread") return { ok: true, chain: [{ tweet_id: "0", handle: "carol", text: "root post" }] };
        return { ok: true, items: [{ tweet_id: "9", handle: "ada", text: "a real question for you?", url: "https://x.com/ada/status/9", posted_at: FRESH(), replying_to: ["operator"] }] };
      },
    }) as never);
    expect(urls[0]).toBe(NOTIFICATIONS_URL);
    expect(urls).toContain("https://x.com/ada/status/9"); // opened the thread
    expect(urls[urls.length - 1]).toBe(NOTIFICATIONS_URL); // and came back HERE
    expect(urls.some((u) => u.includes("/home"))).toBe(false);
  });
});

describe("the sweep stays on the notifications page", () => {
  it("targets the All tab, which renders strictly more than /mentions", () => {
    // The All tab carries real replies (article[data-testid="tweet"]) alongside
    // like/follow cards (data-testid="notification"), which the harvester
    // ignores. /mentions would only ever be a subset.
    expect(NOTIFICATIONS_URL).toBe("https://x.com/notifications");
    expect(NOTIFICATIONS_URL).not.toMatch(/mentions/);
  });

  it("never sends the tab to the feed — notifications is home base", () => {
    // The notifications lane keeps its own home page on every exit path.
    expect(NOTIFICATIONS_URL).not.toMatch(/\/home/);
  });

  it("caches a discovered self-handle so one bad DOM read cannot disable the feature", () => {
    expect(SELF_HANDLE_KEY).toBe("actuator.selfHandle");
  });
});

// Adversarial review caught this: `detail` was built over EVERY harvested cell
// and on the whole fresh===0 path, so it blamed the 6h window for zeroes the
// window had nothing to do with — and printed a self-contradictory line
// ("none new within 6h (0 older, 0 undated)"). The notifications page is mostly
// likes, follows and our own tweets, and the steady state after answering
// someone is that their reply sits there, recent and already ingested, for hours.
describe("describeEmptySweep tells the truth about WHICH zero this is", () => {
  const ages = (recent: number, stale: number, undated: number) => ({ recent, stale, undated });

  it("says nothing when the page rendered no cells — the caller's 'selectors may have drifted' is better", () => {
    expect(describeEmptySweep({ harvested: 0, ages: ages(0, 0, 0) })).toBeUndefined();
  });

  it("says nothing when cells were read but none were replies to us", () => {
    // 12 likes and follows is not a 6h-window story.
    expect(describeEmptySweep({ harvested: 12, ages: ages(0, 0, 0) })).toBeUndefined();
  });

  it("blames the window only when the window is actually the reason", () => {
    const d = describeEmptySweep({ harvested: 20, ages: ages(0, 4, 0) })!;
    expect(d).toMatch(/none within 12h/);
    expect(d).toMatch(/4 older/);
  });

  it("names the seen-ring case WITHOUT claiming the person was answered", () => {
    // THE steady state. Saying "none within 6h" here is a flat lie repeated
    // every ten minutes at exactly the moment someone is debugging.
    const d = describeEmptySweep({ harvested: 20, ages: ages(3, 0, 0) })!;
    expect(d).toMatch(/already ingested/);
    expect(d).not.toMatch(/none within/);
  });

  it("calls out a markup break when every candidate is undated", () => {
    const d = describeEmptySweep({ harvested: 9, ages: ages(0, 0, 5) })!;
    expect(d).toMatch(/no readable timestamp/);
    expect(d).toMatch(/markup may have changed/);
  });

  it("never emits a line whose own counts contradict it", () => {
    // The bug in prose form: "3 replies, none within 6h (0 older, 0 undated)".
    // The candidate total is DERIVED from the buckets now, so a caller cannot
    // disagree with itself — this asserts that property directly.
    for (const a of [ages(3, 0, 0), ages(0, 3, 0), ages(0, 0, 3), ages(1, 1, 1), ages(0, 0, 0), ages(2, 5, 1)]) {
      const d = describeEmptySweep({ harvested: 10, ages: a });
      if (!d) continue;
      const total = a.recent + a.stale + a.undated;
      const claimed = Number(/^(\d+)/.exec(d)?.[1] ?? -1);
      if (d.includes("none within")) {
        expect(a.recent).toBe(0);
        expect(claimed).toBe(total); // the headline count IS the candidate count
        expect(d).toContain(`${a.stale} older`);
        expect(d).toContain(`${a.undated} undated`);
      }
      if (d.includes("already ingested")) expect(claimed).toBe(a.recent);
      if (d.includes("no readable timestamp")) expect(a.undated).toBe(total);
    }
  });
});

describe("isReplyToMe — the candidate gate, on its own", () => {
  const item = (handle: string, replying_to: string[]) => ({ handle, replying_to });

  it("accepts somebody else replying to us", () => {
    expect(isReplyToMe(item("alice", ["demooperator"]), "demooperator")).toBe(true);
  });

  it("rejects our own tweet", () => {
    expect(isReplyToMe(item("demooperator", ["demooperator"]), "demooperator")).toBe(false);
  });

  it("rejects a bare mention and a reply to someone else", () => {
    expect(isReplyToMe(item("alice", []), "demooperator")).toBe(false);
    expect(isReplyToMe(item("alice", ["carol"]), "demooperator")).toBe(false);
  });

  it("rejects everything when we don't know our own handle", () => {
    expect(isReplyToMe(item("alice", ["demooperator"]), "")).toBe(false);
  });
});

// End-to-end through the REAL runNotificationSweep: the two cases the reviewer
// demonstrated emitting "3 cells on the page, none new within 6h (0 older, 0
// undated)" — a line that contradicts itself and points a debugger at the age
// parser when the age parser is fine.
describe("the sweep no longer misreports why it did nothing", () => {
  const setupChrome = (seen: string[] = []) => {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: { local: { get: async () => ({ "actuator.seenNotifications": seen }), set: async () => undefined } },
    };
  };
  const base = {
    cdp: { wheel: async () => undefined } as never,
