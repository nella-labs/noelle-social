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
  runAbort.abort();
  return bumpEpoch();
}

async function startRun(
  params: { windowHours: number; targetComments: number; targetLikes: number },
  opts?: { curfew?: boolean; expectedEpoch?: number },
  run = reserveStart(opts?.expectedEpoch),
): Promise<number | null> {
  const epoch = await activateStart(run);
  if (epoch === null) return null;
  const cfg = await getConfig();
  if (!cfg) throw new Error("not configured");
  if (!(await startIsCurrent(run, epoch))) return null;
  const api = new ActuatorApi(cfg);
  const queue = await api.fetchQueue();
  if (!(await startIsCurrent(run, epoch))) return null;
  const rng = makeRng((Date.now() & 0xffffffff) >>> 0);
  const startMs = Date.now();

  // Session persona + warm-up window: drawn once at run start and held for the
  // whole session (the "session-level entropy" that prevents a repeated
  // signature). persona.wpm threads into every reading-dwell call below.
  const persona = makeSessionPersona((Date.now() & 0xffffffff) >>> 0);
  // Warm-up suppresses writes for the first N ms (arrive/read before acting). Cap
  // it at 10% of the window so a short run isn't dominated by warm-up — a 30-min
  // window warms up ≤3 min, not the full ~4 min a long run would.
  const warmupSuppressMs = Math.min(
    warmupSuppressWritesMs(rng),
    Math.round(params.windowHours * 3600_000 * 0.1),
  );

  // Multi-day warm-up: a newly-automated identity ramps to full volume over ~4
  // weeks. Persist the automation start once (first run), then scale the daily
  // caps by the ramp multiplier so early sessions run lighter.
  const startStore = await chrome.storage.local.get("actuator.automationStartMs");
  let automationStartMs = startStore["actuator.automationStartMs"] as number | undefined;
  if (typeof automationStartMs !== "number") {
    automationStartMs = startMs;
    if (!(await runIfCurrent(epoch, () => chrome.storage.local.set({ "actuator.automationStartMs": automationStartMs })))) return null;
  }
  const warm = warmupCapMultiplier(automationStartMs, startMs);
  const effectiveCaps = {
    likes: Math.max(1, Math.round(cfg.caps.likes * warm)),
    comments: Math.round(cfg.caps.comments * warm),
    dms: Math.round(cfg.caps.dms * warm),
  };

  const { actions: planned } = planTimeline({
    params, approvedDms: queue.dms.length, caps: effectiveCaps, startMs,
    deepNightTaper: cfg.deepNightTaper, maxWritesPerHour: cfg.maxWritesPerHour ?? 8,
    // Plan AROUND the curfew when this run has one, so slots are not laid down
    // inside the band only to be deferred one by one at execution time.
    curfewEnabled: opts?.curfew === true,
    rng,
  });
  const actions: SlotAction[] = planned.map((a) => ({ kind: a.kind, atMs: a.atMs, executed: false }));

  // Pin the actuated tab NOW (preferring one already on /home) and remember it
  // on the run, so ticks keep driving this same tab while it stays open —
  // instead of re-picking tabs[0] every tick and following whichever x.com tab
  // sorts first.
  const tabId = await findXTab();
  const state: RunState = {
    sessionId: crypto.randomUUID(), epoch, startMs, windowHours: params.windowHours, actions,
    persona, warmupSuppressMs, tabId: tabId ?? undefined, curfewEnabled: opts?.curfew === true,
    targets: {
      likes: actions.filter((a) => a.kind === "like").length,
      comments: actions.filter((a) => a.kind === "comment").length,
      dms: actions.filter((a) => a.kind === "dm").length,
    },
    done: { likes: 0, comments: 0, dms: 0 },
    commentPool: queue.comments.map((c) => ({ approvalId: c.approval_id, draftId: c.draft_id, body: c.body, url: c.target.url })),
    dmPool: queue.dms.map((d) => ({ approvalId: d.approval_id, draftId: d.draft_id, body: d.body, url: d.target.url })),
    doneDraftIds: [], lastPollMs: startMs, status: "running",
  };
  return finishStart(state, run);
}

