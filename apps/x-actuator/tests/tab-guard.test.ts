import { describe, expect, it } from "vitest";
import { createActorClickTabGuard, findPinnedXTab, restorePinnedXTab } from "../src/background/tab-guard.js";

describe("findPinnedXTab", () => {
  const xTabs = [
    { id: 3, url: "https://x.com/home" },
    { id: 4, url: "https://x.com/profile" },
  ];

  it("keeps a live pinned tab even when a link has moved it off X", async () => {
    const id = await findPinnedXTab(9, async () => ({ id: 9, url: "https://example.com" }), async () => xTabs);
    expect(id).toBe(9);
  });

  it("re-picks an X home tab only after the pinned tab closes", async () => {
    const id = await findPinnedXTab(9, async () => null, async () => xTabs);
    expect(id).toBe(3);
  });
});

describe("createActorClickTabGuard", () => {
  it("closes only a new child opened from the actor tab during its own click", async () => {
    const removed: number[] = [];
    let releaseClick!: () => void;
    const clickPending = new Promise<void>((resolve) => { releaseClick = resolve; });
    const guard = createActorClickTabGuard(async (id) => { removed.push(id); });
    const click = guard.duringClick(9, () => clickPending);

    expect(await guard.onCreated({ id: 21, openerTabId: 4 })).toBe(false);
    expect(await guard.onCreated({ id: 22 })).toBe(false);
    expect(await guard.onCreated({ id: 23, openerTabId: 9 })).toBe(true);
    expect(removed).toEqual([23]);
    releaseClick();
    await click;
  });

  it("does not close a later user-created child of the same tab", async () => {
    let now = 1_000;
    const removed: number[] = [];
    const guard = createActorClickTabGuard(async (id) => { removed.push(id); }, () => now);
    await guard.duringClick(9, async () => undefined);
    now += 2_000;
    expect(await guard.onCreated({ id: 24, openerTabId: 9 })).toBe(false);
    expect(removed).toEqual([]);
  });
});

describe("restorePinnedXTab", () => {
  it("returns a pinned tab to X when its next navigation leaves the site", async () => {
    const navigated: string[] = [];
    const restored = await restorePinnedXTab(9, {
      isLive: async () => true,
      getTab: async () => ({ url: "https://x.com/home", pendingUrl: "https://example.com/article" }),
      navigate: async (_id, url) => { navigated.push(url); },
    });
    expect(restored).toBe(true);
    expect(navigated).toEqual(["https://x.com/home"]);
  });

  it("leaves X pages and tabs from a stopped run alone", async () => {
    const navigated: string[] = [];
    const deps = {
      isLive: async () => true,
      getTab: async () => ({ url: "https://x.com/someone/status/123" }),
      navigate: async (_id: number, url: string) => { navigated.push(url); },
    };
    expect(await restorePinnedXTab(9, deps)).toBe(false);
    expect(await restorePinnedXTab(9, { ...deps, isLive: async () => false,
      getTab: async () => ({ url: "https://example.com" }) })).toBe(false);
    expect(navigated).toEqual([]);
  });
});
