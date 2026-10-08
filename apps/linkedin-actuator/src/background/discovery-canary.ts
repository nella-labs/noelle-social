import type { VisiblePost } from "../content/discovery.js";
import { isHomeFeedUrl } from "../lib/feed.js";

export const DISCOVERY_CANARY_KEY = "actuator.browserDiscoveryCanary";
export const DISCOVERY_STATUS_KEY = "actuator.browserDiscoveryStatus";
export const DISCOVERY_LAST_FAILURE_KEY = "actuator.browserDiscoveryLastFailure";
export const DISCOVERY_READ_INTERVAL_MS = 90_000;
export const MAX_DEFERRED_OBSERVATIONS = 20;
const MAX_OBSERVATIONS_PER_READ = 5;

export function discoveryReadDue(lastReadMs: number, nowMs: number): boolean {
  return nowMs - lastReadMs >= DISCOVERY_READ_INTERVAL_MS;
}

/** Gate the entire browser browse, not just observation submission. */
export async function withDiscoveryBrowseGate(args: {
  enabled: boolean;
  lastReadMs: number;
  nowMs: number;
  capacity(): Promise<number>;
  browse(available: number | null): Promise<void>;
  onCapacityError?(error: unknown): Promise<void>;
  stillCurrent?(): Promise<boolean>;
}): Promise<{ checked: boolean; browsed: boolean }> {
  if (!args.enabled) {
    if (args.stillCurrent && !(await args.stillCurrent())) return { checked: false, browsed: false };
    await args.browse(null);
    return { checked: false, browsed: true };
  }
  if (!discoveryReadDue(args.lastReadMs, args.nowMs)) return { checked: false, browsed: false };
  let available: number;
  try {
    available = await args.capacity();
  } catch (error) {
    await args.onCapacityError?.(error);
    return { checked: true, browsed: false };
  }
  if (available <= 0) return { checked: true, browsed: false };
  if (args.stillCurrent && !(await args.stillCurrent())) return { checked: true, browsed: false };
  await args.browse(available);
  return { checked: true, browsed: true };
}

export type ObservationStatus = {
  at: string;
  instanceId: string;
  result: "empty" | "submitted" | "failed";
  stage?: "extract" | "submit" | "target" | "priority" | "identity" | "capacity";
  observed: number;
  accepted: number;
  duplicates: number;
  invalid: number;
  error?: string;
};

export async function isBrowserDiscoveryEnabled(storage: {
  get(key: string): Promise<Record<string, unknown>>;
}): Promise<boolean> {
  try {
    return (await storage.get(DISCOVERY_CANARY_KEY))[DISCOVERY_CANARY_KEY] === true;
  } catch {
    return false;
  }
}

export function discoveryError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

// A full LinkedIn navigation can finish before Chrome has attached the content
// script to the new document. These are extension messages, not page visits.
const RECEIVER_RETRY_DELAYS_MS = [350, 700, 1400, 2800] as const;
const RECEIVER_RECOVERY_KEY = "actuator.discoveryReceiverRecovery";
const RECEIVER_RECOVERY_GAP_MS = 30 * 60_000;

export type ReceiverRecoverySkipReason =
  | "run_changed" | "tab_missing" | "off_feed" | "pending_off_feed"
  | "tab_unsettled" | "cooldown" | "tab_changed";

function isMissingReceiver(error: unknown): boolean {
  return /Receiving end does not exist/i.test(discoveryError(error));
}

/** A stale content script after extension reload needs one real page load. Only
 * the serialized ambient read calls this, never an in-flight send. */
