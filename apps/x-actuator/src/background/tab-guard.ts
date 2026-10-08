import { chooseActuatorTab, type TabRef } from "../lib/feed.js";

const FEED = "https://x.com/home";
const CHILD_TAB_GRACE_MS = 1_000;

export function isXPageUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      ["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname);
  } catch {
    return false;
  }
}

/** Preserve the run's tab even when an accidental link has taken it off X. */
export async function findPinnedXTab(
  pinnedId: number | null | undefined,
  getTab: (id: number) => Promise<TabRef | null>,
  queryXTabs: () => Promise<TabRef[]>,
): Promise<number | null> {
  if (pinnedId != null && await getTab(pinnedId).catch(() => null)) return pinnedId;
  return chooseActuatorTab(await queryXTabs());
}

/** Attribute new tabs to a trusted actor click, never to the tab alone. */
export function createActorClickTabGuard(
  removeTab: (id: number) => Promise<void>,
  now: () => number = Date.now,
) {
  const clicks = new Map<number, { active: number; until: number }>();

  return {
    async duringClick<T>(tabId: number, click: () => Promise<T>): Promise<T> {
      const state = clicks.get(tabId) ?? { active: 0, until: 0 };
      state.active++;
      clicks.set(tabId, state);
      try {
        return await click();
      } finally {
        state.active--;
        state.until = now() + CHILD_TAB_GRACE_MS;
      }
    },
    async onCreated(tab: { id?: number; openerTabId?: number }): Promise<boolean> {
      if (tab.id == null || tab.openerTabId == null || tab.id === tab.openerTabId) return false;
      const state = clicks.get(tab.openerTabId);
      if (!state) return false;
      if (state.active === 0 && now() > state.until) {
        clicks.delete(tab.openerTabId);
        return false;
      }
      await removeTab(tab.id).catch(() => {});
      return true;
    },
  };
}

/** Recover the exact pinned tab, after checking the run is still live. */
export async function restorePinnedXTab(tabId: number, deps: {
  isLive: () => Promise<boolean>;
  getTab: () => Promise<{ url?: string; pendingUrl?: string } | null>;
  navigate: (id: number, url: string) => Promise<void>;
}): Promise<boolean> {
  if (!await deps.isLive()) return false;
  const tab = await deps.getTab().catch(() => null);
  const destination = tab?.pendingUrl ?? tab?.url;
  if (!destination || isXPageUrl(destination)) return false;
  if (!await deps.isLive()) return false;
  await deps.navigate(tabId, FEED);
  return true;
}
