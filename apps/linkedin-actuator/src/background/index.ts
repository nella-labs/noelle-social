import { NOTIFICATIONS_ACTOR_ENABLED } from "../lib/notifications-feature.js";
import { planTimeline, planDrainTimeline, pickDrainArchetype } from "../lib/scheduler.js";
import { makeRng } from "../lib/rng.js";
import { pickReaction, reactionLabel, type ReactionType } from "../lib/reactions.js";
import { ActuatorApi } from "../lib/api.js";
import type { ActuatorConfig } from "../lib/types.js";
import {
  loadState, saveIfCurrent, bumpEpoch, claimEpoch, runIfCurrent, currentEpoch, tickIsCurrent,
  dueActionIndex, withinWindow, type RunState, type SlotAction,
} from "./state.js";
import { Cdp } from "./cdp.js";
import { mergePool, deferLater, shortfall, retryDecision, shouldExtendDrain, drainShouldKeepWaiting, pipelineIsDry, type PoolItem } from "./replenish.js";
import { notClearedDetail, submitNotFoundDetail, type SubmitObserved, type SubmitDiag } from "./detail.js";
import { chooseAmbient, runAmbient, shouldIdleLike } from "./ambient.js";
import { chooseIdleActivity, notificationSweepDue, runNotificationSweep, SWEEP_MIN_GAP_MS, type SweepOutcome } from "./notifications.js";
import { isWriteCurfew } from "../lib/curfew.js";
import { makeSessionPersona, warmupSuppressWritesMs } from "../lib/session.js";
import { warmupCapMultiplier } from "../lib/warmup.js";
import { shouldAutoStart, shouldAutoDrain, shouldRecoverStalledRun, confirmStall, shouldResumeDrain, localDayKey, passesAutoStartSafety, type StallProbe } from "../lib/autonomy.js";
import { readingDwellMs, decideStop, glanceMs } from "../lib/dwell.js";
import { abortableSleep, throwIfAborted, isAbortError } from "../lib/cancel.js";
import { isHomeFeedUrl, chooseActuatorTab } from "../lib/feed.js";
import { rollLikeSkip } from "../lib/like-skip.js";
import { makeSerialQueue } from "../lib/serialize.js";
import { activityUrnFrom, postDedupKey } from "../lib/urn.js";
import { commentDeepLink } from "../content/comment-threading.js";
import { locateOrOpenCommentBox } from "./comment-composer.js";
import { bridgePulse, sinkLog } from "../lib/bridge-sink.js";
import type { ActionableLinkedInResponse, LinkedInActivityEvent } from "@noelle/contracts";
import type { VisiblePost } from "../content/discovery.js";
import { advancePriorityCursor, claimCommentForSend, classifyWithheldApproval, integratePriorityReady, isApprovalStillActionable, priorityTickDecision, restoreWithheldItem } from "./priority.js";
import {
  DISCOVERY_CANARY_KEY, DISCOVERY_LAST_FAILURE_KEY, DISCOVERY_STATUS_KEY, DISCOVERY_READ_INTERVAL_MS,
  discoveryError, discoveryReadDue, hasDeferredCanonicalObservations, withDiscoveryBrowseGate,
  isBrowserDiscoveryEnabled, recoverMissingDiscoveryReceiver, runBrowserObservation, type ObservationStatus,
} from "./discovery-canary.js";
import { activateBrowserDiscovery, discoveryWriteGate } from "./discovery-mode.js";
import { DISCOVERY_IDENTITY_STATUS_KEY, locateCopyLinkAfterHydration, resolveVisibleDiscoveryIdentity } from "./discovery-identity.js";
import { captureCopyLinkIdentity, type CopyCaptureFailure } from "./clipboard-capture.js";
import { handoffBuildAtHealthyBrowse, recoverReceiverWithBuildHandoff, shouldReloadBuildAtReceiver } from "./receiver-build-handoff.js";
import { makeNavigateTab, runClearComposer, sameDraft } from "@noelle/actuator-cdp";

