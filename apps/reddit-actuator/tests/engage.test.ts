import { describe, it, expect } from "vitest";
import { makeRng } from "../src/lib/rng.js";
import type { EngagementKind } from "../src/lib/engagement.js";
import {
  engageWithVariety, rectFrom,
  type Rect, type EngageLocate, type EngageDeps, type UpvoteOutcome,
} from "../src/background/engage.js";

const SAVE_OPENER_NEW: EngageLocate = {
  ok: true, x: 300, y: 150, rect: { x: 290, y: 140, width: 30, height: 20 },
  observed: { needsMenu: true, post_id: "abc123", subreddit: "SaaS" },
};
const SAVE_LINK_OLD: EngageLocate = {
  ok: true, x: 120, y: 200, rect: { x: 110, y: 190, width: 40, height: 16 },
  observed: { needsMenu: false, post_id: "old1", subreddit: "webdev" },
};
const SAVE_ITEM: EngageLocate = { ok: true, x: 320, y: 220, rect: { x: 300, y: 210, width: 80, height: 24 } };
const MISS: EngageLocate = { ok: false };
const UP_OK: UpvoteOutcome = { ok: true, post_id: "up42", subreddit: "reactjs" };

// Forcing weights beats stubbing the RNG: an all-zero-but-one table makes
// pickEngagement deterministic while the real rng still drives the sleeps.
const FORCE = {
  upvote: { upvote: 1, save: 0 } as Partial<Record<EngagementKind, number>>,
  save: { upvote: 0, save: 1 } as Partial<Record<EngagementKind, number>>,
};

interface Call { kind: "upvote" | "locateSave" | "locateSaveItem" | "click" | "dismiss"; rect?: Rect }

function fakeDeps(opts: {
  saveLoc?: EngageLocate | null | "throw";
  saveItemLoc?: EngageLocate | null;
  upvote?: UpvoteOutcome;
}) {
  const calls: Call[] = [];
  const deps: EngageDeps = {
    upvote: async () => { calls.push({ kind: "upvote" }); return opts.upvote ?? UP_OK; },
    locateSave: async () => {
      calls.push({ kind: "locateSave" });
      if (opts.saveLoc === "throw") throw new Error("content script gone");
      return opts.saveLoc ?? MISS;
    },
    locateSaveItem: async () => { calls.push({ kind: "locateSaveItem" }); return opts.saveItemLoc ?? MISS; },
    click: async (rect: Rect) => { calls.push({ kind: "click", rect }); },
    dismissMenu: async () => { calls.push({ kind: "dismiss" }); },
    sleep: async () => {},
  };
  return { calls, deps };
}

const clicks = (calls: Call[]) => calls.filter((c) => c.kind === "click").map((c) => c.rect);
const kinds = (calls: Call[]) => calls.map((c) => c.kind);

