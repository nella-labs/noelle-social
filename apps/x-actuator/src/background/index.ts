import { NOTIFICATIONS_ACTOR_ENABLED } from "../lib/notifications-feature.js";
import { planTimeline, planDrainTimeline, inQuietDrainGap, pickDrainArchetype } from "../lib/scheduler.js";
import { makeRng } from "../lib/rng.js";
import { engagementLabel, type EngagementKind } from "../lib/engagement.js";
import { reactWithVariety, rectFrom, type Rect } from "./engage.js";
import { DEFAULT_DISCOVERY_SCHEDULE, DISCOVERY_SCHEDULE_KEY, parseDiscoverySchedule, type DiscoverySchedule } from "@noelle/actuator-cdp";
import { isXWriteQuiet } from "../lib/discovery-curfew.js";
import { ActuatorApi } from "../lib/api.js";
import type { ActuatorConfig } from "../lib/types.js";
import {
  loadState, saveIfCurrent, bumpEpoch, claimEpoch, runIfCurrent, currentEpoch,
  dueActionIndex, withinWindow, type RunState, type SlotAction,
} from "./state.js";
import { Cdp } from "./cdp.js";
import { notClearedDetail, submitNotFoundDetail, type SubmitObserved, type SubmitDiag } from "./detail.js";
import { mergePool, deferLater, shortfall, replyFailureDecision, shouldExtendDrain, drainShouldKeepWaiting, pipelineIsDry, preSendDecision, type PoolItem } from "./replenish.js";
import { runSubmitReply, type ReplyResult } from "./submit.js";
import { waitForReplyComposer } from "./composer.js";
import { chooseAmbient, runAmbient, shouldIdleLike, submitObservationBatch } from "./ambient.js";
import { createActorClickTabGuard, findPinnedXTab, isXPageUrl, restorePinnedXTab } from "./tab-guard.js";
import { chooseIdleActivity, notificationSweepDue, runNotificationSweep, SWEEP_MIN_GAP_MS, type SweepOutcome } from "./notifications.js";
import { makeSessionPersona, warmupSuppressWritesMs } from "../lib/session.js";
import { warmupCapMultiplier } from "../lib/warmup.js";
import { shouldAutoStart, shouldAutoDrain, shouldRecoverStalledRun, confirmStall, shouldSelfReload, shouldResumeDrain, localDayKey, passesAutoStartSafety, type StallProbe } from "../lib/autonomy.js";
import { readingDwellMs, decideStop, glanceMs } from "../lib/dwell.js";
import { abortableSleep, throwIfAborted, isAbortError } from "../lib/cancel.js";
import { tweetIdFrom, tweetDedupKey } from "../lib/urn.js";
import { isFeedUrl } from "../lib/feed.js";
import { bridgePulse, sinkLog } from "../lib/bridge-sink.js";
import { ActorReplyCapWriteSchema, type XActivityEvent } from "@noelle/contracts";
import { makeNavigateTab, runClearComposer } from "@noelle/actuator-cdp";
import { rollLikeSkip } from "../lib/like-skip.js";
import type { VisibleTweet } from "../content/discovery.js";
import { DISCOVERY_MODE_KEY, claimReplyBeforeSubmit, discoveryBrowseDecision, discoveryNavigationTarget, discoveryStartDecision, emptySearchFallbackUrl, integratePriorityReady, observationBatch, stampCompletedDiscoveryTarget } from "./discovery.js";