export async function recoverMissingDiscoveryReceiver(args: {
  tabId: number;
  buildStamp: string;
  now(): number;
  isCurrent(): Promise<boolean>;
  waitForLoad(): Promise<void>;
  onSkip?(reason: ReceiverRecoverySkipReason): void;
}): Promise<boolean> {
  const skip = (reason: ReceiverRecoverySkipReason): false => {
    args.onSkip?.(reason);
    return false;
  };
  if (!(await args.isCurrent())) return skip("run_changed");
  const tab = await chrome.tabs.get(args.tabId).catch(() => null);
  if (!tab?.url) return skip("tab_missing");
  if (!isHomeFeedUrl(tab.url)) return skip("off_feed");
  if (tab.pendingUrl && !isHomeFeedUrl(tab.pendingUrl)) return skip("pending_off_feed");
  if (tab.status !== "complete" && tab.status !== "loading") return skip("tab_unsettled");
  const stored = await chrome.storage.local.get(RECEIVER_RECOVERY_KEY);
  const previous = stored[RECEIVER_RECOVERY_KEY] as {
    tabId?: number; buildStamp?: string; attemptedAt?: number;
  } | undefined;
  const now = args.now();
  if (previous?.tabId === args.tabId && previous.buildStamp === args.buildStamp &&
      typeof previous.attemptedAt === "number" &&
      Math.abs(now - previous.attemptedAt) < RECEIVER_RECOVERY_GAP_MS) return skip("cooldown");
  if (!(await args.isCurrent())) return skip("run_changed");
  // Recheck after the storage round-trip: the operator may have navigated.
  const current = await chrome.tabs.get(args.tabId).catch(() => null);
  if (current?.url !== tab.url || current.pendingUrl !== tab.pendingUrl ||
      (current.status !== "complete" && current.status !== "loading")) return skip("tab_changed");
  await chrome.storage.local.set({
    [RECEIVER_RECOVERY_KEY]: { tabId: args.tabId, buildStamp: args.buildStamp, attemptedAt: now },
  });
  if (!(await args.isCurrent())) return skip("run_changed");
  await chrome.tabs.reload(args.tabId);
  await args.waitForLoad();
  return true;
}

function observationKey(item: VisiblePost): string | null {
  const value = item.urn || item.fingerprint;
  return value ? value : null;
}

function isCanonicalObservation(item: VisiblePost): boolean {
  const id = /^urn:li:activity:(\d+)$/.exec(item.urn ?? "")?.[1];
  if (!id || !item.url) return false;
  try {
    const url = new URL(item.url);
    const urlId = /activity[-:](\d+)/.exec(decodeURIComponent(url.pathname))?.[1];
    return url.protocol === "https:" && url.hostname === "www.linkedin.com" && urlId === id;
  } catch {
    return false;
  }
}

export function hasDeferredCanonicalObservations(items: VisiblePost[] | undefined): boolean {
  return items?.some(isCanonicalObservation) ?? false;
}

function retainCanonicalDeferred(deferred: VisiblePost[] | undefined, items: VisiblePost[]): void {
  if (!deferred) return;
  const unique = new Map<string, VisiblePost>();
  for (const item of items) {
    if (isCanonicalObservation(item) && !unique.has(item.urn!)) unique.set(item.urn!, item);
    if (unique.size >= MAX_DEFERRED_OBSERVATIONS) break;
  }
  deferred.splice(0, deferred.length, ...unique.values());
}

