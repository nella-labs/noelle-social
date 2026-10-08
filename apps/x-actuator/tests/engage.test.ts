import { afterEach, describe, it, expect, vi } from "vitest";
import { makeRng } from "../src/lib/rng.js";
import type { EngagementKind } from "../src/lib/engagement.js";
import { reactWithVariety, rectFrom, type Rect, type EngageLocate } from "../src/background/engage.js";

// The pre-scroll rect the like-locate measured. If any post-scroll path clicks
// THIS rect, the stale-rect regression is back (a trusted CDP click at dead
// viewport coordinates on a live x.com page — can hit a link/follow/reply of a
// DIFFERENT tweet).
const LIKE_RECT: Rect = { x: 10, y: 10, width: 40, height: 20 };
const RETWEET_LOC: EngageLocate = { ok: true, x: 320, y: 160, rect: { x: 300, y: 150, width: 40, height: 20 } };
const CONFIRM_LOC: EngageLocate = { ok: true, x: 220, y: 270, rect: { x: 200, y: 260, width: 40, height: 20 } };
const FRESH_LIKE_LOC: EngageLocate = { ok: true, x: 30, y: 510, rect: { x: 12, y: 500, width: 40, height: 20 } };
const BOOKMARK_LOC: EngageLocate = { ok: true, x: 420, y: 160, rect: { x: 400, y: 150, width: 40, height: 20 } };
const MISS: EngageLocate = { ok: false };

const TID = "1800000000000000001";

// Forcing weights beats stubbing the RNG: an all-zero-but-one table makes
// pickEngagement deterministic while the real rng still drives the sleeps.
const FORCE = {
  like: { like: 1, bookmark: 0, repost: 0 } as Partial<Record<EngagementKind, number>>,
  bookmark: { like: 0, bookmark: 1, repost: 0 } as Partial<Record<EngagementKind, number>>,
  repost: { like: 0, bookmark: 0, repost: 1 } as Partial<Record<EngagementKind, number>>,
};

interface Call { kind: "click" | "locate" | "confirm" | "dismiss"; rect?: Rect; engagement?: EngagementKind }

function fakeDeps(opts: {
  engagementLoc?: EngageLocate | null | (() => never);
  freshLikeLoc?: EngageLocate | null;
  confirmLoc?: EngageLocate | null;
}) {
  const calls: Call[] = [];
  return {
    calls,
    deps: {
      click: async (rect: Rect) => { calls.push({ kind: "click", rect }); },
      locateEngagement: async (engagement: EngagementKind, _tweetId: string | null) => {
        calls.push({ kind: "locate", engagement });
        if (engagement === "like") return opts.freshLikeLoc ?? MISS;
        const v = opts.engagementLoc;
        if (typeof v === "function") throw new Error("content script gone");
        return v === undefined ? MISS : v;
      },
      locateRepostConfirm: async () => { calls.push({ kind: "confirm" }); return opts.confirmLoc ?? MISS; },
      dismissMenu: async () => { calls.push({ kind: "dismiss" }); },
      sleep: async () => {},
    },
  };
}

const clicks = (calls: Call[]) => calls.filter((c) => c.kind === "click").map((c) => c.rect);

const background = vi.hoisted(() => ({ click: vi.fn(), log: vi.fn() }));
vi.mock("../src/background/cdp.js", () => ({ Cdp: class {
  attach = async () => {};
  detachAll = async () => {};
  wheel = async () => {};
  moveAndClick = background.click;
} }));
vi.mock("../src/lib/api.js", () => ({ ActuatorApi: class {
  fetchQueue = async () => ({ comments: [], dms: [] });
  logActivity = background.log;
} }));

