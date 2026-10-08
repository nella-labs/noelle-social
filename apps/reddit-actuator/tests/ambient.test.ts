import { describe, it, expect } from "vitest";
import { chooseAmbient, runAmbient, type AmbientDeps } from "../src/background/ambient.js";
import { makeRng } from "../src/lib/rng.js";

// The idle-upvote gate (Reddit's analog of LinkedIn's shouldIdleLike) is
// canUpvoteNow in src/background/state.ts, covered in tests/runstate.test.ts.
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

describe("runAmbient navigate", () => {
  // Orion's ambient hop-away-and-back called chrome.tabs.update DIRECTLY, so it
  // was the one navigation that never cleared the composer first — the path
  // #554-556 left standing on all three actuators. Ambient runs BETWEEN actions,
  // which makes it the navigation most likely to follow a reply that left text
  // in the box.
  //
  // Restoring the direct call fails this twice over: `navigated` stays empty,
  // and `chrome` is not even defined under the test environment — which is
  // precisely why this branch went uncovered for so long.
  it("hops away and back through the injected navigate, never chrome.tabs directly", async () => {
    const navigated: string[] = [];
    const deps: AmbientDeps = {
      cdp: {
        moveAndClick: async () => {},
        wheel: async () => {},
      } as unknown as AmbientDeps["cdp"],
      rng: makeRng(7),
      sleep: async () => {},
      send: (async () => ({ ok: false })) as unknown as AmbientDeps["send"],
      wpm: 240,
      navigate: async (_t: number, url: string) => { navigated.push(url); },
    };
    const did = await runAmbient(1, "navigate", deps);
    expect(did).toBe("navigate");
    expect(navigated).toHaveLength(2);
    expect(navigated[1]).toBe("https://www.reddit.com/"); // and back to the feed
  });
});