const ALARM = "actuator-tick";
const AUTONOMY_ALARM = "autonomy-check";
const POLL_MS = 7 * 60_000; // replenishment interval (jittered at use)
// Persistent drain (self-perpetuating "Drain all approvals"): while a drain has
// caught up (inbox empty), re-check the server queue this often so a reply
// approved later is picked up within ~30 seconds, with no operator re-click.
const DRAIN_WATCH_POLL_MS = 30_000;
// Roll a waiting drain's window this far forward each time it would otherwise
// expire, so the run keeps ticking while it watches for new approvals.
const DRAIN_WATCH_WINDOW_H = 1;
const PRIORITY_POLL_MS = 10_000;
const PENDING_OBSERVATIONS_KEY = "actuator.pendingXObservations";
const LAST_DISCOVERY_READ_KEY = "actuator.lastDryXDiscoveryMs";
const LAST_DISCOVERY_TARGET_KEY = "actuator.lastTargetXDiscoveryMs";
const PENDING_DISCOVERY_TARGET_KEY = "actuator.pendingXDiscoveryTarget";
const MAX_PENDING_OBSERVATIONS = 1000;
const cdp = new Cdp();
const childTabGuard = createActorClickTabGuard((id) => chrome.tabs.remove(id));

// Cooperative-cancellation handle for the LIVE run. STOP (endRun) aborts it, so
// every in-flight dwell — and every sleep inside the CDP motion engine, which
// receives this same `sleep` — collapses immediately instead of waiting out its
// timer. startRun/startDrain install a fresh one. Starts aborted: no run is live
// at load.
let runAbort = new AbortController();
runAbort.abort();
const sleep = (ms: number) => abortableSleep(ms, runAbort.signal);
/** True once the live run has been stopped/superseded (its work must unwind). */
const stopped = () => runAbort.signal.aborted;
// Run-independent sleep for the remote-intent loop's backoff: it must NOT collapse
// when a run's STOP aborts `runAbort` (the loop outlives every run).
const plainSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const browserDiscoveryEnabled = async () =>
  (await chrome.storage.local.get(DISCOVERY_MODE_KEY).catch(() => ({})) as Record<string, unknown>)[DISCOVERY_MODE_KEY] === true;
async function currentWriteQuiet(atMs: number, legacyCurfewEnabled: boolean): Promise<{
  held: boolean; discoveryActive: boolean; schedule: DiscoverySchedule;
}> {
  try {
    const stored = await chrome.storage.local.get([DISCOVERY_MODE_KEY, DISCOVERY_SCHEDULE_KEY]);
    const discoveryActive = stored[DISCOVERY_MODE_KEY] === true;
    const schedule = parseDiscoverySchedule(stored[DISCOVERY_SCHEDULE_KEY]);
    return { held: isXWriteQuiet(atMs, discoveryActive, legacyCurfewEnabled, schedule), discoveryActive, schedule };
  } catch {
    // A lost settings read must not turn an operator's quiet window into a write.
    return { held: true, discoveryActive: false, schedule: DEFAULT_DISCOVERY_SCHEDULE };
  }
}
const observedTweetIds = new Set<string>();

async function getConfig(): Promise<ActuatorConfig | null> {
  const r = await chrome.storage.local.get("actuator.config");
  return (r["actuator.config"] as ActuatorConfig) ?? null;
}
// Keep the run's pinned tab even if a stray link took it off X. Only look for
// another X tab when that exact tab has closed.
async function findXTab(pinnedId?: number | null): Promise<number | null> {
  return findPinnedXTab(
    pinnedId,
    (id) => chrome.tabs.get(id).catch(() => null),
    async () => {
      const tabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
      return tabs.map((t) => ({ id: t.id, url: t.url }));
    },
  );
}
function send<T>(tabId: number, msg: unknown): Promise<T> {
  return chrome.tabs.sendMessage(tabId, msg) as Promise<T>;
}
async function waitTabComplete(tabId: number, timeoutMs = 12_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (stopped()) return; // STOP fired — don't spin out the remaining ~12s
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.status === "complete") return;
    await sleep(400);
  }
}

async function actorClick(tabId: number, rect: Rect, rng: ReturnType<typeof makeRng>): Promise<void> {
  await childTabGuard.duringClick(tabId, () => cdp.moveAndClick(tabId, rect, rng, sleep));
}