describe("reactWithVariety (engage.ts stale-rect discipline)", () => {
  it("default weights: one click on the (still-valid) like rect, no locates", async () => {
    const { deps, calls } = fakeDeps({});
    const out = await reactWithVariety(LIKE_RECT, TID, undefined, makeRng(1), deps);
    expect(out).toBe("like");
    expect(clicks(calls)).toEqual([LIKE_RECT]);
    expect(calls.some((c) => c.kind === "locate")).toBe(false);
  });

  it("bookmark hit: clicks the freshly-located bookmark rect", async () => {
    const { deps, calls } = fakeDeps({ engagementLoc: BOOKMARK_LOC });
    const out = await reactWithVariety(LIKE_RECT, TID, FORCE.bookmark, makeRng(2), deps);
    expect(out).toBe("bookmark");
    expect(clicks(calls)).toEqual([BOOKMARK_LOC.rect]);
  });

  it("engagement locate MISS (no scroll happened): plain-like fallback on the original rect is safe", async () => {
    const { deps, calls } = fakeDeps({ engagementLoc: MISS });
    const out = await reactWithVariety(LIKE_RECT, TID, FORCE.repost, makeRng(3), deps);
    expect(out).toBe("like");
    expect(clicks(calls)).toEqual([LIKE_RECT]);
  });

  it("engagement locate THROWS: skips because the response cannot prove the viewport stayed put", async () => {
    const { deps, calls } = fakeDeps({ engagementLoc: (() => { throw new Error("gone"); }) as unknown as () => never });
    const out = await reactWithVariety(LIKE_RECT, TID, FORCE.bookmark, makeRng(4), deps);
    expect(out).toBeNull();
    expect(clicks(calls)).toEqual([]);
  });

  it("never reuses the old rect when a locator scrolls before its response is lost", async () => {
    const { deps, calls } = fakeDeps({});
    let scrolled = false;
    deps.locateEngagement = async (engagement) => {
      calls.push({ kind: "locate", engagement });
      scrolled = true;
      throw new Error("message response lost after scroll");
    };
    const out = await reactWithVariety(LIKE_RECT, TID, FORCE.bookmark, makeRng(4), deps);
    expect(scrolled).toBe(true);
    expect(out).toBeNull();
    expect(clicks(calls)).toEqual([]);
  });

  it.each([null, { ok: true }])("skips an uncertain locator response %s", async (loc) => {
    const { deps, calls } = fakeDeps({ engagementLoc: loc });
    const out = await reactWithVariety(LIKE_RECT, TID, FORCE.bookmark, makeRng(4), deps);
    expect(out).toBeNull();
    expect(clicks(calls)).toEqual([]);
  });

  it("repost + confirm hit: retweet then confirm, never the like rect", async () => {
    const { deps, calls } = fakeDeps({ engagementLoc: RETWEET_LOC, confirmLoc: CONFIRM_LOC });
    const out = await reactWithVariety(LIKE_RECT, TID, FORCE.repost, makeRng(5), deps);
    expect(out).toBe("repost");
    expect(clicks(calls)).toEqual([RETWEET_LOC.rect, CONFIRM_LOC.rect]);
  });

  it("REGRESSION: repost confirm MISS → dismisses the menu, then clicks ONLY a freshly re-located like rect (never the stale pre-scroll rect)", async () => {
    const { deps, calls } = fakeDeps({ engagementLoc: RETWEET_LOC, confirmLoc: MISS, freshLikeLoc: FRESH_LIKE_LOC });
    const out = await reactWithVariety(LIKE_RECT, TID, FORCE.repost, makeRng(6), deps);
    expect(out).toBe("like");
    // The stale pre-scroll LIKE_RECT is never clicked after locateEngagement scrolled.
    expect(clicks(calls)).toEqual([RETWEET_LOC.rect, FRESH_LIKE_LOC.rect]);
    expect(clicks(calls)).not.toContainEqual(LIKE_RECT);
    // Escape (dismissMenu) runs BEFORE the fresh like locate — the open menu's
    // backdrop would swallow a click and cover the action bar.
    const dismissIdx = calls.findIndex((c) => c.kind === "dismiss");
    const freshIdx = calls.findIndex((c) => c.kind === "locate" && c.engagement === "like");
    expect(dismissIdx).toBeGreaterThan(-1);
    expect(freshIdx).toBeGreaterThan(dismissIdx);
  });

  it("REGRESSION: repost confirm MISS + fresh re-locate MISS → returns null (a skip), fires NO stale click and counts NO like", async () => {
    const { deps, calls } = fakeDeps({ engagementLoc: RETWEET_LOC, confirmLoc: MISS, freshLikeLoc: MISS });
    const out = await reactWithVariety(LIKE_RECT, TID, FORCE.repost, makeRng(7), deps);
    expect(out).toBeNull();
    // Only the retweet click happened; the stale LIKE_RECT was never touched.
    expect(clicks(calls)).toEqual([RETWEET_LOC.rect]);
    expect(calls.some((c) => c.kind === "dismiss")).toBe(true);
  });
});