describe("engageWithVariety (engage.ts — DEFAULT-OFF + fall-back-to-upvote)", () => {
  it("DEFAULT weights: one plain upvote, NO save locate at all (byte-identical to today)", async () => {
    const { deps, calls } = fakeDeps({});
    const out = await engageWithVariety(undefined, makeRng(1), deps);
    expect(out).toEqual({ ok: true, engagement: "upvote", post_id: "up42", subreddit: "reactjs" });
    expect(kinds(calls)).toEqual(["upvote"]); // never touched the save path
  });

  it("forced upvote draw behaves the same (single upvote, no save)", async () => {
    const { deps, calls } = fakeDeps({});
    const out = await engageWithVariety(FORCE.upvote, makeRng(2), deps);
    expect(out.engagement).toBe("upvote");
    expect(calls.some((c) => c.kind === "locateSave")).toBe(false);
  });

  it("save on OLD Reddit (one-click, needsMenu=false): clicks the link, NO menu-item locate", async () => {
    const { deps, calls } = fakeDeps({ saveLoc: SAVE_LINK_OLD });
    const out = await engageWithVariety(FORCE.save, makeRng(3), deps);
    expect(out).toEqual({ ok: true, engagement: "save", post_id: "old1", subreddit: "webdev" });
    expect(clicks(calls)).toEqual([SAVE_LINK_OLD.rect]); // exactly one click, the direct save
    expect(calls.some((c) => c.kind === "locateSaveItem")).toBe(false);
    expect(calls.some((c) => c.kind === "upvote")).toBe(false); // no fallback — the save landed
  });

  it("save on NEW Reddit (two-step): opens the overflow menu, then clicks the Save item", async () => {
    const { deps, calls } = fakeDeps({ saveLoc: SAVE_OPENER_NEW, saveItemLoc: SAVE_ITEM });
    const out = await engageWithVariety(FORCE.save, makeRng(4), deps);
    expect(out).toEqual({ ok: true, engagement: "save", post_id: "abc123", subreddit: "SaaS" });
    expect(clicks(calls)).toEqual([SAVE_OPENER_NEW.rect, SAVE_ITEM.rect]); // opener → item
    expect(calls.some((c) => c.kind === "dismiss")).toBe(false); // menu consumed, not dismissed
  });

  it("FALL-BACK: save locate MISS (no menu opened) → plain upvote, no dismiss", async () => {
    const { deps, calls } = fakeDeps({ saveLoc: MISS });
    const out = await engageWithVariety(FORCE.save, makeRng(5), deps);
    expect(out.engagement).toBe("upvote"); // engagement never lost
    expect(clicks(calls)).toEqual([]); // nothing clicked before the fallback
    expect(calls.some((c) => c.kind === "dismiss")).toBe(false); // no menu was ever opened
    expect(calls.some((c) => c.kind === "upvote")).toBe(true);
  });

  it("FALL-BACK: locateSave THROWS (content script gone) → plain upvote", async () => {
    const { deps, calls } = fakeDeps({ saveLoc: "throw" });
    const out = await engageWithVariety(FORCE.save, makeRng(6), deps);
    expect(out.engagement).toBe("upvote");
    expect(calls.some((c) => c.kind === "upvote")).toBe(true);
  });

  it("FALL-BACK (the core landmine): NEW-Reddit menu opened but Save item MISS → Escape-dismiss THEN plain upvote", async () => {
    const { deps, calls } = fakeDeps({ saveLoc: SAVE_OPENER_NEW, saveItemLoc: MISS });
    const out = await engageWithVariety(FORCE.save, makeRng(7), deps);
    expect(out.engagement).toBe("upvote"); // engagement never lost
    // Only the menu opener was clicked; the fallback upvote re-locates on its own
    // (doUpvote), so no stale item rect is ever clicked.
    expect(clicks(calls)).toEqual([SAVE_OPENER_NEW.rect]);
    // Escape MUST run before the fallback so no open menu is left behind.
    const dismissIdx = calls.findIndex((c) => c.kind === "dismiss");
    const upvoteIdx = calls.findIndex((c) => c.kind === "upvote");
    expect(dismissIdx).toBeGreaterThan(-1);
    expect(upvoteIdx).toBeGreaterThan(dismissIdx);
  });

  it("save fails AND the fallback upvote also misses → ok:false (nothing landed, budget not consumed by the caller)", async () => {
    const { deps } = fakeDeps({ saveLoc: MISS, upvote: { ok: false } });
    const out = await engageWithVariety(FORCE.save, makeRng(8), deps);
    expect(out).toEqual({ ok: false });
  });
});

describe("rectFrom", () => {
  it("passes a real rect through and synthesizes a tiny box from bare x/y", () => {
    expect(rectFrom({ rect: SAVE_ITEM.rect })).toEqual(SAVE_ITEM.rect);
    expect(rectFrom({ x: 100, y: 50 })).toEqual({ x: 98, y: 48, width: 4, height: 4 });
    expect(rectFrom({ rect: { x: 1, y: 1, width: 0, height: 0 }, x: 100, y: 50 }))
      .toEqual({ x: 98, y: 48, width: 4, height: 4 });
  });
});