// Drain mode: post ALL approved replies a short gap apart (random 20–60s / 1–2 min),
// filling each gap with 4–8 likes + ambient browsing. Reuses the whole tick engine
// — it just builds a drain schedule and flags the run mode:"drain" (which makes each
// reply return to the x.com feed so the gap browses + likes). Newest tweet first
// (the /api/actionable-x queue is served newest-post-first). Epoch-based supersede,
// same as startRun — no warm-up suppression (drain is an explicit operator action).
async function startDrain(opts?: { manual?: boolean; curfew?: boolean; notifications?: boolean; expectedEpoch?: number },
  run = reserveStart(opts?.expectedEpoch),
): Promise<number | null> {
  const epoch = await activateStart(run);
  if (epoch === null) return null;
  const cfg = await getConfig();
  if (!cfg) throw new Error("not configured");
  if (!(await startIsCurrent(run, epoch))) return null;
  const api = new ActuatorApi(cfg);
  const queue = await api.fetchQueue();
  if (!(await startIsCurrent(run, epoch))) return null;
  const rng = makeRng((Date.now() & 0xffffffff) >>> 0);
  const startMs = Date.now();
  const persona = makeSessionPersona((Date.now() & 0xffffffff) >>> 0);
  // Per-session drain temperament, drawn from its OWN seed (NOT the wall-clock-
  // reseeded tick rng) so the plan stream is untouched. Persisted on RunState so
  // every auto-continue round shares the same mood (see maybeExtendDrain).
  const drainStyle = pickDrainArchetype(makeRng((Date.now() ^ 0x9e3779b1) >>> 0));

  const nComments = queue.comments.length;
  // drainStyle carries the archetype-shaped subset of DrainOpts, so spread it in.
  // shortBandProb is the ONE field combined with the operator's cfg knob by MIN
  // (placed AFTER the spread so it wins): the archetype can only ever LOWER the
  // short-band share, never raise the operator's lights-out setting — the drain
  // never runs faster than min(cfg, default).
  const planned = planDrainTimeline({
    approvedComments: nComments, startMs, rng,
    ...drainStyle,
    shortBandProb: Math.min(cfg.drainShortBandProb ?? 0.55, drainStyle.shortBandProb),
  });
  const actions: SlotAction[] = planned.map((a) => ({ kind: a.kind, atMs: a.atMs, executed: false }));
  const lastAt = actions.reduce((m, a) => Math.max(m, a.atMs), startMs);
  const windowHours = (lastAt - startMs) / 3600_000 + 0.15; // pad so the last slot fits

  const tabId = await findXTab(); // pin for the run (reused via s.tabId in tickOnce)
  const state: RunState = {
    sessionId: crypto.randomUUID(), epoch, startMs, windowHours, actions,
    persona, drainStyle, warmupSuppressMs: 0, mode: "drain", manualDrain: opts?.manual === true, curfewEnabled: opts?.curfew === true, notifications: opts?.notifications === true, tabId: tabId ?? undefined,
    targets: {
      likes: actions.filter((a) => a.kind === "like").length,
      comments: nComments,
      dms: 0,
    },
    done: { likes: 0, comments: 0, dms: 0 },
    commentPool: queue.comments.map((c) => ({ approvalId: c.approval_id, draftId: c.draft_id, body: c.body, url: c.target.url })),
    dmPool: [],
    doneDraftIds: [], lastPollMs: startMs, status: "running",
  };
  return finishStart(state, run);
}

// DELIBERATELY NO auto-enable/auto-disable of reply_send_enabled here — this is
// where the LinkedIn actuator differs and its pattern must NOT be ported. On
// LinkedIn the column has no consumer outside the actuator queue routes, so the
// extension can treat it as per-run consent. On X it is the MASTER GATE of the
// x-intern official-API send worker (apps/x-intern/src/workers/send.ts): once
// true, that worker's tick fires ANY auto_send_target_at-stamped pending
// approval via the official API — an unattended SECOND sender armed over the
// same approval pool as this extension (duplicate public posts). And disabling
// it at run end would silently revoke the operator's STANDING dashboard consent
// (killing Vega's API autosend after any manual actuator run). So the browser
// actuator never writes the flag: consent for the X actuator is the operator
// flipping reply sending on the Vega agent page (docs/x-actuator-plan.md), and
// the org-wide panic-stop stays the single authority over the column.

async function endRun(status: RunState["status"], terminal = reserveStop()): Promise<number> {
  const term = await terminal;
  // Abort immediately when STOP is reserved, then recheck the owned controller
  // after the epoch write: a start may have activated while that write waited.
  if (!(await runIfCurrent(term, async () => {
    runAbort.abort();
    if (status === "halted-challenge") {
      await chrome.storage.local.set({ [CHALLENGE_DAY_KEY]: localDayKey(new Date()) });
    }
  }))) return term;
  const s = await loadState();
  if (s) {
    s.status = status;
    s.epoch = term;
    if (!(await saveIfCurrent(s))) return term;
    // Detach every tab this run attached (it may have re-pinned after its tab
    // closed) — a single re-looked-up detach could miss one and leave the
    // "Extension is debugging this browser" banner up after the run halts.
    if (term === await currentEpoch()) await cdp.detachAll();
    // shortfall logging (no silent truncation)
    const cfg = await getConfig();
    if (cfg) {
      const api = new ActuatorApi(cfg);
      // NOTE: no enableSend(false) here — the X actuator never touches
      // reply_send_enabled (see the block comment above endRun). Disabling it
      // would revoke the operator's standing dashboard consent and kill the
      // x-intern API autosend pipeline after any manual actuator run.
      const events: XActivityEvent[] = [];
      const at = new Date(Date.now()).toISOString();
      const miss = shortfall(s.targets.comments, s.done.comments);
      if (miss > 0) events.push({ type: "skip", reason: `shortfall-replies-${miss}`, at });
      if (events.length) await api.logActivity(s.sessionId, events).catch(() => {});
    }
  }
  await runIfCurrent(term, async () => { await chrome.alarms.clear(ALARM); });
  return term;
}

// Drain auto-continue. A drain plans a FIXED number of reply slots (the queue
// size at start), so it used to STOP after that first batch even when the inbox
// still held approvals — the ones that arrived mid-run, or that were re-queued
// after a transient failure ("the actuator stopped before finishing the
// approvals inbox"). When every planned slot is done, re-fetch the queue and, if
// pending replies remain, APPEND a fresh batch of comment+like slots and extend
// the window — so one operator Drain clears the WHOLE inbox without a manual
// re-trigger. Returns true iff it extended (caller keeps the run running).
// Bounded by MAX_DRAIN_ROUNDS. Naturally self-limiting: an empty queue (nothing
// left, or sending disabled server-side) returns false → the drain ends;
// replies that keep failing hit the per-draft retry cap → doneDraftIds →
// filtered out of the next fetch → remaining reaches 0.