const restoringPinnedTabs = new Set<number>();
async function recoverPinnedTab(tabId: number, isLive = async () => {
  const state = await loadState().catch(() => null);
  return state?.status === "running" && state.tabId === tabId && state.epoch === (await currentEpoch());
}): Promise<boolean> {
  if (restoringPinnedTabs.has(tabId)) return false;
  restoringPinnedTabs.add(tabId);
  try {
    const restored = await restorePinnedXTab(tabId, {
      isLive,
      getTab: () => chrome.tabs.get(tabId).catch(() => null),
      navigate: (id, url) => navigateTab(id, url, makeRng((Date.now() & 0xffffffff) >>> 0), isLive),
    });
    if (restored) await waitTabComplete(tabId);
    return restored;
  } catch {
    return false;
  } finally {
    restoringPinnedTabs.delete(tabId);
  }
}

// Re-assert the feed: if the actuated tab has wandered off x.com/home, pull it
// back before acting. A reply parks the tab on a /status/ permalink (in
// scheduled mode only drain used to return to /home), a mis-landed click can
// navigate onto a profile or a t.co link, and the operator can drive it away —
// and once off the feed the loop scrolls a page where findFeedTweets matches
// thread/profile tweets (or nothing), so likes drift off-surface or stall (the
// like scan chews on a thread page's few tweets forever). This single guard
// keeps EVERY feed-scoped action (scheduled likes and the ambient browse) on
// the home timeline. Conservative: navigates only when the url is known AND
// not the feed (an unknown/loading url is left alone). Best-effort — a failed
// nav just falls through to the caller's own scan.
async function ensureOnFeed(tabId: number, rng: ReturnType<typeof makeRng>): Promise<void> {
  const cur = await chrome.tabs.get(tabId).catch(() => null);
  if (!cur?.url || isFeedUrl(cur.url)) return;
  await navigateTab(tabId, "https://x.com/home", rng).catch(() => {});
  await waitTabComplete(tabId);
  await sleep(rng.float(900, 2600)); // let the first tweets hydrate
}

// `opts.curfew` selects the legacy Auto overnight write curfew; Discover + Reply
// uses its separate optional local-time window. Browsing continues. There
// is deliberately no `manual` flag here (the LinkedIn actuator has one): on X the
// extension never arms reply_send_enabled either way — see the block comment
// above endRun — so a run has nothing to switch on the operator's behalf.
type PendingStart = { epoch: Promise<number | null>; controller: AbortController };
function reserveStart(expectedEpoch?: number): PendingStart {
  return { epoch: claimEpoch(expectedEpoch), controller: new AbortController() };
}
async function activateStart(run: PendingStart): Promise<number | null> {
  const epoch = await run.epoch;
  if (epoch === null) return null;
  if (!(await runIfCurrent(epoch, async () => {
    runAbort.abort();
    runAbort = run.controller;
  }))) { run.controller.abort(); return null; }
  return epoch;
}
async function startIsCurrent(run: PendingStart, epoch: number): Promise<boolean> {
  const current = await currentEpoch();
  return !run.controller.signal.aborted && runAbort === run.controller && epoch === current;
}
async function finishStart(state: RunState, run: PendingStart): Promise<number | null> {
  if (!(await startIsCurrent(run, state.epoch)) || !(await saveIfCurrent(state))) return null;
  if (state.tabId != null && await startIsCurrent(run, state.epoch)) {
    await cdp.attach(state.tabId).catch(() => {});
    if (!(await startIsCurrent(run, state.epoch))) {
      // Only initiate cleanup for a stopped controller still owned here.
      if (runAbort === run.controller && run.controller.signal.aborted) await cdp.detach(state.tabId).catch(() => {});
      return null;
    }
  }
  if (!(await runIfCurrent(state.epoch, async () => {
    if (run.controller.signal.aborted) return;
    await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
    if (run.controller.signal.aborted) return;
    for (const ms of [3500, 8000, 15000, 22000]) setTimeout(() => void tick(), ms);
  }))) return null;
  if (!(await startIsCurrent(run, state.epoch))) return null;
  return state.epoch;
}
function reserveStop(): Promise<number> {