const ALARM = "actuator-tick";
const AUTONOMY_ALARM = "autonomy-check";
const POLL_MS = 7 * 60_000; // replenishment interval (jittered at use)
// Persistent drain (self-perpetuating "Drain all approvals"): while a drain has
// caught up (inbox empty), re-check the server queue this often so a reply
// approved later goes out within ~a minute, with no operator re-click.
const DRAIN_WATCH_POLL_MS = 75_000;
const DRY_DISCOVERY_POLL_MS = DISCOVERY_READ_INTERVAL_MS;
const DRY_DISCOVERY_KEY = "actuator.lastDryDiscoveryMs";
// Roll a waiting drain's window this far forward each time it would otherwise
// expire, so the run keeps ticking while it watches for new approvals.
const DRAIN_WATCH_WINDOW_H = 1;
const cdp = new Cdp();
const observedUrns = new Set<string>();
let pendingPriority: { epoch: number; instanceId: string; comments: ActionableLinkedInResponse["comments"] } | null = null;
let priorityRetryAfterTick = false;
let lastPriorityErrorMs = 0;

// Cooperative-cancellation handle for the LIVE run. STOP (endRun) aborts it, so
// every in-flight dwell — and every sleep inside the CDP motion engine, which
// receives this same `sleep` — collapses immediately instead of waiting out its
// timer. startRun installs a fresh one. Starts aborted until persisted run state
// has been checked: session storage survives an ordinary MV3 worker restart,
// while this in-memory controller does not.
let runAbort = new AbortController();
runAbort.abort();
let needsRunRestore = true;
let runRestore: Promise<void> | null = null;
const sleep = (ms: number) => abortableSleep(ms, runAbort.signal);
/** True once the live run has been stopped/superseded (its work must unwind). */
const stopped = () => runAbort.signal.aborted;

// Re-arm only the same live run after a service-worker restart. This never
// starts a new run or changes its slots/epoch; the normal tick and priority
// gates still decide when work is allowed. Share the check between the alarm,
// content-script tick, and priority loop so none can race ahead with an aborted
// controller. An explicit start or STOP in this worker supersedes restoration.
async function restoreRunAfterWorkerRestart(): Promise<void> {
  if (!needsRunRestore) return;
  if (runRestore) return runRestore;
  const pending = (async () => {
    const saved = await loadState().catch(() => null);
    if (!needsRunRestore || saved?.status !== "running") return;
    const [epoch, gate] = await Promise.all([
      currentEpoch().catch(() => null),
      chrome.storage.local.get(REMOTE_STATE_KEY).catch(() => null),
    ]);
    if (!needsRunRestore || epoch === null || !gate || gate[REMOTE_STATE_KEY] === "stopped" || saved.epoch !== epoch) return;
    // STOP or a newer run may have landed while storage was being read.
    const latest = await loadState().catch(() => null);
    if (!needsRunRestore || latest?.status !== "running" || latest.epoch !== epoch) return;
    // Remote STOP writes its durable gate before endRun stamps terminal state.
    // Read that gate after the final state read so the gap cannot revive work.
    const finalGate = await chrome.storage.local.get(REMOTE_STATE_KEY).catch(() => null);
    if (!needsRunRestore || !finalGate || finalGate[REMOTE_STATE_KEY] === "stopped") return;
    runAbort = new AbortController();
    needsRunRestore = false;
  })();
  runRestore = pending;
  try { await pending; } finally { if (runRestore === pending) runRestore = null; }
}
// Run-independent sleep for the remote-intent loop's backoff: it must NOT collapse
// when a run's STOP aborts `runAbort` (the loop outlives every run).
const plainSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Serialize every reply-switch write (enable on manual run-start, disable on
// run-end) so a run-end's disable and a fresh run's enable can NEVER interleave.
// Combined with the epoch check inside endRun's disable, this makes the outcome
// deterministic under any timing: whichever op runs second sees the other's epoch
// bump — a superseded run-end skips its disable, and a fresh run's enable, if it
// runs after a disable, is the last write. Closes the "sending disabled at fetch
// time → empty queue → 0/0 despite pending drafts" race.
const withSendSwitch = makeSerialQueue();

type Rect = { x: number; y: number; width: number; height: number };
// A located element carries its rect now (for the Gaussian click point + Fitts
// W). Older message shapes / fallbacks may only have x,y — wrap them in a tiny
// rect so moveAndClick always has a box to sample.
function rectFrom(loc: { rect?: Rect; x?: number; y?: number }): Rect {
  if (loc.rect && loc.rect.width > 0 && loc.rect.height > 0) return loc.rect;
  const x = loc.x ?? 0;
  const y = loc.y ?? 0;
  return { x: x - 2, y: y - 2, width: 4, height: 4 };
}

async function getConfig(): Promise<ActuatorConfig | null> {
  const r = await chrome.storage.local.get("actuator.config");
  return (r["actuator.config"] as ActuatorConfig) ?? null;
}
const browserDiscoveryEnabled = () => isBrowserDiscoveryEnabled(chrome.storage.local);

async function reportBrowserDiscovery(status: ObservationStatus): Promise<void> {
  const patch: Record<string, unknown> = { [DISCOVERY_STATUS_KEY]: status };
  if (status.result === "failed") {
    patch[DISCOVERY_LAST_FAILURE_KEY] = status;
    sinkLog("warn", "browser discovery failed", { stage: status.stage, error: status.error, instanceId: status.instanceId });
    console.warn("[actuator] browser discovery failed", status.stage, status.error);
  } else if (status.observed > 0) {
    sinkLog("info", "browser posts observed", {
      observed: status.observed, accepted: status.accepted,
      duplicates: status.duplicates, invalid: status.invalid, instanceId: status.instanceId,
    });
  }
  await chrome.storage.local.set(patch).catch((error) => {
    sinkLog("warn", "browser discovery telemetry write failed", { error: discoveryError(error) });
    console.warn("[actuator] browser discovery telemetry write failed", discoveryError(error));
  });
}
// Choose the tab to actuate from every open linkedin.com tab. Prefers the run's
// pinned tab (while it is still open), else a tab actually on the /feed/, else
// the first linkedin tab — see chooseActuatorTab. The old `tabs[0]` picked the
// leftmost linkedin tab with no notion of feed-ness, so a profile tab that merely
// sorted first (the operator's own /in/ tab) could silently hijack the loop.
async function findLinkedInTab(pinnedId?: number | null): Promise<number | null> {
  const tabs = await chrome.tabs.query({ url: "https://www.linkedin.com/*" });
  return chooseActuatorTab(tabs.map((t) => ({ id: t.id, url: t.url })), pinnedId);
}
function send<T>(tabId: number, msg: unknown): Promise<T> {
  return chrome.tabs.sendMessage(tabId, msg) as Promise<T>;
}
async function waitTabComplete(tabId: number, timeoutMs = 12_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (stopped()) return; // STOP fired — don't spin out the remaining timeout
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.status === "complete") return;
    await sleep(400);
  }
}

