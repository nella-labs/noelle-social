import { describe, it, expect } from "vitest";
import { chooseAmbient, runAmbient, shouldIdleLike, type AmbientDeps } from "../src/background/ambient.js";
import { makeRng } from "../src/lib/rng.js";

describe("chooseAmbient", () => {
  it("returns scroll the large majority of the time (no read actions)", () => {
    const rng = makeRng(11);
    let scroll = 0;
    for (let i = 0; i < 1000; i++) if (chooseAmbient(rng) === "scroll") scroll++;
    expect(scroll).toBeGreaterThan(750); // ~88% expected
    expect(scroll).toBeLessThan(1000);    // navigate happens sometimes
  });

  it("is deterministic for a seed", () => {
    const seq = (s: number) => Array.from({ length: 5 }, () => chooseAmbient(makeRng(s)));
    expect(seq(3)).toEqual(seq(3));
  });

  it("leans toward expand (…more) when read actions are allowed", () => {
    const rng = makeRng(21);
    const counts: Record<string, number> = { scroll: 0, expand: 0, comments: 0, navigate: 0 };
    for (let i = 0; i < 4000; i++) counts[chooseAmbient(rng, { readActionsAllowed: true })]!++;
    expect(counts.expand).toBeGreaterThan(1000); // ~34% — the dominant read-action
    expect(counts.comments).toBeGreaterThan(500); // ~20%
    expect(counts.navigate).toBeGreaterThan(100); // ~6%, still present
    expect(counts.navigate).toBeLessThan(counts.expand!); // navigate stays rare
    // Read-actions (expand + comments) are the majority — the actor actively
    // opens posts while waiting rather than only scrolling.
    expect(counts.expand! + counts.comments!).toBeGreaterThan(counts.scroll!);
    // expand is the single most common read-action.
    expect(counts.expand).toBeGreaterThan(counts.comments!);
  });

  it("never surfaces read actions when they are not allowed (cooldown/off)", () => {
    const rng = makeRng(22);
    for (let i = 0; i < 2000; i++) {
      const k = chooseAmbient(rng, { readActionsAllowed: false });
      expect(k === "scroll" || k === "navigate").toBe(true);
    }
  });
});

describe("shouldIdleLike", () => {
  const base = { doneLikes: 0, targetLikes: 10, inCurfew: false, sinceLastIdleLikeMs: 60_000, minGapMs: 45_000 };

  it("likes in the wait when there is budget, no curfew, and the cooldown elapsed", () => {
    expect(shouldIdleLike(base)).toBe(true);
  });

  it("respects the like budget (never exceeds the cap-bounded target)", () => {
    expect(shouldIdleLike({ ...base, doneLikes: 10, targetLikes: 10 })).toBe(false);
    expect(shouldIdleLike({ ...base, doneLikes: 11, targetLikes: 10 })).toBe(false);
    expect(shouldIdleLike({ ...base, doneLikes: 9, targetLikes: 10 })).toBe(true);
  });

  it("never likes while the write-curfew gate is on", () => {
    expect(shouldIdleLike({ ...base, inCurfew: true })).toBe(false);
    expect(shouldIdleLike({ ...base, inCurfew: false })).toBe(true);
  });

  it("paces likes: not before the cooldown elapses", () => {
    expect(shouldIdleLike({ ...base, sinceLastIdleLikeMs: 44_999 })).toBe(false);
    expect(shouldIdleLike({ ...base, sinceLastIdleLikeMs: 45_000 })).toBe(true);
  });

  it("stays quiet through a like-free drain gap (the cooldown pattern)", () => {
    expect(shouldIdleLike({ ...base, inQuietGap: true })).toBe(false);
    expect(shouldIdleLike({ ...base, inQuietGap: false })).toBe(true);
  });

  it("never idle-likes in drain mode — gaps take only their planned like slots", () => {
    // 2026-07-23 quiet re-tune: the idle top-up used to race ahead of the drain
    // plan on the shared budget (~10 likes before a reply). Drain waits are now
    // ambient-browse only, regardless of the other gates.
    expect(shouldIdleLike({ ...base, inDrain: true })).toBe(false);
    expect(shouldIdleLike({ ...base, inDrain: true, inQuietGap: false })).toBe(false);
    expect(shouldIdleLike({ ...base, inDrain: false })).toBe(true);
  });
});