describe("rectFrom", () => {
  it("passes a real rect through and synthesizes a tiny box from bare x/y", () => {
    expect(rectFrom({ rect: LIKE_RECT })).toEqual(LIKE_RECT);
    expect(rectFrom({ x: 100, y: 50 })).toEqual({ x: 98, y: 48, width: 4, height: 4 });
    expect(rectFrom({ rect: { x: 1, y: 1, width: 0, height: 0 }, x: 100, y: 50 }))
      .toEqual({ x: 98, y: 48, width: 4, height: 4 });
  });
});

describe("background pre-click refresh", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(["lost", "miss", "fresh"])("requires a fresh same-tweet location: %s", async (outcome) => {
    vi.resetModules();
    vi.useFakeTimers();
    background.click.mockReset().mockResolvedValue(undefined);
    background.log.mockReset().mockResolvedValue(undefined);
    const local: Record<string, unknown> = { "actuator.config": {
      apiBaseUrl: "https://api.example.test", token: "test", instanceId: "test",
      caps: { likes: 1, comments: 0, dms: 0 }, preferWatchlistRatio: 0,
      engagementWeights: FORCE.like,
    } };
    const session: Record<string, unknown> = {};
    const storage = (values: Record<string, unknown>) => ({
      get: async (keys: string | string[]) => Object.fromEntries(
        (Array.isArray(keys) ? keys : [keys]).map((key) => [key, values[key]]),
      ),
      set: async (updates: Record<string, unknown>) => { Object.assign(values, updates); },
      remove: async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
      },
    });
    let message: (msg: unknown, sender: unknown, reply: (response: unknown) => void) => void;
    let scrolled = false;
    const sendMessage = vi.fn(async (_tab: number, msg: { cmd: string; tweet_id?: string }) => {
      if (msg.cmd === "detectChallenge") return { observed: { challenge: false } };
      if (msg.cmd === "locateLike") return { ok: true, x: 30, y: 20, rect: LIKE_RECT,
        observed: { tweet_id: TID, wordCount: 0 } };
      if (msg.cmd === "locateEngagement") {
        expect(msg.tweet_id).toBe(TID);
        if (outcome === "miss") return MISS;
        scrolled = true;
        if (outcome === "lost") throw new Error("message response lost after scroll");
        return FRESH_LIKE_LOC;
      }
      throw new Error(`unexpected command ${msg.cmd}`);
    });
    const addListener = () => {};
    vi.stubGlobal("chrome", {
      storage: { local: storage(local), session: storage(session) },
      tabs: { sendMessage, get: async () => ({ id: 1, url: "https://x.com/home", status: "complete" }),
        query: async () => [{ id: 1, url: "https://x.com/home" }],
        onCreated: { addListener }, onUpdated: { addListener } },
      alarms: { create: async () => {}, clear: async () => {}, onAlarm: { addListener } },
      runtime: { onStartup: { addListener }, onInstalled: { addListener }, onMessage: {
        addListener: (listener: typeof message) => { message = listener; },
      } },
    });
    await import("../src/background/index.js");
    const command = (cmd: string, params?: unknown) => new Promise<void>((resolve) => {
      message({ cmd, params }, null, (response) => {
        expect(response).toEqual({ ok: true });
        resolve();
      });
    });
    await command("startRun", { windowHours: 1, targetComments: 0, targetLikes: 1 });
    vi.clearAllTimers();
    const state = Object.values(session).find((value) => value && typeof value === "object"
      && "sessionId" in value) as { actions: unknown[]; warmupSuppressMs: number; done: { likes: number } };
    state.actions = [{ kind: "like", atMs: Date.now() - 1, executed: false }];
    state.warmupSuppressMs = 0;
    const tick = command("tick");
    await vi.runAllTimersAsync();
    await tick;
    expect(scrolled).toBe(outcome !== "miss");
    if (outcome === "fresh") {
      expect(background.click).toHaveBeenCalledWith(1, FRESH_LIKE_LOC.rect, expect.anything(), expect.anything());
      expect(state.done.likes).toBe(1);
    } else {
      expect(background.click).not.toHaveBeenCalled();
      expect(state.done.likes).toBe(0);
    }
  });
});
