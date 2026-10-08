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