// Re-assert the feed: if the actuated tab has wandered off /feed/, pull it back
// before acting. A reply/DM parks the tab on a profile or post permalink, a
// mis-landed click can SPA-navigate it onto a profile, and the operator can drive
// it away — and once off the feed the loop finds no feed cards, so likes stall.
// This single guard keeps EVERY feed-scoped action (scheduled likes, idle-likes,
// and the ambient browse) on the feed. Conservative: navigates only when the url
// is known AND not the feed (an unknown/loading url is left alone). Best-effort —
// a failed nav just falls through to the caller's own scan.
async function ensureOnFeed(tabId: number, rng: ReturnType<typeof makeRng>): Promise<void> {
  const cur = await chrome.tabs.get(tabId).catch(() => null);
  // STRICT home-feed check: a post permalink (/feed/update/…, esp. group posts)
  // is isFeedUrl-true for tab selection but NOT a place feed-likes work, so pull
  // back to the real feed instead of whiffing no-likeable-post on the permalink.
  if (!cur?.url || isHomeFeedUrl(cur.url)) return;
  await navigateTab(tabId, "https://www.linkedin.com/feed/", rng).catch(() => {});
  await waitTabComplete(tabId);
  await sleep(rng.float(900, 2600)); // let the first cards hydrate
}

type PendingStart = { epoch: Promise<number | null>; controller: AbortController };
function reserveStart(expectedEpoch?: number): PendingStart {
  return { epoch: claimEpoch(expectedEpoch), controller: new AbortController() };
}
async function activateStart(run: PendingStart): Promise<number | null> {
  const epoch = await run.epoch;
  if (epoch === null) return null;
  if (!(await runIfCurrent(epoch, async () => {
    runAbort.abort();