function fakeDeps(sendResult: unknown) {
  const moved: Array<{ x: number; y: number; width: number; height: number }> = [];
  const wheeled: number[] = [];
  const sent: string[] = [];
  const navigated: string[] = [];
  const cdp = {
    moveAndClick: async (_t: number, rect: { x: number; y: number; width: number; height: number }) => { moved.push(rect); },
    wheel: async (_t: number, _at: unknown, px: number) => { wheeled.push(px); },
  } as unknown as AmbientDeps["cdp"];
  const send = async <T,>(_t: number, msg: unknown): Promise<T> => { sent.push((msg as { cmd: string }).cmd); return sendResult as T; };
  const navigate = async (_t: number, url: string) => { navigated.push(url); };
  const deps: AmbientDeps = { cdp, rng: makeRng(7), sleep: async () => {}, send, wpm: 240, navigate };
  return { deps, moved, wheeled, sent, navigated };
}

describe("runAmbient read-actions", () => {
  it("expand: clicks the located see-more, then reads", async () => {
    const { deps, moved, sent } = fakeDeps({ ok: true, rect: { x: 5, y: 6, width: 40, height: 20 }, observed: { wordCount: 80 } });
    const did = await runAmbient(1, "expand", deps);
    expect(did).toBe("expand");
    expect(sent).toContain("locateAmbientExpand");
    expect(moved).toHaveLength(1);
  });

  it("expand: downgrades to a scroll when nothing is truncated in view", async () => {
    const { deps, moved, wheeled } = fakeDeps({ ok: false, skipReason: "no-truncated-post" });
    const did = await runAmbient(1, "expand", deps);
    expect(did).toBe("scroll");
    expect(moved).toHaveLength(0);
    expect(wheeled).toHaveLength(1); // scrolled instead of clicking
  });

  it("comments: opens the thread (click) then reads (scroll)", async () => {
    const { deps, moved, wheeled } = fakeDeps({ ok: true, rect: { x: 1, y: 2, width: 30, height: 16 } });
    const did = await runAmbient(1, "comments", deps);
    expect(did).toBe("comments");
    expect(moved).toHaveLength(1);
    expect(wheeled).toHaveLength(1);
  });

  it("comments: downgrades to a scroll when no post exposes comments", async () => {
    const { deps, moved, wheeled } = fakeDeps({ ok: false });
    const did = await runAmbient(1, "comments", deps);
    expect(did).toBe("scroll");
    expect(moved).toHaveLength(0);
    expect(wheeled).toHaveLength(1);
  });

  it("scroll: wheels the feed and reports scroll", async () => {
    const { deps, moved, wheeled } = fakeDeps({ ok: false });
    const did = await runAmbient(1, "scroll", deps);
    expect(did).toBe("scroll");
    expect(moved).toHaveLength(0);
    expect(wheeled).toHaveLength(1);
  });

  // The ambient hop-away-and-back called chrome.tabs.update DIRECTLY, so it was
  // the one navigation that never cleared the composer first — the path #554-556
  // left standing. Ambient runs BETWEEN actions, which makes it the navigation
  // most likely to follow a reply that left text in the box, and this is Lyra,
  // whose stuck composer is the failure that was actually reported.
  //
  // Restoring the direct call fails this twice over: `navigated` stays empty,
  // and `chrome` is not even defined under the test environment — which is
  // precisely why this branch went uncovered for so long.
  it("navigate: hops away and back through the injected navigate, never chrome.tabs directly", async () => {
    const { deps, navigated } = fakeDeps({ ok: false });
    const did = await runAmbient(1, "navigate", deps);
    expect(did).toBe("navigate");
    expect(navigated).toHaveLength(2);
    expect(navigated[1]).toBe("https://www.linkedin.com/feed/"); // and back to the feed
  });
});
