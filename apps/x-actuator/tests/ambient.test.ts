import { describe, it, expect } from "vitest";
import { chooseAmbient, runAmbient, shouldIdleLike, submitObservationBatch, type AmbientDeps } from "../src/background/ambient.js";
import { makeRng } from "../src/lib/rng.js";

describe("confirmed X observation capacity", () => {
  it("releases all eleven reserved slots when the API confirms eleven duplicates", async () => {
    const budget = { remaining: 11 };
    expect(await submitObservationBatch(Array.from({ length: 11 }, (_, i) => i), budget,
      async () => ({ accepted: 0, duplicates: 11, invalid: 0 }))).toBe(0);
    expect(budget.remaining).toBe(11);
  });

  it("keeps only confirmed new posts charged to this read", async () => {
    const budget = { remaining: 11 };
    expect(await submitObservationBatch(Array.from({ length: 11 }, (_, i) => i), budget,
      async () => ({ accepted: 3, duplicates: 7, invalid: 1 }))).toBe(3);
    expect(budget.remaining).toBe(8);
  });

  it("does not refund an ambiguous failed submission", async () => {
    const budget = { remaining: 11 };
    await expect(submitObservationBatch([1, 2], budget, async () => { throw new Error("network lost"); }))
      .rejects.toThrow("network lost");
    expect(budget.remaining).toBe(9);
  });

  it("does not refund an incomplete API acknowledgement", async () => {
    const budget = { remaining: 11 };
    await expect(submitObservationBatch([1, 2], budget, async () => ({ accepted: 0, duplicates: 1, invalid: 0 })))
      .rejects.toThrow("invalid X observation acknowledgement");
    expect(budget.remaining).toBe(9);
  });
});

describe("chooseAmbient", () => {
  it("only scrolls when read actions are unavailable", () => {
    const rng = makeRng(11);
    for (let i = 0; i < 1000; i++) expect(chooseAmbient(rng)).toBe("scroll");
  });

  it("is deterministic for a seed", () => {
    const seq = (s: number) => Array.from({ length: 5 }, () => chooseAmbient(makeRng(s)));
    expect(seq(3)).toEqual(seq(3));
  });

  it("only expands or scrolls when read actions are allowed", () => {
    const rng = makeRng(21);
    const counts: Record<string, number> = { scroll: 0, expand: 0, comments: 0, navigate: 0 };
    for (let i = 0; i < 4000; i++) counts[chooseAmbient(rng, { readActionsAllowed: true })]!++;
    expect(counts.expand).toBeGreaterThan(1000); // ~45% — the only click action
    expect(counts.scroll).toBeGreaterThan(1000);
    expect(counts.comments).toBe(0);
    expect(counts.navigate).toBe(0);
  });

  it("never surfaces read actions when they are not allowed (cooldown/off)", () => {
    const rng = makeRng(22);
    for (let i = 0; i < 2000; i++) {
      const k = chooseAmbient(rng, { readActionsAllowed: false });
      expect(k).toBe("scroll");
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

  it("never idle-likes during a DRAIN at all — a gap takes only its planned slots", () => {
    // Ported with #497. Idle-likes were already budget-bounded, but they raced
    // ahead of the plan on a flat drip, flattening the per-gap patterns (#471)
    // into one uniform cadence. Deleting the `inDrain` guard makes this fail.
    expect(shouldIdleLike({ ...base, inDrain: true })).toBe(false);
    expect(shouldIdleLike({ ...base, inDrain: false })).toBe(true);
    // inDrain wins over every other permissive combination.
    expect(shouldIdleLike({ ...base, inDrain: true, inQuietGap: false, sinceLastIdleLikeMs: 10_000_000 })).toBe(false);
  });
});

function fakeDeps(sendResult: unknown) {
  const moved: Array<{ x: number; y: number; width: number; height: number }> = [];
  const wheeled: number[] = [];
  const sent: string[] = [];
  const navigated: string[] = [];
  const events: string[] = [];
  const cdp = {
    wheel: async (_t: number, _at: unknown, px: number) => { wheeled.push(px); events.push("wheel"); },
  } as unknown as AmbientDeps["cdp"];
  const click: AmbientDeps["click"] = async (_t, rect) => { moved.push(rect); events.push("click"); };
  const send = async <T,>(_t: number, msg: unknown): Promise<T> => { sent.push((msg as { cmd: string }).cmd); return sendResult as T; };
  const navigate = async (_t: number, url: string) => { navigated.push(url); events.push(`navigate:${url}`); };
  const deps: AmbientDeps = { cdp, click, rng: makeRng(7), sleep: async () => { events.push("sleep"); }, send, wpm: 240, navigate };
  return { deps, moved, wheeled, sent, navigated, events };
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
    const { deps, moved, wheeled } = fakeDeps({ ok: false, skipReason: "no-truncated-tweet" });
    const did = await runAmbient(1, "expand", deps);
    expect(did).toBe("scroll");
    expect(moved).toHaveLength(0);
    expect(wheeled).toHaveLength(1); // scrolled instead of clicking
  });

  it("does not open comments even if a legacy comments action reaches the runner", async () => {
    const { deps, moved, wheeled } = fakeDeps({ ok: true, rect: { x: 1, y: 2, width: 30, height: 16 } });
    const did = await runAmbient(1, "comments", deps);
    expect(did).toBe("scroll");
    expect(moved).toHaveLength(0);
    expect(wheeled).toHaveLength(1);
  });

  it("comments: downgrades to a scroll when no tweet exposes replies", async () => {
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

  it("does not navigate to decoy pages without an explicit X discovery target", async () => {
    const { deps, navigated } = fakeDeps({ ok: false });
    const did = await runAmbient(1, "navigate", deps);
    expect(did).toBe("scroll");
    expect(navigated).toHaveLength(0);
  });

  it("discovery reads an explicit X target and returns to the feed", async () => {
    const { deps, navigated } = fakeDeps({ ok: false });
    const readAt: string[] = [];
    deps.navigationTarget = "https://x.com/jackfriks";
    deps.onPageRead = async () => { readAt.push(navigated.at(-1)!); };
    await runAmbient(1, "navigate", deps);
    expect(navigated).toEqual(["https://x.com/jackfriks", "https://x.com/home"]);
    expect(readAt).toEqual(["https://x.com/jackfriks"]);
  });

  it("reads a keyword search twice with one paced scroll between reads", async () => {
    const { deps, events, moved, navigated, wheeled } = fakeDeps({ ok: false });
    const target = "https://x.com/search?q=AI&f=top";
    deps.navigationTarget = target;
    deps.canReadMore = () => true;
    deps.onPageRead = async () => { events.push("read"); };
    expect(await runAmbient(1, "navigate", deps)).toBe("navigate");
    expect(events).toEqual([
      `navigate:${target}`, "sleep", "read", "wheel", "sleep", "read",
      "navigate:https://x.com/home", "sleep",
    ]);
    expect(navigated).toEqual([target, "https://x.com/home"]);
    expect(wheeled).toHaveLength(1);
    expect(moved).toHaveLength(0);
  });

  it("retries one broader search when both reads of the saved query are empty", async () => {
    const { deps, events, navigated } = fakeDeps({ ok: false });
    const target = "https://x.com/search?q=%28%22agent%20stack%22%29%20%28%22duct%20tape%22%29&f=live";
    const fallback = "https://x.com/search?q=%28%22agent%20stack%22%29&f=live";
    const reads = [0, 0, 3];
    deps.navigationTarget = target;
    deps.canReadMore = () => true;