export async function runBrowserObservation(args: {
  tabId: number;
  instanceId: string;
  seen: Set<string>;
  /** Posts left over when the server has fewer free discovery slots than cards. */
  deferred?: VisiblePost[];
  /** Submit already harvested canonical cards without another browser read. */
  deferredOnly?: boolean;
  /** Free slots from the server, checked before this browser read. */
  available?: number;
  stopped(): boolean;
  enabled(): Promise<boolean>;
  now(): number;
  wait(ms: number): Promise<void>;
  send(tabId: number): Promise<{ ok: boolean; items?: VisiblePost[] }>;
  /** Repair a persistent missing receiver once; regular attachment retries run first. */
  recoverReceiver?(tabId: number): Promise<boolean>;
  /** Reuse this read for qualified identity lookup; never harvest a second time. */
  onVisible?(items: VisiblePost[]): void;
  submit(items: VisiblePost[]): Promise<{ accepted: number; duplicates: number; invalid: number }>;
  report(status: ObservationStatus): Promise<void>;
}): Promise<ObservationStatus | null> {
  if (args.stopped() || !(await args.enabled()) || (args.available ?? Infinity) <= 0) return null;
  const status: ObservationStatus = {
    at: new Date(args.now()).toISOString(), instanceId: args.instanceId,
    result: "empty", observed: 0, accepted: 0, duplicates: 0, invalid: 0,
  };
  let items: VisiblePost[];
  try {
    let visible: VisiblePost[] = [];
    if (!args.deferredOnly) {
      let result: Awaited<ReturnType<typeof args.send>> | undefined;
      let recovered = false;
      for (let attempt = 0; ;) {
        try {
          result = await args.send(args.tabId);
          break;
        } catch (error) {
          if (!isMissingReceiver(error)) throw error;
          if (attempt < RECEIVER_RETRY_DELAYS_MS.length) {
            await args.wait(RECEIVER_RETRY_DELAYS_MS[attempt]!);
            if (args.stopped() || !(await args.enabled())) return null;
            attempt++;
            continue;
          }
          if (recovered || !args.recoverReceiver || !(await args.recoverReceiver(args.tabId))) throw error;
          recovered = true;
          attempt = 0;
        }
      }
      if (!result.ok || !Array.isArray(result.items)) throw new Error("invalid content-script response");
      visible = result.items;
      args.onVisible?.(visible);
    }
    const candidates = new Map<string, VisiblePost>();
    // Anonymous cards can only be resolved while still visible. Stage at most
    // one paced read's worth, then resolve its qualified cards before moving on.
    if (!args.deferredOnly) for (const item of visible) {
      const key = observationKey(item);
      if (item.urn || key === null || args.seen.has(`${args.instanceId}:${key}`) || candidates.has(key)) continue;
      candidates.set(key, item);
      if (candidates.size >= MAX_OBSERVATIONS_PER_READ) break;
    }
    // A visible URN-only card can still be submitted now, but only a card
    // with a matching permalink is safe to carry into a later read.
    const identified = args.deferredOnly
      ? (args.deferred ?? []).filter(isCanonicalObservation)
      : [...visible.filter((item) => Boolean(item.urn)), ...(args.deferred ?? []).filter(isCanonicalObservation)];
    for (const item of identified) {
      const key = observationKey(item);
      if (key !== null && !args.seen.has(`${args.instanceId}:${key}`) && !candidates.has(key)) candidates.set(key, item);
    }
    items = [...candidates.values()];
  } catch (error) {
    if (args.stopped() || !(await args.enabled())) return null;
    status.result = "failed";
    status.stage = "extract";
    status.error = discoveryError(error);
    await args.report(status);
    return status;
  }
  status.observed = items.length;
  const limit = Math.min(items.length, args.available ?? Infinity, MAX_OBSERVATIONS_PER_READ);
  let processed = 0;
  for (let start = 0; start < limit; start += 50) {
    if (args.stopped() || !(await args.enabled())) {
      if (start === 0) {
        retainCanonicalDeferred(args.deferred, items);
        return null;
      }
      break;
    }
    const batch = items.slice(start, Math.min(start + 50, limit));
    try {
      const result = await args.submit(batch);
      status.accepted += result.accepted;
      status.duplicates += result.duplicates;
      status.invalid += result.invalid;
      for (const item of batch) {
        const key = observationKey(item);
        if (key) args.seen.add(`${args.instanceId}:${key}`);
      }
      if (args.seen.size > 5000) args.seen.clear();
      status.result = "submitted";
      processed += batch.length;
    } catch (error) {
      status.result = "failed";
      status.stage = "submit";
      status.error = discoveryError(error);
      break; // Failed batch stays unseen and is retried on the next read.
    }
  }
  retainCanonicalDeferred(args.deferred, items.slice(processed));
  await args.report(status);
  return status;
}
