import { describe, it, expect } from "vitest";
import {
  describeEmptySweep,
  chooseIdleActivity,
  runNotificationSweep,
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
  // before the lane flag and the gap, so nothing can make a sweep due while the
  // feature is off. Flip the constant back and these become `true` again.
  it("cannot sweep on a fresh notifications run while the feature is off", () => {
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

  it("keeps the documented cap sane", () => {
    expect(SEEN_CAP).toBeGreaterThan(MAX_PER_SWEEP * 20);
  });
});

describe("toInboundItem", () => {
  const harvested = {
    external_id: "urn:li:activity:7300000000000000000:alice-smith",
    public_id: "alice-smith",
    name: "Alice Smith",
    text: "great point",
    url: "https://www.linkedin.com/feed/update/urn:li:activity:7300000000000000000/",
    activity_urn: "urn:li:activity:7300000000000000000",
    post_context: "",
    age_minutes: 120,
  };

  it("carries the comment and keys the conversation on the post", () => {
    expect(toInboundItem(harvested, "2026-07-26T12:00:00.000Z")).toEqual({
      external_id: "urn:li:activity:7300000000000000000:alice-smith",
      author_handle: "alice-smith",
      text: "great point",
      url: "https://www.linkedin.com/feed/update/urn:li:activity:7300000000000000000/",
      posted_at: "2026-07-26T12:00:00.000Z",
      conversation: { root_post_id: "urn:li:activity:7300000000000000000" },
    });
  });

  it("omits the conversation when the urn couldn't be derived", () => {
    // Without a root the server's turn cap falls back to keying on the person,
    // so the conversation still can't ping-pong.
    expect(toInboundItem({ ...harvested, activity_urn: null }, "2026-07-26T12:00:00.000Z")).not.toHaveProperty(
      "conversation",
    );
  });

  it("stamps the sweep time — LinkedIn cards carry no machine-readable timestamp", () => {
    expect(toInboundItem(harvested, "2026-07-26T12:00:00.000Z").posted_at).toBe("2026-07-26T12:00:00.000Z");
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

// A content script connection failure must remain distinct from an empty inbox.
describe("a page that does not answer is not an empty inbox", () => {
  const setupChrome = () => {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: { local: { get: async () => ({}), set: async () => undefined } },
    };
  };
  const base = {
    cdp: { wheel: async () => undefined } as never,
    rng: { float: () => 1, int: () => 1, normal: () => 40, gamma: () => 1, next: () => 0.5, pickWeighted: () => 0 } as never,
    sleep: async () => undefined,
    api: { postInboundReplies: async () => ({ accepted: 1, skipped: 0, results: [] }) } as never,
    instanceId: "i",
    wpm: 300,
    stopped: () => false,
    navigate: async () => undefined,
  };

  it("reports NO RESPONSE when the content script never answers", async () => {
    setupChrome();
    const out = await runNotificationSweep(1, {
      ...base,
      // Exactly what happens after chrome.tabs.update destroys the content
      // script: every sendMessage rejects.
      send: async () => { throw new Error("Receiving end does not exist"); },
    } as never);
    expect(out.detail).toMatch(/did not respond/i);
    expect(out.detail).toMatch(/Receiving end does not exist/);
    // The critical bit: it must NOT claim an empty inbox.
    expect(out.detail).not.toMatch(/nothing new/i);
  });

  it("retries a half-rendered list instead of believing the first empty answer", async () => {
    setupChrome();
    let calls = 0;
    const out = await runNotificationSweep(1, {
      ...base,
      send: async () => {
        calls++;
        // The list hydrates on the 3rd ask — the async render this used to race.
        if (calls < 3) return { ok: true, items: [] };
        return { ok: true, items: [{
          external_id: "urn:li:comment:1", public_id: "mara", name: "Mara",
