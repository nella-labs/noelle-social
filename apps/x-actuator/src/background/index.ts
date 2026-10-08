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
async function maybeExtendDrain(
  s: RunState, cfg: ActuatorConfig, api: ActuatorApi, now: number, rng: ReturnType<typeof makeRng>,
): Promise<boolean> {
  if (s.mode !== "drain") return false;
  const q = await api.fetchQueue().catch(() => null);
  if (!q) return false;
  const done = new Set(s.doneDraftIds);
  s.commentPool = mergePool(
    s.commentPool,
    q.comments.map((c) => ({ approvalId: c.approval_id, draftId: c.draft_id, body: c.body, url: c.target.url })),
    done,
  );
  s.lastPollMs = now; // this fetch counts as a poll; don't double-fetch next tick
  const remaining = s.commentPool.length;
  if (!shouldExtendDrain(s.mode, s.drainRounds ?? 0, remaining)) return false;

  // Plan a fresh drain batch for the remaining replies, starting shortly from
  // now, and splice it onto the timeline. The existing comment-slot executor
  // shifts these off s.commentPool exactly as it did the first batch.
  // Carry the SAME persisted session temperament so every round keeps one coherent
  // mood (old states without drainStyle fall back to today's defaults via `?? {}`).
  // shortBandProb stays MIN-combined with the operator cfg knob (placed after the
  // spread → wins) so a round never drains faster than min(cfg, default).
  const style = s.drainStyle;
  const planned = planDrainTimeline({
    approvedComments: remaining, startMs: now, rng,
    ...(style ?? {}),
    shortBandProb: style ? Math.min(cfg.drainShortBandProb ?? 0.55, style.shortBandProb) : cfg.drainShortBandProb,
  });
  const newLast = planned.reduce((m, a) => Math.max(m, a.atMs), now);
  for (const a of planned) s.actions.push({ kind: a.kind, atMs: a.atMs, executed: false });
  s.windowHours = (newLast - s.startMs) / 3600_000 + 0.15; // extend so the new tail fits
  s.targets.comments += remaining;
  s.targets.likes += planned.filter((a) => a.kind === "like").length;
  s.drainRounds = (s.drainRounds ?? 0) + 1;
  s.lastEvent = `draining more — ${remaining} left in inbox (round ${s.drainRounds})`;
  return true;
}

async function maybeReplenish(s: RunState, api: ActuatorApi, now: number, rng: ReturnType<typeof makeRng>) {
  if (now - s.lastPollMs < POLL_MS * rng.float(0.8, 1.6)) return;
  s.lastPollMs = now;
  const q = await api.fetchQueue().catch(() => null);
  if (!q) return;
  const done = new Set(s.doneDraftIds);
  s.commentPool = mergePool(s.commentPool, q.comments.map((c) => ({ approvalId: c.approval_id, draftId: c.draft_id, body: c.body, url: c.target.url })), done);
  s.dmPool = mergePool(s.dmPool, q.dms.map((d) => ({ approvalId: d.approval_id, draftId: d.draft_id, body: d.body, url: d.target.url })), done);
}

// Ambient read-actions (expand "Show more" / open a tweet's replies to read) are
// paced by a rolling cooldown so they cluster like real reading instead of
// firing on every ~4s idle tick. Base gap × a 1–2 jitter ⇒ roughly one every
// 20–40s at most; many attempts also find nothing in view and downgrade to a
// scroll, so the real rate is lower. Read-only + non-counted against targets.
// Tightened (was 30s×1–2.5) so the actor actively clicks "Show more" while waiting.
const AMBIENT_READ_MIN_GAP_MS = 20_000;

// Minimum spacing between idle-likes (a like slipped into the wait between
// scheduled actions), so waiting-gap likes are paced like a human rather than
// fired every ~4s tick. The like scan itself is several seconds, so this also
// keeps a like-less feed from being hammered.
// Quiet re-tune (port of Lyra #497): raised 45s -> 5 min. Idle-likes are
// budget-bounded either way, so this does not change VOLUME; it spreads the same
// likes over more wall clock, the direction docs/x-account-safety.md asks for.
// On X this constant did strictly more work than on LinkedIn because it governed
// Run/auto AND every non-cooldown drain gap; the drain half is now gated off
// entirely at the call site below.
const IDLE_LIKE_MIN_GAP_MS = 300_000;

// One ambient browse: pick a behavior (read-actions gated by cooldown + config
// kill switch, default ON) and run it. Advances the cooldown anchor only on an
// action that actually happened, so a downgraded-to-scroll attempt doesn't burn
// the gap. Mutates `s` in place; the caller persists it.
async function pendingObservations(): Promise<Map<string, VisibleTweet>> {
  const stored = await chrome.storage.local.get(PENDING_OBSERVATIONS_KEY).catch(() => ({})) as Record<string, unknown>;
  const previous = Array.isArray(stored[PENDING_OBSERVATIONS_KEY])
    ? stored[PENDING_OBSERVATIONS_KEY] as VisibleTweet[] : [];
  return new Map(previous.filter((v) => v && typeof v.tweetId === "string").map((v) => [v.tweetId, v]));
}

async function wakeDiscoveryRead(): Promise<void> {
  await chrome.storage.session.set({ [LAST_DISCOVERY_READ_KEY]: 0 });
}

async function submitPendingObservations(api: ActuatorApi, pending: Map<string, VisibleTweet>, budget: { remaining: number }): Promise<number | null> {
  const batch = observationBatch([...pending.values()], budget.remaining);
  if (batch.length === 0 || stopped() || !(await browserDiscoveryEnabled())) return null;
  // Persist before the HTTP request. A failed or ambiguous submission keeps
  // its reservation and the durable batch for the next paced read.
  await chrome.storage.local.set({ [PENDING_OBSERVATIONS_KEY]: [...pending.values()] });
  if (stopped()) return null;
  try {
    const accepted = await submitObservationBatch(batch, budget, (items) => api.postObservations(items));
    for (const item of batch) { pending.delete(item.tweetId); observedTweetIds.add(item.tweetId); }
    if (observedTweetIds.size > 2000) observedTweetIds.clear();
    await chrome.storage.local.set({ [PENDING_OBSERVATIONS_KEY]: [...pending.values()] });
    return accepted;
  } catch (error) {
    console.warn("[x-discovery] observations retained for retry", error);
    return null;
  }
}

async function observeVisibleTweets(tabId: number, api: ActuatorApi, budget: { remaining: number }): Promise<{ visible: number; accepted: number } | void> {
  if (budget.remaining <= 0 || stopped() || !(await browserDiscoveryEnabled())) return;
  const harvest = await send<{ ok: boolean; items?: VisibleTweet[] }>(tabId, { cmd: "harvestVisibleTweets" }).catch(() => null);
  if (!harvest?.ok) return;
  const visibleCount = harvest?.items?.length ?? 0;
  const pending = await pendingObservations();
  for (const item of harvest?.items ?? []) {
    if (!observedTweetIds.has(item.tweetId) && (pending.has(item.tweetId) || pending.size < MAX_PENDING_OBSERVATIONS)) {
      pending.set(item.tweetId, item);
    }
  }
  const accepted = pending.size > 0 ? await submitPendingObservations(api, pending, budget) : 0;
  if (accepted === null) return;
  return { visible: visibleCount, accepted };
}

async function ambientBrowse(
  s: RunState,
  cfg: ActuatorConfig,
  tabId: number,
  rng: ReturnType<typeof makeRng>,
  now: number,
): Promise<"browsed" | "waiting" | "full" | "unavailable" | "buffered"> {
  const api = new ActuatorApi(cfg);
  const discovery = await browserDiscoveryEnabled();
  let budget = { remaining: 0 };
  let lastTargetMs: number | null = null;
  let pendingTarget: unknown = null;
  if (discovery) {
    const lastReadStore = await chrome.storage.session.get([
      LAST_DISCOVERY_READ_KEY, LAST_DISCOVERY_TARGET_KEY, PENDING_DISCOVERY_TARGET_KEY,
    ]).catch(() => null) as Record<string, unknown> | null;
    if (!lastReadStore) {
      console.warn("[x-discovery] target cache read failed");
      return "unavailable";
    }
    const lastRead = Number(lastReadStore[LAST_DISCOVERY_READ_KEY] ?? 0);
    const storedTargetMs = lastReadStore[LAST_DISCOVERY_TARGET_KEY];
    if (typeof storedTargetMs === "number" && Number.isFinite(storedTargetMs)) lastTargetMs = storedTargetMs;
    pendingTarget = lastReadStore[PENDING_DISCOVERY_TARGET_KEY] ?? null;
    // A full buffer or outage also consumes this read opportunity: no repeated
    // capacity request or continuous scroll on the actor's ~4s idle ticks.
    if (discoveryBrowseDecision({ enabled: true, lastReadMs: lastRead, nowMs: now, available: 1 }) === "waiting") return "waiting";
    await chrome.storage.session.set({ [LAST_DISCOVERY_READ_KEY]: now });
    const capacity = await api.fetchDiscoveryCapacity().catch(() => null);
    if (stopped() || s.epoch !== (await currentEpoch())) return "waiting";
    const decision = discoveryBrowseDecision({ enabled: true, lastReadMs: lastRead, nowMs: now, available: capacity?.available ?? null });
    if (decision !== "browse") return decision;
    budget = { remaining: capacity!.available };
    const pending = await pendingObservations();
    if (pending.size > 0) {
      await submitPendingObservations(api, pending, budget);
      return "buffered";
    }
  }
  // Ambient browsing is feed behavior: a reply parks the tab on a /status/
  // permalink (and a mis-landed click can navigate anywhere), so re-assert
  // /home first or the "browsing" dwells idle on whatever page the last write
  // left behind.
  await ensureOnFeed(tabId, rng);
  if (stopped() || s.epoch !== (await currentEpoch())) return "waiting";
  const readEnabled = cfg.ambientReadActions !== false; // undefined ⇒ ON
  const sinceRead = now - (s.lastAmbientReadMs ?? 0);
  const readActionsAllowed = readEnabled && sinceRead > AMBIENT_READ_MIN_GAP_MS * rng.float(1, 2.6);
  // Purposeful watched-profile/keyword reads use the same pinned X tab. Give
  // them their own share of eligible discovery reads; idle choices stay on feed.
  const navigationTarget = discovery ? await discoveryNavigationTarget({
    nowMs: now,
    lastSelectedMs: lastTargetMs,
    randomRoll: rng.next(),
    cachedTarget: pendingTarget,
    fetchTarget: () => api.fetchDiscoveryTarget().catch(() => {
      console.warn("[x-discovery] target fetch failed");
      return null;
    }),
    cacheTarget: (target) => chrome.storage.session.set({ [PENDING_DISCOVERY_TARGET_KEY]: target }),
    discardCachedTarget: () => chrome.storage.session.set({ [PENDING_DISCOVERY_TARGET_KEY]: null }),
    onCacheFailure: () => console.warn("[x-discovery] target cache write failed"),
  }) : null;
  const kind = navigationTarget ? "navigate" : chooseAmbient(rng, { readActionsAllowed });
  if (stopped() || s.epoch !== (await currentEpoch())) return "waiting";
  const did = await runAmbient(tabId, kind, {
    cdp, click: (id, rect) => actorClick(id, rect, rng), rng, sleep, send, wpm: s.persona.wpm,
    navigate: (id, url) => navigateTab(id, url, rng, async () => !stopped() && s.epoch === (await currentEpoch())),
    ...(navigationTarget ? {
      navigationTarget,
      emptySearchFallbackTarget: emptySearchFallbackUrl(navigationTarget) ?? undefined,
      canReadMore: async () => budget.remaining > 0 && !stopped() && s.epoch === (await currentEpoch()),
      onPageRead: (id: number) => observeVisibleTweets(id, api, budget).catch((e) => {
        console.warn("[x-discovery] target read failed", e);
      }),
    } : {}),
  }).catch(() => null);
  if (discovery) {
    await stampCompletedDiscoveryTarget({
      outcome: did,
      targetUrl: navigationTarget,
      completedAtMs: Date.now(),
      commitVisit: ({ completedAtMs, pendingTarget }) => chrome.storage.session.set({
        [LAST_DISCOVERY_TARGET_KEY]: completedAtMs,
        [PENDING_DISCOVERY_TARGET_KEY]: pendingTarget,
      }),
      onStampFailure: () => console.warn("[x-discovery] target read stamp failed"),
    });
    if (!stopped()) await observeVisibleTweets(tabId, api, budget).catch((e) => {
      console.warn("[x-discovery] feed read failed", e);
    });
  }
  if (did === "expand") s.lastAmbientReadMs = now;
  return "browsed";
}

// Live-browser deps for reactWithVariety (src/background/engage.ts — the
// orchestration is a plain function over these primitives so its stale-rect
// discipline is unit-tested; only this wiring touches chrome.* / CDP). The
// contract enforced in engage.ts: after any locate that scrolled the page, only
// freshly-located rects are clicked, and a fallback re-locate miss delivers
// NOTHING (the caller records a skip) instead of a blind trusted CDP click at
// stale viewport coordinates.
function engageDeps(tabId: number, rng: ReturnType<typeof makeRng>) {
  return {
    click: (rect: Rect) => actorClick(tabId, rect, rng),
    locateEngagement: (engagement: EngagementKind, tweet_id: string | null) =>
      send<{ ok: boolean; x?: number; y?: number; rect?: Rect }>(
        tabId, { cmd: "locateEngagement", engagement, tweet_id },
      ),
    locateRepostConfirm: () =>
      send<{ ok: boolean; x?: number; y?: number; rect?: Rect }>(
        tabId, { cmd: "locateRepostConfirm" },
      ),
    dismissMenu: () => cdp.pressEscape(tabId),
    sleep,
  };
}

// Like one hydrated feed tweet as a human would: make sure we're on the timeline,
// scroll-and-poll until a likeable tweet attaches, read it (dwelling proportional
// to its length, sometimes expanding "Show more" first), then land a trusted
// click. Returns true iff a like was actually landed; increments s.done.likes and
// pushes the activity event on success, or a skip event on a miss. Shared by the
// scheduled 'like' slot and idle-liking so both behave identically.
async function likeAFeedPost(
  tabId: number,
  s: RunState,
  cfg: ActuatorConfig,
  rng: ReturnType<typeof makeRng>,
  events: XActivityEvent[],
  at: string,
): Promise<boolean> {
  // A standalone feed-like must run ON the timeline. After a reply the tab is
  // left on a tweet permalink, where findFeedTweets finds no timeline cards →
  // every like skipped `no-likeable-tweet(tweets=0)`. Pull it back first via
  // the SHARED guard (ensureOnFeed, also used by the ambient browse — one
  // isFeedUrl notion of feed-ness instead of a local regex). Best-effort — a
  // failed nav just falls through to the scan.
  await ensureOnFeed(tabId, rng);
  // Scroll-and-poll: the like button only attaches once a tweet is hydrated near
  // the viewport, so one blind scroll + immediate locate often finds nothing
  // likeable. Retry with small scrolls + waits to let tweets hydrate.
  type LikeLoc = {
    ok: boolean; x?: number; y?: number; rect?: Rect;
    observed?: {
      tweet_id?: string; author_handle?: string;
      wordCount?: number; hasMedia?: boolean; isTruncated?: boolean;
      seeMoreRect?: Rect;
    };
    skipReason?: string;
  };
  let loc: LikeLoc | null = null;
  const preferWatchlist = cfg.preferWatchlistRatio > rng.next();
  for (let attempt = 0; attempt < 5; attempt++) {
    if (stopped()) break; // STOP mid-scan — abandon the hunt
    await cdp.wheel(tabId, { x: 400, y: 400 }, attempt === 0 ? Math.round(rng.float(480, 820)) : Math.round(rng.float(300, 540)), rng, sleep);
    await sleep(rng.float(450, 1350)); // let the social-action bar hydrate
    loc = await send<LikeLoc>(tabId, { cmd: "locateLike", preferWatchlist, watchlistNames: [] }).catch(() => null);
    if (loc?.ok && loc.x != null && loc.y != null) break;
  }
  if (loc?.ok && loc.x != null && loc.y != null) {
    // Read the tweet like a human BEFORE reacting: dwell proportional to its
    // length, and sometimes expand "Show more" then read the fuller text.
    let wc = loc.observed?.wordCount ?? 0;
    const media = loc.observed?.hasMedia ?? false;
    const trunc = loc.observed?.isTruncated ?? false;
    const seeMoreRect = loc.observed?.seeMoreRect;
    const tweetId = loc.observed?.tweet_id ?? null;
    const deps = engageDeps(tabId, rng);
    let likeRect = rectFrom(loc);
    const stop = decideStop(rng, wc, { hasMedia: media });
    if (stop && trunc && seeMoreRect && rng.next() < 0.7) {
      // expand-then-read: itself a strong human decoy action
      await actorClick(tabId, seeMoreRect, rng);
      await sleep(rng.float(300, 1100));
      wc = Math.round(wc * 2.2); // fuller text now visible → longer read
      // The expansion REFLOWS the tweet (its action bar moves down), so the like
      // rect measured before the expand is stale. Re-locate the heart on the
      // SAME tweet for a fresh rect; if it can't be re-found (tweet id unknown,
      // card gone), skip rather than fire a trusted click at stale coordinates.
      const fresh = await deps.locateEngagement("like", tweetId).catch(() => null);
      if (fresh?.ok && fresh.x != null) {
        likeRect = rectFrom(fresh);
      } else {
        events.push({ type: "skip", reason: "like-gone-after-expand", at });
        return false;
      }
    }
    await sleep(stop ? readingDwellMs(rng, wc, { hasMedia: media }, s.persona.wpm) : glanceMs(rng));
    throwIfAborted(runAbort.signal); // STOP during the read → don't land the like
    // Re-locate the like button immediately before reacting. The rect captured
    // before the read goes STALE even without an expand: live timeline
    // insertion and lazy media shift the card, so the pre-read coordinates can
    // land in the tweet BODY (an @mention → a profile, a t.co link → off-site),
    // which navigates the tab off the feed AND misses the like. Locate the
    // heart on the SAME tweet. A miss or lost response cannot confirm the
    // pre-read rect is still current, so skip unless fresh coordinates arrive.
    const preClick = await deps.locateEngagement("like", tweetId).catch(() => null);
    if (preClick?.ok !== true || preClick.x == null || preClick.y == null) {
      events.push({ type: "skip", reason: "like-location-unavailable", at });
      return false;
    }
    likeRect = rectFrom(preClick);
    throwIfAborted(runAbort.signal); // STOP during the re-locate → don't land the like
    const engagement = await reactWithVariety(likeRect, tweetId, cfg.engagementWeights, rng, deps);
    if (engagement == null) {
      // Variety attempt missed AND the fresh-rect fallback missed too (see
      // engage.ts): nothing landed, so count nothing — a phantom s.done.likes++
      // would burn a budgeted like on a click that never happened.
      events.push({ type: "skip", reason: "engagement-not-landed", at });
      return false;
    }
    s.done.likes++;
    events.push({ type: "like", tweet_id: loc.observed?.tweet_id, author_handle: loc.observed?.author_handle, engagement, at });
    return true;
  }
  events.push({ type: "skip", reason: loc?.skipReason ?? "like-failed", at });
  return false;
}

// Serialize ticks so the content-script-driven loop can't overlap with the
// alarm-driven one (overlap would double-read/write state).
let ticking = false;
let discoveryDrainAfterTick: number | null = null;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await tickOnce();
  } finally {
    ticking = false;
    if (discoveryDrainAfterTick !== null) {
      const expectedEpoch = discoveryDrainAfterTick;
      discoveryDrainAfterTick = null;
      if (await browserDiscoveryEnabled() && !stopped()) {
        await startDrain({ manual: true, curfew: false, expectedEpoch }).catch((error) =>
          console.warn("[x-discovery] deferred drain start failed", error));
      }
    }
  }
}

async function tickOnce() {
  const s = await loadState();
  const cfg = await getConfig();
  if (!s || !cfg || s.status !== "running") return;
  // Stale-run guard: if a newer run started or STOP fired since this state was
  // written, our epoch is no longer current — bail without acting or saving so a
  // superseded/stopped run can't spring back to life.
  const myEpoch = s.epoch ?? 0;
  if (myEpoch !== (await currentEpoch())) return;
  const now = Date.now();
  if (!withinWindow(s.startMs, s.windowHours, now)) {
    // A persistent drain never times out on its window — roll it forward and keep
    // ticking so it can watch for new approvals. Every other run ends here.
    if (drainShouldKeepWaiting(s.mode, s.drainRounds ?? 0)) {
      s.windowHours = (now - s.startMs) / 3600_000 + DRAIN_WATCH_WINDOW_H;
    } else {
      await endRun("idle");
      return;
    }
  }

  // Reuse the run's pinned tab while it is still open, including after an
  // accidental off-X navigation. Only re-pick if that exact tab closed.
  const tabId = await findXTab(s.tabId);
  if (tabId == null) return; // no tab → pause; resume next tick
  if (s.tabId !== tabId) s.tabId = tabId; // pin (or re-pin after the old tab closed)
  await recoverPinnedTab(tabId, async () => !stopped() && myEpoch === (await currentEpoch()));
  const currentTab = await chrome.tabs.get(tabId).catch(() => null);
  if (!currentTab?.url || !isXPageUrl(currentTab.url) ||
      (currentTab.pendingUrl && !isXPageUrl(currentTab.pendingUrl))) return;
  await cdp.attach(tabId).catch(() => {}); // idempotent; re-attach if a detach happened

  const api = new ActuatorApi(cfg);
  const rng = makeRng((now & 0xffffffff) >>> 0);
  await maybeReplenish(s, api, now, rng);

  // challenge guard
  const ch = await send<{ observed?: { challenge?: boolean } }>(tabId, { cmd: "detectChallenge" }).catch(() => null);
  if (ch?.observed?.challenge) {
    await endRun("halted-challenge");
    await api.logActivity(s.sessionId, [{ type: "skip", reason: "challenge", at: new Date(now).toISOString() }]).catch(() => {});
    return;
  }

  if (!stopped() && now - (s.lastPriorityPollMs ?? 0) >= PRIORITY_POLL_MS && await browserDiscoveryEnabled()) {
    s.lastPriorityPollMs = now;
    const ready = await api.fetchPriorityReady().catch(() => null);
    if (ready && myEpoch === (await currentEpoch()) && !stopped()) {
      integratePriorityReady(s, ready, now, rng);
    }
  }

  const idx = dueActionIndex(s.actions, now);
  if (idx < 0) {
    // Re-read beside the idle-like decision: a panel edit or minute boundary
    // during replenishment must not allow a write from stale settings.
    const writeQuiet = await currentWriteQuiet(Date.now(), s.curfewEnabled === true);
    // Persistent drain: when every slot is done, keep re-checking the server queue
    // (paced, ~DRAIN_WATCH_POLL_MS) so approvals made after the inbox emptied get
    // fresh slots and go out with no re-click. maybeExtendDrain appends slots +
    // bumps drainRounds only when supply exists; an empty check is a no-op.
    if (
      drainShouldKeepWaiting(s.mode, s.drainRounds ?? 0) &&
      s.actions.every((a) => a.executed) &&
      now - (s.lastDrainWatchMs ?? 0) >= DRAIN_WATCH_POLL_MS
    ) {
      s.lastDrainWatchMs = now;
      await maybeExtendDrain(s, cfg, api, now, rng);
    }

    // Nothing due. While it waits, the actor should stay lively — and the
    // operator wants it actively LIKING + clicking "Show more", not just
    // scrolling. So slip a like into the wait (paced, curfew-safe, and bounded by
    // the like budget so it never exceeds the daily cap), otherwise ambient-browse
    // (whose read-actions now lean toward expanding "Show more").
    const idleLike = shouldIdleLike({
      doneLikes: s.done.likes,
      targetLikes: s.targets.likes,
      // Pass the per-run flag. Without it this defaulted to the GLOBAL switch
      // (WRITE_CURFEW_ENABLED = false), so the idle-like slot was never
      // curfew-gated on any run — which is why likes kept firing at 2am on a
      // Full-auto run whose curfew was explicitly on.
      inCurfew: writeQuiet.held,
      sinceLastIdleLikeMs: now - (s.lastIdleLikeMs ?? 0),
      minGapMs: IDLE_LIKE_MIN_GAP_MS * rng.float(1, 1.8),
      inQuietGap: s.mode === "drain" && inQuietDrainGap(s.actions, now),
      // A drain takes ONLY the like slots its plan scheduled (#497).
      inDrain: s.mode === "drain",
    });
    // The notifications sweep rides the idle branch: a run flagged
    // `notifications` spends one of its waits, every ~10-20 min, reading the
    // mentions tab instead of ambient-browsing. Checking your mentions IS
    // ambient behavior, so this costs no extra behavioral surface — and the
    // leads it files come back as approvals that THIS run then posts.
    //
    // ORDER MATTERS (chooseIdleActivity owns it): the sweep is decided BEFORE the
    // supply gate, because the sweep is what CREATES this run's supply. Gating it
    // on "we already have something to send" deadlocks the feature in its normal
    // starting state — Auto notifications clicked with an empty approval queue.
    const activity = chooseIdleActivity({
      sweepDue: notificationSweepDue({
        enabled: s.notifications === true,
        sinceLastSweepMs: now - (s.lastNotifSweepMs ?? 0),
        minGapMs: SWEEP_MIN_GAP_MS * rng.float(1, 2),
      }),
      // SUPPLY GATE: with nothing to send (both pools empty) a live run goes QUIET —
      // no idle-likes, no ambient browsing. Without this, a run whose pipeline had
      // run dry still burned engagement every tick: 2026-07-20 Lyra logged 346 likes
      // against 3 comments in a day, 359/43 the day before. The watch-poll above
      // still runs, so the moment an approval lands the run picks it up and the
      // normal in-gap liking resumes.
      pipelineDry: pipelineIsDry(s.commentPool.length, s.dmPool.length),
      idleLike,
    });
    let browseResult: Awaited<ReturnType<typeof ambientBrowse>> | null = null;
    if (activity === "quiet") {
      const result = !stopped() && await browserDiscoveryEnabled()
        ? await ambientBrowse(s, cfg, tabId, rng, now) : "waiting";
      s.lastEvent = result === "browsed" ? "reading for new X posts — no likes while the pipeline is empty"
        : result === "buffered" ? "submitting saved X posts — no browser scroll"
        : result === "full" ? "5 replies buffered — waiting for a send slot"
        : result === "unavailable" ? "discovery capacity unavailable — waiting"
        : "nothing to send — idle (no likes while the pipeline is empty)";
      await saveIfCurrent(s);
      return;
    }
    if (activity === "sweep") {
      s.lastNotifSweepMs = now; // pace off the attempt, so a broken sweep can't spin
      const out = await runNotificationSweep(tabId, {
        cdp, rng, sleep, send, api, instanceId: cfg.instanceId, wpm: s.persona.wpm,
        navigate: async (id, url) => {
          // Epoch-guard every navigation: a STOP or a superseding run must never
          // find its tab yanked to /notifications by a sweep that outlived it.
          // Checked twice: navigateTab clears the composer first, which can take
          // a couple of seconds, so the guard is re-run right before the actual
          // navigation (a STOP landing inside that window used to slip through).
          if (myEpoch !== (await currentEpoch())) return;
          await navigateTab(id, url, rng, async () => myEpoch === (await currentEpoch())).catch(() => {});
          await waitTabComplete(id);
        },
        stopped,
        configuredHandle: cfg.selfHandle,
      }).catch((e): SweepOutcome => ({
        fresh: 0, accepted: 0, skipped: 0,
        detail: isAbortError(e) ? "stopped" : `sweep-failed: ${e instanceof Error ? e.message : String(e)}`,
      }));
      // Be specific about WHY a sweep found nothing. "nothing new" with 0 cells
      // read means the page never rendered (or the selectors drifted) and is a
      // completely different problem from "read 25 cells, none of them were
      // replies to you" — the old single message hid that distinction and made
      // a broken sweep look like a quiet one.
      // TELEMETRY. Every sweep outcome is written to the activity table, so a
      // sweep that finds nothing is diagnosable from SQL instead of requiring
      // the operator to be watching the panel at the right moment. This is the
      // gap that made the first two rounds of this bug guesswork.
      await api
        .logActivity(s.sessionId, [
          {
            type: "skip",
            reason: `sweep:${out.detail ?? (out.fresh > 0 ? `ingested-${out.accepted}` : `read-${out.harvested ?? 0}-none-new`)}`.slice(0, 200),
            at: new Date(now).toISOString(),
          } as XActivityEvent,
        ])
        .catch(() => {});
      s.lastEvent = out.detail
        ? `notifications: ${out.detail}`
        : out.fresh === 0
          ? out.harvested
            ? `notifications: read ${out.harvested} cells, none are new replies to you`
            : "notifications: page rendered NO notification cells — selectors may have drifted"
          : `notifications: ${out.accepted} queued for drafting (${out.skipped} already known)`;
    } else if (activity === "like") {
      s.lastIdleLikeMs = now; // pace off the attempt, not just a hit (the scan is costly)
      const events: XActivityEvent[] = [];
      const at = new Date(now).toISOString();
      try {
        await likeAFeedPost(tabId, s, cfg, rng, events, at);
      } catch (e) {
        if (!isAbortError(e)) throw e; // STOP mid-like → fall through to the STOP-race guard below
      }
      await api.logActivity(s.sessionId, events).catch(() => {});
    } else {
      browseResult = await ambientBrowse(s, cfg, tabId, rng, now);
      if (browseResult === "full") s.lastEvent = "5 replies buffered — waiting for a send slot";
      else if (browseResult === "buffered") s.lastEvent = "submitting saved X posts — no browser scroll";
      else if (browseResult === "unavailable") s.lastEvent = "discovery capacity unavailable — waiting";
      else if (browseResult === "waiting") s.lastEvent = "waiting for next paced discovery read";
    }
    // STOP race: a stop/halt may have landed during the (now longer) idle
    // like/ambient read — don't resurrect the run by writing "running" back over it.
    const cur = await loadState();
    if (cur && cur.status !== "running") return;
    const nextAt = Math.min(...s.actions.filter((a) => !a.executed).map((a) => a.atMs));
    const inSec = Number.isFinite(nextAt) ? Math.max(0, Math.round((nextAt - now) / 1000)) : 0;
    // A sweep already wrote its own outcome line — don't clobber it with the
    // generic idle text, or the panel would never show what the sweep found.
    if (activity === "like" || browseResult === "browsed") {
      s.lastEvent = activity === "like" ? `liked while waiting — next action in ~${inSec}s` : `browsing — next action in ~${inSec}s`;
    }
    await saveIfCurrent(s);
    return;
  }

  const action = s.actions[idx]!;
  const events: XActivityEvent[] = [];
  const at = new Date(now).toISOString();
  const windowEndMs = s.startMs + s.windowHours * 3600_000;
  // "dm" stays in the predicate as a forward-compat guard even though X plans
  // none today (api.ts hardcodes dms: []). There is no dm executor branch, so a
  // dm slot that slipped past this gate would never advance atMs and would be
  // re-selected by dueActionIndex every tick — wedging the run.
  const isWrite =
    action.kind === "like" || action.kind === "comment" || action.kind === "dm";
  // Re-read at the write floor. A running reply is not interrupted by a panel
  // edit, but the next slot observes it before touching the page.
  const writeQuiet = await currentWriteQuiet(Date.now(), s.curfewEnabled === true);

  // Runtime write floor: Discover + Reply reads its saved local-time window;
  // legacy Auto uses ../lib/curfew.ts; manual Run/Drain have no quiet window.
  //
  // Scoped to EVERY WRITE, likes included. It used to hold posts only, so a
  // curfewed run sat liking at 2am while the panel said "overnight pause" — the
  // exact asleep-but-active signature the curfew exists to remove. Ambient
  // BROWSING still continues; it leaves no public trace.
  if (isWrite && writeQuiet.held) {
    const d = deferLater(action, now, windowEndMs, rng);
    action.atMs = d.atMs;
    events.push({ type: "skip", reason: "curfew", at });
    s.lastEvent = writeQuiet.discoveryActive
      ? `quiet window ${writeQuiet.schedule.start}–${writeQuiet.schedule.end} — browsing, no replies or likes`
      : "overnight pause — no replies or likes 1:00–9:00";
    // A held send slot must not pin discovery on this permalink all night.
    // ambientBrowse enforces the existing discovery read cadence and buffer cap.
    if (writeQuiet.discoveryActive) await ambientBrowse(s, cfg, tabId, rng, now);
    await saveIfCurrent(s);
    await api.logActivity(s.sessionId, events).catch(() => {});
    return;
  }

  // Warm-up: for the first warmupSuppressMs of the session, no writes — arrive,
  // scroll, and read first (a human doesn't fire the instant they land). Defer
  // the slot, run a short ambient browse, then skip.
  if (isWrite && now - s.startMs < s.warmupSuppressMs) {
    const d = deferLater(action, now, windowEndMs, rng);
    action.atMs = d.atMs;
    await ambientBrowse(s, cfg, tabId, rng, now);
    // STOP race during the (now longer) warm-up read.
    const cur = await loadState();
    if (cur && cur.status !== "running") return;
    events.push({ type: "skip", reason: "warming-up", at });
    s.lastEvent = "warming up — reading first";
    await saveIfCurrent(s);
    await api.logActivity(s.sessionId, events).catch(() => {});
    return;
  }

  // STOP (or a superseding Run) may have landed during the awaits above
  // (replenish, challenge probe). Re-check the epoch before touching LinkedIn so
  // a just-stopped run never fires one last action.
  if (myEpoch !== (await currentEpoch())) return;

  try {
    if (action.kind === "like") {
      // Bound total likes to the session budget: idle-likes (fired in the waits)
      // and scheduled like slots share s.done.likes, so once the budget is met the
      // idle-likes have already delivered this slot's like — skip it rather than
      // over-liking past the cap.
      if (s.done.likes >= s.targets.likes) {
        events.push({ type: "skip", reason: "like-budget-met", at });
      } else {
        await likeAFeedPost(tabId, s, cfg, rng, events, at);
      }
      action.executed = true;
    } else if (action.kind === "comment") {
      // "comment" is the shared engine's write action — for X it posts a reply.
      const item = s.commentPool.shift();
      if (!item) {
        // supply-aware: defer this slot later in the window, do NOT execute
        const d = deferLater(action, now, s.startMs + s.windowHours * 3600_000, rng);
        action.atMs = d.atMs;
        events.push({ type: "skip", reason: "reply-awaiting-supply", at });
      } else if (tweetDedupKey(item.url) && (s.actionedUrls ?? []).includes(tweetDedupKey(item.url)!)) {
        // Per-tweet guard: already replied to this tweet this session. The queue
        // can hold >1 draft for one tweet; two replies on a single tweet is a
        // prime X spam signal. Keyed on the numeric status id (tweetDedupKey) so
        // two drafts whose URLs differ only cosmetically still collapse. Drop
        // the extra draft (mark done), don't post it.
        s.doneDraftIds.push(item.draftId);
        action.executed = true;
        events.push({ type: "skip", reason: "duplicate-post", at });
      } else {
        // Pre-send revalidation (fail-closed). The queue fetch can be
        // minutes-to-hours old; since then this approval may have been decided
        // elsewhere (human skip / sent) or claimed by the x-intern API-autosend
        // pipeline (auto_send_target_at stamped — claimAutoSendDue posts it via
        // the official API). Posting anyway would duplicate a public reply, so
        // only a JUST-verified pending+unstamped approval proceeds; a failed
        // check retries under the normal cap (as a pre-dispatch failure)
        // instead of posting unverified.
        const gate = preSendDecision(await api.approvalState(item.approvalId).catch(() => null));
        const res: CommentOutcome =
          gate.action === "drop" ? { superseded: gate.reason }
          : gate.action === "retry" ? { ok: false, detail: gate.reason, dispatched: false }
          : await doComment(tabId, item, rng, s.persona.wpm, myEpoch, api);
        if ("superseded" in res) {
          // Another actor decided or owns this approval. Drop it locally so the
          // slot frees up — but write NOTHING durable: no markSent (this client
          // posted nothing) and no markSkipped (never clobber someone else's
          // decision/claim; the server already reflects the real state).
          s.doneDraftIds.push(item.draftId);
          action.executed = true;
          await wakeDiscoveryRead();
          events.push({ type: "skip", reason: `reply-${res.superseded}`, tweet_id: tweetIdFrom(item.url) ?? undefined, at });
        } else if ("unavailable" in res) {
          // Permanent: the target tweet can never be replied to from this
          // account — either the post is GONE (deleted by its author, a
          // protected account, account suspended, a dead permalink / 404) or
          // replies are restricted ("Who can reply?"). Either way no composer
          // will ever render, so DROP the draft (mark done locally) instead of
          // re-queueing it — the old path unshifted it to the FRONT of the
          // pool, so the SAME dead permalink was re-opened on every slot,
          // monopolizing the queue (and repeatedly navigating to a dead tweet
          // is a bot tell). Do NOT markSent — nothing was posted. The specific
          // cause rides in res.detail (post-unavailable | reply-restricted)
          // for the skip reason.
          s.doneDraftIds.push(item.draftId);
          action.executed = true;
          const reason = `reply-${res.detail ?? "post-unavailable"}`;
          // Also mark it skipped SERVER-SIDE so the queue stops re-serving this
          // permalink on every FUTURE run. The local drop only lasts the session;
          // the approval otherwise stays 'pending' forever (markSent never fires
          // for a tweet that can't be replied to), so each new run re-navigates
          // to it and drops it again. Best-effort: a failure just means it's
          // re-served next session.
          await api.markSkipped(item.approvalId, reason).catch(() => {});
          await wakeDiscoveryRead();
          events.push({ type: "skip", reason, tweet_id: tweetIdFrom(item.url) ?? undefined, at });
          // LEAVE the dead permalink — ALWAYS (not just drain mode): otherwise
          // ambient browsing + the next like idle on a dead page. Epoch-guarded
          // so a run stopped mid-attempt never moves the operator's tab.
          if (myEpoch === (await currentEpoch())) {
            await navigateTab(tabId, "https://x.com/home", rng).catch(() => {});
          }
        } else if (res.ok) {
          // Record the send LOCALLY *before* the network-fragile markSent, so a
          // transient "Failed to fetch" (e.g. api-vm restart) can't drop the
          // record and cause the draft to be re-served — and re-posted (the old
          // ordering: a markSent throw jumped to the catch below with the item
          // already shift()ed off the pool but never in doneDraftIds, so
          // maybeReplenish re-served it). markSent is then retried best-effort;
          // if it never confirms we still don't re-post (the draft is in
          // doneDraftIds), we just log it for reconcile.
          s.doneDraftIds.push(item.draftId);
          action.executed = true;
          s.done.comments++;
          const dk = tweetDedupKey(item.url);
          if (dk) (s.actionedUrls ??= []).push(dk);
          s.lastProgressMs = now; // a landed post = progress; the stall detector reads this
          const marked = await markSentWithRetry(api, item.approvalId, myEpoch);
          await wakeDiscoveryRead();
          // Stamp the replied tweet's id + approval id onto the activity row.
          // The tweet_id is the durable dedup-by-link record: written at post
          // time (this logActivity is independent of markSent), it survives a
          // failed markSent, and the queue (0086) filters future pulls against
          // it. The approval_id also fixes the per-author daily cap, whose
          // x_activity join was always empty on bare {type:'reply'} events.
          const evt: XActivityEvent = { type: "reply", approval_id: item.approvalId, at };
          const tid = tweetIdFrom(item.url);
          if (tid) evt.tweet_id = tid;
          events.push(evt);
          if (!marked) events.push({ type: "skip", reason: "marksent-unconfirmed", at });
          // Reply-also-likes (opt-in, cfg.replyAlsoLikes, DEFAULT OFF): a human
          // often likes what they engage with, but likes on X are an extra
          // uncapped behavioral write (docs/x-account-safety.md), so unlike the
          // LinkedIn actuator this only runs when explicitly enabled.
          // Best-effort + not counted against the like target.
          if (cfg.replyAlsoLikes === true) {
            // ...but not EVERY time. A 100%-consistent reply->like pairing is
            // itself a fingerprint, so a small drifting fraction is skipped
            // (rollLikeSkip; the rate re-rolls so it is not a static signature).
            const { skip: skipLike, next: nextSkip } = rollLikeSkip(s.likeSkip, () => rng.next());
            s.likeSkip = nextSkip;
            if (!skipLike) {
              const liked = await likeCurrentTweet(tabId, item, rng);
              if (liked) events.push({ type: "like", tweet_id: tweetIdFrom(item.url) ?? undefined, at });
            }
          }
          // Return to the timeline after replying — in EVERY mode, not just
          // drain — so the follow-up likes + ambient browsing land on the feed
          // (locateLike scrolls x.com/home), not on the just-replied tweet's
          // detail page. Epoch-guarded: a run stopped/superseded mid-reply must
          // never move the operator's tab.
          if (myEpoch === (await currentEpoch())) {
            await navigateTab(tabId, "https://x.com/home", rng).catch(() => {});
            await waitTabComplete(tabId);
          }
        } else {
          // Failure policy (replyFailureDecision, pure + unit-tested):
          //
          // 1) A submit gesture WAS dispatched (button click or ⌘/Ctrl+Enter
          //    chord — details not-cleared / submit-not-found, whose chord
          //    fallback also fires, and gesture-error, a mid-gesture throw):
          //    the outcome is AMBIGUOUS. If the post actually landed but
          //    replyPosted() false-negatived (a post landing slower than the
          //    observation window, or composer drift leaving text readable
          //    after success), a retry would re-navigate, re-type, and re-post
          //    the SAME reply to the SAME tweet — the exact spam signal this
          //    lane prevents. So: drop the draft locally (done, no markSent —
          //    nothing confirmed), stamp the tweet into actionedUrls so a
          //    sibling draft for the same tweet dies as duplicate-post, AND
          //    stamp tweet_id onto the skip row: the server dedup counts
          //    tweet_id-stamped skip rows as reply evidence (fail-closed), so
          //    the still-pending approval is NEVER re-served — cross-session
          //    retry of a maybe-landed submit is the same spam risk, just
          //    later. The approval stays pending for the operator to reconcile
          //    (send manually or reject) rather than being silently re-posted.
          // 2) Pre-dispatch failure (box-not-found / stopped early): nothing
          //    could have posted — retry, but BOUNDED (MAX_ACTION_TRIES) and
          //    at the BACK of the pool, so one un-submittable draft can't be
          //    retried every slot and starve every other pending reply.
          const stage = res.detail ? `:${res.detail}` : "";
          // 3) The PRE-SEND verify could not reach api-vm (restart, tunnel flap).
          //    That is an infra blip, not a bad target: nothing was attempted
          //    against X at all. Re-queue at the BACK and defer WITHOUT consuming
          //    a try — otherwise three api-vm hiccups against one draft retire it
          //    for the session, and a sustained outage silently drains the entire
          //    pool without a single post.
          const verifyUnreachable = res.dispatched !== true && res.detail === "verify-unreachable";
          const decision = verifyUnreachable
            ? ({ plan: "retry-back", tries: item.tries ?? 0 } as const)
            : replyFailureDecision(res.dispatched === true, item.tries ?? 0);
          if (decision.plan === "drop-ambiguous") {
            s.doneDraftIds.push(item.draftId);
            action.executed = true;
            const dk = tweetDedupKey(item.url);
            if (dk && !(s.actionedUrls ?? []).includes(dk)) (s.actionedUrls ??= []).push(dk);
            const evt: XActivityEvent = { type: "skip", reason: `reply-failed${stage}:ambiguous-dropped`, at };
            const tid = tweetIdFrom(item.url);
            if (tid) evt.tweet_id = tid;
            events.push(evt);
          } else if (decision.plan === "give-up") {
            // Drop the draft for this session (done locally, NOT markSent —
            // nothing posted) so it stops monopolizing reply slots. A later
            // session re-serves it fresh; server dedup is unaffected.
            item.tries = decision.tries;
            s.doneDraftIds.push(item.draftId);
            action.executed = true;
            events.push({ type: "skip", reason: `reply-failed:gave-up-after-${decision.tries}${stage}`, at });
          } else {
            item.tries = decision.tries;
            s.commentPool.push(item); // BACK of the queue — healthy drafts go first
            const d = deferLater(action, now, s.startMs + s.windowHours * 3600_000, rng);
            action.atMs = d.atMs;
            // Name the failing stage (box-not-found / stopped) so the
            // x_activity row says WHY, not just "failed".
            events.push({ type: "skip", reason: res.detail ? `reply-failed:${res.detail}` : "reply-failed", at });
          }
        }
      }
    }
  } catch (e) {
    // A STOP that unwound an in-flight action surfaces as AbortError — log it as
    // a clean "stopped" skip, not a scary error string.
    const reason = isAbortError(e) ? "stopped" : `err:${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`;
    events.push({ type: "skip", reason, at });
    // Mirror real errors (not clean stops) to the Chrome Bridge sink so the doctor
    // can see selector drift / attach failures without DevTools open (observability only).
    if (!isAbortError(e)) sinkLog("error", "tick action failed", { reason });
  }

  // Surface the outcome to the panel (DevTools can't be open during a run).
  const last = events[events.length - 1];
  if (last) {
    s.lastEvent =
      last.type === "like"
        ? (last.engagement && last.engagement !== "like"
            ? `${engagementLabel(last.engagement as EngagementKind).toLowerCase()}ed @${last.author_handle ?? "a tweet"} (${s.done.likes}/${s.targets.likes})`
            : `liked @${last.author_handle ?? "a tweet"} (${s.done.likes}/${s.targets.likes})`)
      : last.type === "reply" ? `replied (${s.done.comments}/${s.targets.comments})`
      : `skip: ${last.reason ?? "?"}`;
  }

  // Drain auto-continue: before ending a finished drain, try to append another
  // batch for any approvals still in the inbox, so one Drain clears it all.
  if (s.mode === "drain" && s.actions.every((a) => a.executed)) {
    const extended = await maybeExtendDrain(s, cfg, api, now, rng); // appends non-executed slots when work remains
    // Persistent drain: an empty inbox does NOT end the run. Keep it alive and
    // watching (roll the window, arm the next watch-poll) so a reply approved
    // later goes out with no re-click. Only STOP, a challenge halt, or the batch
    // ceiling (drainShouldKeepWaiting=false) end a drain now.
    if (!extended && drainShouldKeepWaiting(s.mode, s.drainRounds ?? 0)) {
      s.windowHours = (now - s.startMs) / 3600_000 + DRAIN_WATCH_WINDOW_H;
      s.lastDrainWatchMs = now;
      s.lastEvent = "inbox clear — watching for new approvals (no re-click needed)";
    }
  }

  // A caught-up persistent drain stays "running" (watching); every other finished
  // run goes idle and is ended below.
  if (s.actions.every((a) => a.executed) && !drainShouldKeepWaiting(s.mode, s.drainRounds ?? 0)) {
    s.status = "idle";
  }
  // Persist only if we're still the live run. A STOP or a superseding Run that
  // landed mid-tick bumped the epoch, so saveIfCurrent drops this write instead
  // of resurrecting a run that was already stopped/replaced.
  const saved = await saveIfCurrent(s);
  await api.logActivity(s.sessionId, events).catch(() => {});
  if (saved && s.status === "idle") await endRun("idle");
}

// Outcome of a reply attempt. A plain ReplyResult flows through the verified
// submit pipeline (ok / failed-with-stage-detail + the dispatched ambiguity
// flag). `{ unavailable }` means the target tweet no longer exists / can't be
// replied to — either the post is GONE (deleted, protected, suspended account,
// dead permalink) or replies are restricted ("Who can reply?"); its `detail`
// names the cause (post-unavailable | reply-restricted) — a PERMANENT failure
// the caller must drop, not retry. `{ superseded }` means the pre-send
// approval-state check found the approval decided or owned elsewhere (human
// skip/sent, or the x-intern API-autosend claim) — drop locally with NO
// durable write. On a plain failure, `detail` names the exact stage that broke
// ("box-not-found" / "submit-not-found" / "not-cleared" / …) so the DB skip
// row (x_activity.reason = `reply-failed:<detail>`) says WHY without a live
// DevTools session — mirroring the like path's `no-likeable-tweet(...)`
// diagnostics. Signature reading: a wall of not-cleared = a live reply
// action-block, submit-not-found = submit selector drift, box-not-found =
// composer/post-type drift.
type CommentOutcome = ReplyResult | { unavailable: true; detail?: string } | { superseded: string };

// markSent, retried with backoff. Returns whether the send was confirmed to the
// server. The caller has ALREADY recorded the draft locally as done, so a false
// return never causes a re-post — it only means the DB approval may still read
// 'pending' until a later tick reconciles. Epoch-aware: once the run that posted
// is stopped/superseded, stop retrying (the reconcile skip event still logs).
async function markSentWithRetry(api: ActuatorApi, approvalId: string, epoch: number): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await api.markSent(approvalId);
      return true;
    } catch {
      if (epoch !== (await currentEpoch())) return false; // run stopped/superseded — stop retrying
      if (attempt < 3) await sleep(800 * (attempt + 1)); // linear backoff
    }
  }
  return false;
}

// Best-effort like on the tweet just replied to (doComment navigated to its
// status page). Opt-in via cfg.replyAlsoLikes — see the call site. Passes the
// reply target's id so the content script picks the right <article> on a thread
// page. Not counted against the like target. Returns whether a like landed.
// Never throws (best-effort means best-effort): a CDP throw here would abort
// the tick mid-bookkeeping (e.g. skip the drain-mode return-to-home nav) for a
// decoy action.
async function likeCurrentTweet(tabId: number, item: PoolItem, rng: ReturnType<typeof makeRng>): Promise<boolean> {
  if (stopped()) return false; // STOP after the reply → skip the decoy like
  try {
    const loc = await send<{ ok: boolean; x?: number; y?: number; rect?: Rect }>(
      tabId, { cmd: "locatePostLike", tweetId: tweetIdFrom(item.url) },
    ).catch(() => null);
    if (!loc?.ok || loc.x == null) return false;
    await sleep(rng.float(500, 1500)); // a beat between posting and liking
    await actorClick(tabId, rectFrom(loc), rng);
    return true;
  } catch {
    return false;
  }
}

// Open the post, locate + type, then submit VERIFIED via trusted CDP input.
// Never throws: every failure comes back as a ReplyResult so it flows through
// replyFailureDecision at the call site. A throw that escaped to tickOnce's
// generic catch would lose the pool item without recording it (already
// shift()ed, never in doneDraftIds) → maybeReplenish re-serves it with NO tries
// bookkeeping and, worse, with no dispatched verdict. Everything before
// submitReply is pre-dispatch (nav / locate / focus-click / typing), so a throw
// here is safely a bounded retry; submitReply itself never throws (see
// runSubmitReply) and owns the post-dispatch ambiguity.
async function doComment(tabId: number, item: PoolItem, rng: ReturnType<typeof makeRng>, wpm: number, epoch: number, api: ActuatorApi): Promise<CommentOutcome> {
  // Has anything been typed into the composer yet? Every exit after this flips
  // true — except a landed post, which clears the box itself — has to empty it
  // again, or the next navigation raises a "Leave site?" dialog nobody can answer.
  let typed = false;
  try {
    await navigateTab(tabId, item.url, rng);
    await waitTabComplete(tabId);
    // Read the target post like a human before replying — dwell proxied from a
    // ~60-word read at this session's pace (we don't have the post's wc here).
    await sleep(readingDwellMs(rng, Math.max(0, Math.round(rng.normal(60, 40))), {}, wpm));
    // tab.status=complete and the reading dwell do not guarantee X's SPA has
    // mounted the reply editor. Poll that condition briefly on this SAME pinned
    // permalink, rechecking permanent dead/restricted states on each attempt.
    const targetId = tweetIdFrom(item.url);
    const composer = await waitForReplyComposer({
      now: Date.now,
      sleep,
      stale: async () => stopped() || epoch !== (await currentEpoch()),
      onTarget: async () => {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        const url = tab?.pendingUrl ?? tab?.url;
        return isXPageUrl(url) && targetId !== null && tweetIdFrom(url) === targetId;
      },
      postUnavailable: async () => {
        const state = await send<{ observed?: { unavailable?: boolean } }>(tabId, { cmd: "detectPostUnavailable" }).catch(() => null);
        return state?.observed?.unavailable === true;
      },
      replyRestricted: async () => {
        const state = await send<{ observed?: { restricted?: boolean } }>(tabId, { cmd: "detectReplyRestricted" }).catch(() => null);
        return state?.observed?.restricted === true;
      },
      locateBox: () => send<{ ok: boolean; x?: number; y?: number; rect?: Rect; skipReason?: string }>(tabId, { cmd: "locateCommentBox" }),
    }, targetId);
    if (composer.kind === "stopped") return { ok: false, detail: "stopped", dispatched: false };
    if (composer.kind === "unavailable") return { unavailable: true, detail: composer.detail };
    if (composer.kind === "missing") return { ok: false, detail: composer.detail, dispatched: false };
    const box = composer.box;
    if (stopped() || epoch !== (await currentEpoch())) return { ok: false, detail: "stopped", dispatched: false };
    await actorClick(tabId, rectFrom(box), rng); // focus the box
    typed = true; // from here on, any non-landing exit must empty the box again
    await cdp.typeText(tabId, item.body, rng, sleep);
    await sleep(rng.float(400, 2000));
  } catch (e) {
    console.warn("[actuator] reply setup failed pre-dispatch", e);
    if (typed) await clearComposer(tabId, rng);
    return { ok: false, detail: "nav-or-type-error", dispatched: false };
  }
  // STOP before we dispatch the submit gesture. This is a PRE-dispatch bail
  // (nothing has been submitted yet), so unwinding here is safe — the tick catch
  // maps it to a clean "stopped" skip and saveIfCurrent (stale epoch post-STOP)
  // drops the shift, leaving the draft in the persisted pool. Once submitReply is
  // called, the dispatched-ambiguity lives in runSubmitReply (submit.ts) instead.
  try {
    throwIfAborted(runAbort.signal);
  } catch (e) {
    // A STOP unwinding here leaves the just-typed reply sitting in the box, and
    // the operator's very next navigation would hit "Leave site?". Clear before
    // re-throwing so a stopped run leaves the tab as it found it.
    await clearComposer(tabId, rng);
    throw e;
  }
  // Reserve the numeric tweet ID after the composer is ready, immediately
  // before any submit gesture. A denied or ambiguous claim cannot be retried:
  // the server may have committed it even when the response was lost.
  const claimed = await claimReplyBeforeSubmit(api, item.approvalId);
  if (!claimed) {
    await clearComposer(tabId, rng);
    return { superseded: "claim-denied-or-unknown" };
  }
  if (stopped() || epoch !== (await currentEpoch())) {
    await clearComposer(tabId, rng);
    return { superseded: "stopped-after-claim" };
  }
  const res = await submitReply(tabId, rng, epoch);
  // A landed reply clears the composer itself (that IS how `posted()` confirms
  // it). Every other outcome leaves the typed text in the box, and the next
  // chrome.tabs.update — the hop to the next permalink, or the return to the
  // feed — would then navigate away from a dirty composer and raise Chromium's
  // "Leave site? Changes you made may not be saved." That dialog blocks the
  // renderer, freezes the content script's tick loop, and wedges the whole run
  // until a human clicks it. It cannot be answered over CDP either: handling
  // `beforeunload` via Page.handleJavaScriptDialog is broken upstream
  // (puppeteer/puppeteer#9871), so removing the TRIGGER is the only fix.
  if (!res.ok) await clearComposer(tabId, rng);
  return res;
}

/**
 * Every navigation this actuator makes. Binds the shared clear-then-navigate
 * helper (see makeNavigateTab for why the clear belongs at the navigation and
 * not only on the failure path) to Vega's composer.
 *
 * Declared as a `function` deliberately: ensureOnFeed calls it a thousand lines
 * above clearComposer's definition, which only hoisting makes legal.
 */
function navigateTab(
  tabId: number,
  url: string,
  rng: ReturnType<typeof makeRng>,
  /**
   * Re-checked AFTER the clear, immediately before the navigation. The clear
   * can take a couple of seconds, so a caller that already checked a liveness
   * condition (the notification sweep's epoch guard) would otherwise have that
   * check go stale in the gap and still yank the operator's tab. Returning
   * false makes the navigation a no-op.
   */
  stillWanted?: () => Promise<boolean>,
): Promise<void> {
  return makeNavigateTab({
    clearComposer: (id) => clearComposer(id, rng),
    updateTab: async (id, u) => {
      await chrome.tabs.update(id, { url: u });
    },
    // Handed to the helper rather than checked inside updateTab, so it also
    // runs BEFORE the clear: bailing only at the navigation would still have
    // wiped the operator's draft on the way to a hop we then abandon.
    ...(stillWanted ? { shouldProceed: stillWanted } : {}),
  })(tabId, url);
}

/**
 * Empty the reply composer and confirm it, so the next navigation cannot raise
 * a `beforeunload` dialog. Best-effort and never throws: it runs on paths that
 * have already decided the draft's fate, and it must not convert a handled
 * reply failure into an unhandled tick error. A box that refuses to clear is
 * logged (the sink is the only window in during a run) but not fatal — the
 * dialog is a stall, not a correctness problem.
 */
async function clearComposer(tabId: number, rng: ReturnType<typeof makeRng>): Promise<void> {
  const cleared = await runClearComposer({
    focusBox: async () => {
      const box = await send<{ ok: boolean; x?: number; y?: number; rect?: Rect }>(
        tabId, { cmd: "locateCommentBox" },
      ).catch(() => null);
      if (!box?.ok || box.x == null) return false;
      await actorClick(tabId, rectFrom(box), rng);
      return true;
    },
    clearKeys: () => cdp.clearFocusedEditor(tabId, sleep),
    isEmpty: () => replyPosted(tabId), // "composer gone or empty" — the same read
    sleep,
  });
  // Confirmed independently of the return value, the same way LinkedIn and
  // Reddit now do it. runClearComposer reports success when the box cannot be
  // FOCUSED, on the reasonable assumption that an unfocusable box is an absent
  // one — but locateCommentBox refuses a zero rect (rightly: a synthesized 4x4
  // box at the viewport corner is not a composer), so a present-but-hidden
  // dirty composer takes that path and the warning is swallowed for the exact
  // state that still arms the dialog. Positive test, so an unreadable content
  // script does not warn either.
  if (!cleared || (await replyBoxHasText(tabId))) {
    sinkLog("warn", "composer would not clear; next navigation may raise a leave-site dialog", { tabId });
  }
}

/** Can we POSITIVELY see text still in the reply composer? Distinct from
 *  `!replyPosted`, which is also true when the box cannot be READ. */
async function replyBoxHasText(tabId: number): Promise<boolean> {
  const st = await send<{ ok: boolean; observed?: { present?: boolean; empty?: boolean } }>(
    tabId, { cmd: "readCommentBox" },
  ).catch(() => null);
  return st?.observed?.present === true && st.observed?.empty === false;
}

// Read the composer state: has the just-typed reply posted? X clears the inline
// composer (and unmounts the modal one) on a successful post, so an empty (or
// vanished) box = landed, a populated box = did NOT land. Any read error is
// treated as "not confirmed" (caller retries / falls back), never a false success.
async function replyPosted(tabId: number): Promise<boolean> {
  const st = await send<{ ok: boolean; observed?: { present?: boolean; empty?: boolean } }>(
    tabId, { cmd: "readCommentBox" },
  ).catch(() => null);
  if (!st) return false;
  return st.observed?.present === false || st.observed?.empty === true;
}

// Submit the just-typed reply and CONFIRM it actually landed. Thin adapter
// over runSubmitReply (background/submit.ts — pure, unit-tested, NEVER throws:
// a mid-gesture throw comes back as detail:"gesture-error" with the dispatched
// flag preserved, so an operator dismissing the chrome.debugger infobar after
// a click/chord went out still lands in drop-ambiguous, not a re-post).
//
// On failure the bare stage name is enriched with the diagnostics ported from
// the LinkedIn actuator (#442/#444, background/detail.ts) so the DB skip row
// is diagnosable without a live DevTools session:
//   not-cleared(via=…,btn=…,type=…) → a submit was clicked/chorded but the
//                      composer never cleared (submit rejected — a live
//                      action-block — or the click hit a decoy; btn/via name
//                      the exact button). A wall of `not-cleared` on the REAL
//                      submit across posts is the signature of an X
//                      action-block.
//   submit-not-found(b=…,box=…,empty=…,wf=…,en=…,vis=…,top=…,dom=…,reg=…) →
//                      no clickable submit ever appeared in the poll. The
//                      composer read + search diagnostic split the causes:
//                      box=present,empty=false = the reply is still sitting
//                      there; wf=0 = no worded submit exists (selector model
//                      wrong), en=0 = it never enabled (typing/state),
//                      en>0,vis=0 = enabled but no layout box yet.
async function submitReply(tabId: number, rng: ReturnType<typeof makeRng>, epoch: number): Promise<ReplyResult> {
  // Descriptor of the last submit the click landed on (locateCommentSubmit's
  // observed via/aria/text/type) — captured by the locate dep so a not-cleared
  // failure names WHICH button was clicked (the real submit vs a decoy).
  let clicked: SubmitObserved | undefined;
  const res = await runSubmitReply({
    now: Date.now,
    sleep,
    stale: async () => epoch !== (await currentEpoch()), // run stopped/superseded mid-submit
    locateSubmit: async () => {
      const submit = await send<{ ok: boolean; x?: number; y?: number; rect?: Rect; observed?: SubmitObserved }>(tabId, { cmd: "locateCommentSubmit" });
      if (submit.ok && submit.x != null) clicked = submit.observed;
      return submit;
    },
    clickSubmit: (loc) => actorClick(tabId, rectFrom(loc), rng),
    posted: () => replyPosted(tabId),
    refocusComposer: async () => {
      const box = await send<{ ok: boolean; x?: number; y?: number; rect?: Rect }>(tabId, { cmd: "locateCommentBox" }).catch(() => null);
      if (box?.ok && box.x != null) await actorClick(tabId, rectFrom(box), rng);
    },
    chord: (mod) => cdp.pressSubmitChord(tabId, mod),
  });
  if (res.ok) return res;
  if (res.detail === "not-cleared") {
    res.detail = notClearedDetail(clicked);
  } else if (res.detail === "submit-not-found") {
    const st = await send<{ ok: boolean; observed?: { present?: boolean; empty?: boolean } }>(
      tabId, { cmd: "readCommentBox" },
    ).catch(() => null);
    // Why did the submit never resolve? diagnoseCommentSubmit re-walks the
    // search and buckets the failure (an older content script without this
    // command returns nothing → detail formats without the extra fields).
    const dg = await send<{ ok: boolean; observed?: SubmitDiag }>(
      tabId, { cmd: "diagnoseCommentSubmit" },
    ).catch(() => null);
    res.detail = submitNotFoundDetail(st?.observed, dg?.observed);
  }
  console.warn("[actuator] reply did not land", { detail: res.detail, dispatched: res.dispatched });
  return res;
}

// ── Lights-out autonomy ────────────────────────────────────────────────────
// A persistent alarm (survives service-worker suspend) checks a few times an
// hour whether to auto-start the daily run, no manual Run click. Once started,
// the content-script tick loop drives it as usual; a persisted day key enforces
// one auto-start per day. Requires a logged-in x.com tab open (startRun
// attaches to it); with none open the run pauses until a tab appears.
const AUTO_START_DAY_KEY = "actuator.lastAutoStartDay";
// Day key of the most recent challenge halt (stamped in endRun). Drives the
// post-challenge cooldown/backoff + health safety gate below. Distinct from
// AUTO_START_DAY_KEY so a suppressed tick never masks the once-per-day guard.
const CHALLENGE_DAY_KEY = "actuator.lastChallengeDay";
// Day key of the last manual STOP. A STOP must silence BOTH autonomy paths for
// the rest of the day (the daily auto-start already stamps AUTO_START_DAY_KEY;
// auto-drain has no daily guard, so it reads this instead).
const STOP_DAY_KEY = "actuator.lastManualStopDay";
// ms stamp of the last auto-drain start + the re-arm cooldown between starts.
// The cooldown bounds the pathological loop of a drain that keeps dying with
// items still queued (no x.com tab, reply-fail give-ups) — without it the 5-min
// alarm would relaunch a doomed drain forever.
const AUTO_DRAIN_MS_KEY = "actuator.lastAutoDrainMs";
const AUTO_DRAIN_REARM_MIN = 30;
// No-progress threshold that flags a running run as a stall CANDIDATE (while
// drafts are loaded and comment slots are overdue). Only a candidate: recovery
// additionally requires the stall to persist across two consecutive autonomy
// ticks with no progress between them (confirmStall) — that is what actually
// rules out a healthy run's large-but-legitimate gaps (scheduled-mode spacing
// under maxWritesPerHour, or a post mid-flight while the slot still reads
// overdue). This floor just avoids probing on short pacing gaps. Config override:
// cfg.stallRecoverMinutes.
const STALL_RECOVER_MIN = 20;
// Two-tick confirmation probe: the last stall observation (session + progress
// marker). Recovery only acts when a run looks stalled on two consecutive
// autonomy ticks with no progress between them (see confirmStall).
const STALL_PROBE_KEY = "actuator.stallProbe";
// Last build stamp a self-reload was attempted for (one attempt per stamp).
const RELOAD_STAMP_KEY = "actuator.lastReloadStamp";
// Durable standing intent for BOTH drain buttons ("Drain all approvals" and
// "Full automatic"). Set on the click, cleared ONLY by STOP — so the drain
// resumes after anything that wipes the in-memory run (self-reload, SW death,
// browser restart, closed tab). Value is `{ curfew: boolean }` — the one thing
// that differs between the two buttons (Full auto = overnight curfew on). A legacy
// bare `true` (an older Full-auto build) is read as `{ curfew: true }`. See
// shouldResumeDrain. Storage string kept as "actuator.fullAuto" for back-compat.
const DRAIN_INTENT_KEY = "actuator.fullAuto";
type DrainIntent = { curfew: boolean; notifications: boolean };
/** Parse the stored drain intent (handles the legacy bare-`true` Full-auto value). */
function parseDrainIntent(raw: unknown): DrainIntent | null {
  if (raw === true) return { curfew: true, notifications: false };
  if (raw && typeof raw === "object") {
    const o = raw as { curfew?: boolean; notifications?: boolean };
    // `notifications` is carried through the standing intent so an Auto-
    // notifications run that dies to a reload/SW-death resumes as a
    // notifications run, not a plain drain — the sweep is the whole point.
    return { curfew: o.curfew === true, notifications: o.notifications === true };
  }
  return null;
}
async function ensureAutonomyAlarm(): Promise<void> {
  if (!(await chrome.alarms.get(AUTONOMY_ALARM))) {
    await chrome.alarms.create(AUTONOMY_ALARM, { periodInMinutes: 5 });
  }
}
async function checkAutonomy(): Promise<void> {
  const expectedEpoch = await currentEpoch();
  if (await remoteStopped()) return; // remote STOP is authoritative — hands stay down
  const cfg = await getConfig();
  if (!cfg?.autonomous) return;
  const s = await loadState();
  const now = new Date();
  const store = await chrome.storage.local.get(AUTO_START_DAY_KEY);
  // Read the challenge-day stamp fail-closed: if storage throws, skip this tick
  // rather than risk auto-starting a freshly-challenged account.
  let lastChallengeDay: string | null;
  try {
    const chStore = await chrome.storage.local.get(CHALLENGE_DAY_KEY);
    lastChallengeDay = (chStore[CHALLENGE_DAY_KEY] as string | undefined) ?? null;
  } catch {
    console.warn("[autonomy] challenge-day read failed; skipping auto-start");
    return;
  }
  const decide = shouldAutoStart({
    autonomous: true,
    runActive: s?.status === "running",
    localHour: now.getHours(),
    startHour: cfg.autoStartHour ?? 9,
    endHour: cfg.autoEndHour ?? 21,
    todayKey: localDayKey(now),
    lastAutoStartDay: (store[AUTO_START_DAY_KEY] as string | undefined) ?? null,
    // Post-challenge backoff (default OFF via undefined/0).
    lastChallengeDay,
    challengeBackoffDays: cfg.autoChallengeBackoffDays ?? 0,
  });
  if (!decide) {
    // A run may be live but WEDGED (running, not posting). Recover it first —
    // shouldAutoDrain's runActive gate can't, so a wedged run would otherwise pin
    // the actor with approvals piling up. If nothing needed recovery, fall through
    // to lights-out inbox clearing (approvals waiting while nothing runs).
    const recovered = await maybeRecoverStalledRun(cfg, s ?? null, now, lastChallengeDay, expectedEpoch);
    if (!recovered) await maybeAutoDrain(cfg, s ?? null, now, lastChallengeDay, expectedEpoch);
    return;
  }

  // Secondary safety gate: post-challenge cooldown (default 3d) + server health.
  // Any error/non-2xx/timeout from health() collapses to null → treated as
  // not-ok when the gate is on (default) → skip. Manual operator Run (the
  // 'startRun' message path) never runs this gate.
  const api = new ActuatorApi(cfg);
  const health = await api.health().catch(() => null); // fetch fail → null → fail-closed
  const safe = passesAutoStartSafety({
    healthGate: cfg.healthGate ?? true,
    healthStatus: health?.status ?? null,
    challengeCooldownDays: cfg.challengeCooldownDays ?? 3,
    todayKey: localDayKey(now),
    lastChallengeDay,
  });
  if (!safe) {
    console.warn("[autonomy] auto-start suppressed by safety gate", { health: health?.status ?? "unknown" });
    return; // do NOT stamp AUTO_START_DAY_KEY → re-evaluates next tick when health recovers
  }

  // Stamp the day BEFORE starting so a mid-start crash can't double-fire today.
  if (!(await runIfCurrent(expectedEpoch, () => chrome.storage.local.set({ [AUTO_START_DAY_KEY]: localDayKey(now) })))) return;
  await startRun({
    windowHours: cfg.autoWindowHours ?? 8,
    targetComments: cfg.autoTargetComments ?? 20,
    targetLikes: cfg.autoTargetLikes ?? 40,
  }, { curfew: true, expectedEpoch }).catch((e) => console.warn("[autonomy] auto-start failed:", e instanceof Error ? e.message : e)); // unattended → overnight posting-curfew on
}

/**
 * Resume a standing drain whenever its durable intent is set and nothing is
 * running. This is what makes BOTH drain buttons mean runs-until-STOP: each button
 * persists DRAIN_INTENT_KEY (with its curfew choice), and every recovery point
 * (both alarms, browser startup) calls this, so the drain comes back within
 * seconds of any death — a self-reload onto a new build, a service-worker restart,
 * a browser relaunch, a closed-then-reopened tab. Resumes with the SAME curfew the
 * operator picked (Full auto → curfew on; Drain → off). Independent of the
 * lights-out `autonomous` switch (a drain button is its own one-click consent),
 * but it reuses the SAME post-challenge + health safety gate as auto-start, so a
 * freshly-challenged account holds off and resumes only once clean — no re-click,
 * no hammering. Cleared only by STOP.
 */
async function checkDrainResume(): Promise<void> {
  const expectedEpoch = await currentEpoch();
  if (await remoteStopped()) return; // remote STOP hard-gates the drain resume too
  const cfg = await getConfig();
  if (!cfg) return;
  let intent: DrainIntent | null;
  let lastChallengeDay: string | null;
  try {
    const store = await chrome.storage.local.get([DRAIN_INTENT_KEY, CHALLENGE_DAY_KEY]);
    intent = parseDrainIntent(store[DRAIN_INTENT_KEY]);
    lastChallengeDay = (store[CHALLENGE_DAY_KEY] as string | undefined) ?? null;
  } catch {
    return; // storage flaky → skip this tick, retry next
  }
  if (!intent) return;
  const s = await loadState();
  const runActive = s?.status === "running";
  if (runActive) return; // already running — nothing to resume
  const now = new Date();
  const api = new ActuatorApi(cfg);
  const health = await api.health().catch(() => null); // fetch fail → null → fail-closed
  const safe = passesAutoStartSafety({
    healthGate: cfg.healthGate ?? true,
    healthStatus: health?.status ?? null,
    challengeCooldownDays: cfg.challengeCooldownDays ?? 3,
    todayKey: localDayKey(now),
    lastChallengeDay,
  });
  if (!shouldResumeDrain({ intentSet: true, runActive, safe })) {
    if (!safe) console.warn("[drain-resume] held by safety gate", { health: health?.status ?? "unknown" });
    return;
  }
  const resumedCurfew = (await browserDiscoveryEnabled()) ? false : intent.curfew;
  console.info("[drain-resume] resuming persistent drain (standing intent, no live run)", { curfew: resumedCurfew, notifications: intent.notifications });
  await startDrain({ manual: true, curfew: resumedCurfew, notifications: intent.notifications, expectedEpoch }).catch((e) =>
    console.warn("[drain-resume] resume failed:", e instanceof Error ? e.message : e),
  );
}

// Lights-out inbox clearing. When the operator opted in (Options → auto-drain),
// start a drain whenever the server is willing to serve approved replies and
// nothing is running — an approval made mid-afternoon goes out mid-afternoon
// instead of waiting for tomorrow's scheduled run or a manual Drain click.
// Consent to post is the STANDING dashboard switch the queue route enforces
// (reply_send_enabled, or auto_send_enabled as durable lights-out consent);
// this path NEVER arms sending itself, so the panic-stop kill switch stays
// authoritative: once Pause-all clears the flags the queue serves empty and
// this loop starves. Supply == what /api/actionable-x returns, so every
// server-side withhold gate (challenge breaker, daily write cap) also starves
// it. Runs behind the same health + challenge-cooldown safety gate as the
// daily auto-start, and a manual STOP silences it for the rest of the day.
async function maybeAutoDrain(
  cfg: ActuatorConfig,
  s: RunState | null,
  now: Date,
  lastChallengeDay: string | null,
  expectedEpoch: number,
): Promise<void> {
  if (expectedEpoch !== await currentEpoch()) return;
  const store = await chrome.storage.local.get([AUTO_DRAIN_MS_KEY, STOP_DAY_KEY]);
  const base = {
    autonomous: true, // caller already required cfg.autonomous
    autoDrain: cfg.autoDrain ?? false,
    runActive: s?.status === "running",
    localHour: now.getHours(),
    startHour: cfg.autoStartHour ?? 9,
    endHour: cfg.autoEndHour ?? 21,
    lastAutoDrainMs: (store[AUTO_DRAIN_MS_KEY] as number | undefined) ?? null,
    nowMs: now.getTime(),
    minGapMinutes: AUTO_DRAIN_REARM_MIN,
    todayKey: localDayKey(now),
    stopDay: (store[STOP_DAY_KEY] as string | undefined) ?? null,
  };
  // Cheap gates first (pendingComments=1 stands in for "unknown supply") so the
  // network calls below are only spent when a drain could actually start.
  if (!shouldAutoDrain({ ...base, pendingComments: 1 })) return;

  // Same safety gate as the daily auto-start: post-challenge cooldown + x-health.
  const api = new ActuatorApi(cfg);
  const health = await api.health().catch(() => null); // fetch fail → null → fail-closed
  const safe = passesAutoStartSafety({
    healthGate: cfg.healthGate ?? true,
    healthStatus: health?.status ?? null,
    challengeCooldownDays: cfg.challengeCooldownDays ?? 3,
    todayKey: localDayKey(now),
    lastChallengeDay,
  });
  if (!safe) {
    console.warn("[autonomy] auto-drain suppressed by safety gate", { health: health?.status ?? "unknown" });
    return; // no stamp → re-evaluates next tick when health recovers
  }

  const queue = await api.fetchQueue().catch(() => null); // fetch fail → no drain
  if (!queue) return;
  if (!shouldAutoDrain({ ...base, pendingComments: queue.comments.length })) return;

  // Stamp BEFORE starting so a mid-start crash can't machine-gun restarts.
  if (!(await runIfCurrent(expectedEpoch, () => chrome.storage.local.set({ [AUTO_DRAIN_MS_KEY]: now.getTime() })))) return;
  console.info("[autonomy] auto-drain starting", { pending: queue.comments.length });
  await startDrain({ curfew: true, expectedEpoch }).catch((e) => // unattended → overnight posting-curfew on
    console.warn("[autonomy] auto-drain failed:", e instanceof Error ? e.message : e),
  );
}

async function clearStallProbe(): Promise<void> {
  await chrome.storage.local.remove(STALL_PROBE_KEY).catch(() => {});
}

// Stalled-run recovery. shouldAutoDrain skips whenever a run is live, so a run
// that is "running" but WEDGED — a frozen tick loop, a tab that wandered off, a
// wall of comment-failed skips — pins the actor with approvals piling up and
// never recovers. This supersedes such a run with a fresh drain, but ONLY when it
// is provably stalled (drafts loaded + comment slots overdue + no post for
// STALL_RECOVER_MIN, past warm-up) and only behind the same consent/health/
// challenge/window/STOP gates as auto-drain. It shares the auto-drain re-arm
// stamp, so a false positive can start at most one drain per re-arm window. Never
// arms sending (startDrain unattended); supply is still the server queue gate, so
// a wrongly-triggered recovery just supersedes the wedged run and starves.
// Returns true when it acted (so the caller skips maybeAutoDrain this tick).
async function maybeRecoverStalledRun(
  cfg: ActuatorConfig,
  s: RunState | null,
  now: Date,
  lastChallengeDay: string | null,
  expectedEpoch: number,
): Promise<boolean> {
  if (expectedEpoch !== await currentEpoch()) return false;
  if (!s || s.status !== "running") { await clearStallProbe(); return false; } // only a live run can be wedged
  const nowMs = now.getTime();
  const store = await chrome.storage.local.get([AUTO_DRAIN_MS_KEY, STOP_DAY_KEY, STALL_PROBE_KEY]);
  const dueCommentSlots = s.actions.filter(
    (a) => !a.executed && a.kind === "comment" && a.atMs <= nowMs,
  ).length;
  const decide = shouldRecoverStalledRun({
    autonomous: true, // caller already required cfg.autonomous
    autoDrain: cfg.autoDrain ?? false,
    runActive: true,
    msSinceProgress: nowMs - (s.lastProgressMs ?? s.startMs),
    msSinceStart: nowMs - s.startMs,
    warmupSuppressMs: s.warmupSuppressMs,
    stallThresholdMs: (cfg.stallRecoverMinutes ?? STALL_RECOVER_MIN) * 60_000,
    loadedDrafts: s.commentPool.length,
    dueCommentSlots,
    localHour: now.getHours(),
    startHour: cfg.autoStartHour ?? 9,
    endHour: cfg.autoEndHour ?? 21,
    lastAutoDrainMs: (store[AUTO_DRAIN_MS_KEY] as number | undefined) ?? null,
    nowMs,
    minGapMinutes: AUTO_DRAIN_REARM_MIN,
    todayKey: localDayKey(now),
    stopDay: (store[STOP_DAY_KEY] as string | undefined) ?? null,
  });
  // Two-tick confirmation: a healthy run momentarily past the no-progress
  // threshold (a legit large scheduled-mode gap, or a post mid-flight) still
  // posts within ~60s, so the next tick sees advanced progress and never
  // confirms. A real wedge makes no progress across ticks and confirms.
  const progressMs = s.lastProgressMs ?? s.startMs;
  const probe = (store[STALL_PROBE_KEY] as StallProbe | undefined) ?? null;
  const outcome = confirmStall({ stalledNow: decide, sessionId: s.sessionId, progressMs, probe });
  if (outcome === "clear") { if (probe) await clearStallProbe(); return false; }
  if (outcome === "observe") {
    await chrome.storage.local.set({ [STALL_PROBE_KEY]: { sid: s.sessionId, progressMs } satisfies StallProbe });
    return false;
  }
  // outcome === "recover": stalled across two consecutive ticks with no progress.

  // Same safety gate as auto-start/auto-drain: post-challenge cooldown + /health.
  const api = new ActuatorApi(cfg);
  const health = await api.health().catch(() => null); // fetch fail → null → fail-closed
  const safe = passesAutoStartSafety({
    healthGate: cfg.healthGate ?? true,
    healthStatus: health?.status ?? null,
    challengeCooldownDays: cfg.challengeCooldownDays ?? 3,
    todayKey: localDayKey(now),
    lastChallengeDay,
  });
  if (!safe) {
    console.warn("[autonomy] stall-recovery suppressed by safety gate", { health: health?.status ?? "unknown" });
    return false; // no stamp → re-evaluates next tick when health recovers
  }

  // Stamp the SHARED auto-drain cooldown BEFORE (re)starting: one drain start —
  // auto OR recovery — per re-arm window, so a false stall can't machine-gun.
  if (!(await runIfCurrent(expectedEpoch, async () => {
    await chrome.storage.local.set({ [AUTO_DRAIN_MS_KEY]: nowMs });
    await chrome.storage.local.remove(STALL_PROBE_KEY);
  }))) return false;
  // Consumed this observation; the superseding run gets a fresh session.
  const stalledMin = Math.round((nowMs - (s.lastProgressMs ?? s.startMs)) / 60_000);
  console.info("[autonomy] recovering stalled run — superseding with a fresh drain", {
    stalledMin, loaded: s.commentPool.length, dueSlots: dueCommentSlots,
  });
  sinkLog("warn", "stall-recovery: superseding wedged run with a drain", {
    stalledMin, loaded: s.commentPool.length, dueSlots: dueCommentSlots,
  });
  // startDrain bumps the epoch → the wedged run's next tick sees a stale epoch and
  // bails, so no explicit endRun is needed. Unattended → never arms sending, and
  // overnight posting-curfew on (same as the other unattended paths).
  await startDrain({ curfew: true, expectedEpoch }).catch((e) =>
    console.warn("[autonomy] stall-recovery drain failed:", e instanceof Error ? e.message : e),
  );
  return true;
}

// Self-reload when a newer build lands on disk. Deploys are merge-driven
// (`noelle sync` rebuilds the extension into .output/chrome-mv3), but an
// unpacked extension keeps running stale code until something reloads it.
// api-vm serves the on-disk build-stamp.json; when it differs from the stamp
// compiled into this bundle, chrome.runtime.reload() re-reads the unpacked dir
// — same as clicking Reload on chrome://extensions. Independent of the
// `autonomous` flag (a fresh build should land even on manually-operated
// setups). Never during a run; one attempt per served stamp so a stale disk
// copy (e.g. the laptop's unsynced dir) can't reload-loop every 5 minutes.
async function checkSelfReload(): Promise<void> {
  const cfg = await getConfig();
  if (!cfg) return;
  const api = new ActuatorApi(cfg);
  const served = await api.fetchExtensionBuild().catch(() => null); // fetch fail → null → no reload
  // Load run state AFTER the network round-trip: checkAutonomy runs concurrently
  // in the same alarm tick, and a run it auto-started DURING this fetch must be
  // seen as active — reloading then would wipe the run's just-saved session state
  // while the once-daily auto-start guard is already consumed (no run that day).
  const s = await loadState();
  const store = await chrome.storage.local.get([RELOAD_STAMP_KEY, DRAIN_INTENT_KEY]);
  // A persistent drain (Drain / Full automatic / auto-drain) never ends, so
  // `runActive` alone would block self-updates forever. Allow the reload only when
  // the run is provably idle — nothing loaded to send, so no reply is interrupted —
  // AND a resume path will bring the drain back: the durable drain intent
  // (checkDrainResume) or lights-out auto-drain. That makes the self-update
  // invisible instead of a silent stop (the bug: reload wiped the run, nothing
  // restarted).
  const quiet = !!s && s.commentPool.length === 0 && s.dmPool.length === 0;
  const willResume =
    parseDrainIntent(store[DRAIN_INTENT_KEY]) !== null || (cfg.autonomous === true && cfg.autoDrain === true);
  const decide = shouldSelfReload({
    runActive: s?.status === "running",
    runResumable: quiet && willResume,
    embeddedStamp: typeof __BUILD_STAMP__ === "string" ? __BUILD_STAMP__ : null,
    servedStamp: served?.stamp ?? null,
    lastAttemptedStamp: (store[RELOAD_STAMP_KEY] as string | undefined) ?? null,
  });
  if (!decide) return;
  await chrome.storage.local.set({ [RELOAD_STAMP_KEY]: served!.stamp });
  console.info("[self-reload] newer build on disk; reloading extension", {
    from: __BUILD_STAMP__,
    to: served!.stamp,
  });
  chrome.runtime.reload();
}

// Fire-and-forget liveness pulse to the Chrome Bridge sink (observability only;
// see docs/chrome-bridge.md). Reads current run state so the heartbeat reports
// running vs idle without any per-transition wiring. `force` bypasses the 60s
// throttle for the 5-min autonomy alarm. Never touches the send path.
async function pulseBridge(force: boolean): Promise<void> {
  const cfg = await getConfig().catch(() => null);
  if (!cfg) return;
  const s = await loadState().catch(() => null);
  const state = s?.status === "running" ? "running" : "idle";
  await bridgePulse(cfg, state, { session_id: s?.sessionId }, force);
}

// ── Remote start/stop of the actuator (the "hands" master switch, 0089) ──────
// The operator's intent lives on agent_instances.actuator_desired_state; the
// extension long-polls it (GET /api/actuator/intent) and reconciles its run
// lifecycle to match, in near-real-time. See docs/actuator-remote-control.md.
//
// REMOTE_STATE_KEY mirrors the applied intent locally so the autonomy gates honor
// it synchronously and it survives SW death; 'stopped' hard-gates all autonomy,
// 'running' is the persistent drain, absent = no remote override.
const REMOTE_STATE_KEY = "actuator.remoteState";
// The commandAt (epoch-ms) of the last remote intent this extension applied, so
// the long-poll blocks until a genuine change (kept for observability/debug; the
// live loop tracks `since` in memory and forces a fresh reconcile on cold start).
const LAST_COMMAND_AT_KEY = "actuator.remoteCommandAt";

// The gate the autonomy paths consult. Fail-OPEN on a storage error (return
// false): the real stop enforcement is the cleared DRAIN_INTENT_KEY + STOP stamps
// applyRemoteIntent writes at stop time (which don't depend on this read), so a
// transient storage blip must not halt a normally-running actuator.
async function remoteStopped(): Promise<boolean> {
  try {
    const s = await chrome.storage.local.get(REMOTE_STATE_KEY);
    return s[REMOTE_STATE_KEY] === "stopped";
  } catch {
    return false;
  }
}

// Reconcile the LIVE run to the operator's remote intent. Idempotent — safe to
// call on every long-poll return and after any SW restart. The GATE
// (REMOTE_STATE_KEY) is level-triggered (always re-asserted); the STOP *action*
// (endRun) is EDGE-triggered — it fires only on the transition INTO 'stopped', so
// a re-apply never kills a one-shot manual Run the operator started afterward.
//   'stopped' → clear the standing drain intent, stamp today's STOP (so a
//               lights-out `autonomous` config can't relaunch it, matching a local
//               STOP), and end any live run: the hands go down and stay down.
//   'running' → set the standing drain intent with the overnight curfew (remote
//               "running" is the leave-it-running Full-auto mode; clears a same-day
//               STOP) and let checkDrainResume resume the drain BEHIND the existing
//               health + challenge-cooldown + curfew safety gates. On X this arms
//               NOTHING to send — reply_send stays the operator's separate consent.
//   null      → no remote override: clear the mirror; local autonomy governs.
async function applyRemoteIntent(desired: "running" | "stopped" | null): Promise<void> {
  const cfg = await getConfig();
  if (!cfg) return;
  const prevStore = await chrome.storage.local.get(REMOTE_STATE_KEY).catch(() => ({}));
  const prev = (prevStore as Record<string, unknown>)[REMOTE_STATE_KEY];

  if (desired === "stopped") {
    await chrome.storage.local.set({ [REMOTE_STATE_KEY]: "stopped" });
    await chrome.storage.local.remove([DRAIN_INTENT_KEY, DISCOVERY_MODE_KEY]);
    await chrome.storage.local.set({
      [AUTO_START_DAY_KEY]: localDayKey(new Date()),
      [STOP_DAY_KEY]: localDayKey(new Date()),
    });
    if (prev !== "stopped") {
      const s = await loadState().catch(() => null);
      if (s?.status === "running") await endRun("stopped").catch(() => {});
    }
  } else if (desired === "running") {
    await chrome.storage.local.set({ [REMOTE_STATE_KEY]: "running" });
    await chrome.storage.local.remove(STOP_DAY_KEY); // a remote start clears a prior same-day STOP
    // Preserve the operator's curfew choice when a drain intent already exists (a
    // local Drain click = curfew off, Full-auto = on), so re-applying a published
    // 'running' never flips a Drain to curfew-on. A phone-initiated start with no
    // local intent defaults to curfew ON (unattended → don't reply overnight).
    const existing = parseDrainIntent((await chrome.storage.local.get(DRAIN_INTENT_KEY))[DRAIN_INTENT_KEY]);
    // Carry `notifications` through too: a phone/dashboard "start" re-applied
    // over an Auto-notifications intent must resume the SWEEP, not silently
    // downgrade it to a plain drain.
    await chrome.storage.local.set({
      [DRAIN_INTENT_KEY]: { curfew: existing?.curfew ?? true, notifications: existing?.notifications === true },
    });
    await checkDrainResume(); // resumes the drain behind the health/challenge/curfew gate
  } else {
    await chrome.storage.local.remove(REMOTE_STATE_KEY);
  }

  // Ack the actuator's ACTUAL run state so the dashboard shows reality, not just
  // intent. Best-effort — a telemetry failure must never break the loop.
  const after = await loadState().catch(() => null);
  const runState: "running" | "idle" = after?.status === "running" ? "running" : "idle";
  await new ActuatorApi(cfg).ackIntent(runState).catch(() => {});
}

// Singleton guard for the intent loop (in-memory; resets on SW death, so
// ensureIntentLoop re-arms it after any restart — driven by onStartup and the 30s
// tick alarm). At most one loop runs per service-worker lifetime.
let intentLoopRunning = false;
function ensureIntentLoop(): void {
  if (intentLoopRunning) return;
  intentLoopRunning = true;
  void runIntentLoop().finally(() => {
    intentLoopRunning = false;
  });
}

// The near-real-time remote control channel. A cold start forces `since=0` so the
// FIRST poll returns the current standing intent immediately and reconciles (in
// case a SW death/self-reload wiped the run); thereafter `since` tracks the last
// applied commandAt so the poll blocks until a genuine change. Fail-open: a null
// (down api-vm / parse error) backs off ~4s and retries; the 30s alarm re-arms
// this loop if the SW was killed during that gap. The in-flight long-poll keeps
// the MV3 service worker alive between reconciles.
async function runIntentLoop(): Promise<void> {
  let since = 0; // cold-start: force an immediate reconcile of the current intent
  for (;;) {
    const cfg = await getConfig().catch(() => null);
    if (!cfg?.instanceId || !cfg.apiBaseUrl || !cfg.token) {
      await plainSleep(15_000);
      continue;
    }
    const intent = await new ActuatorApi(cfg).fetchIntent(since).catch(() => null);
    if (!intent) {
      await plainSleep(4000);
      continue;
    }
    since = intent.commandAt ?? since;
    await chrome.storage.local.set({ [LAST_COMMAND_AT_KEY]: since }).catch(() => {});
    await applyRemoteIntent(intent.desired).catch((e) =>
      console.warn("[intent] apply failed:", e instanceof Error ? e.message : e),
    );
  }
}

// Publish a LOCAL panel action's intent to the server so the phone/dashboard and
// the local panel never disagree, and mirror it locally so the gate honors it
// immediately (before the loop reads it back). Full-automatic, Drain, and STOP are
// master-switch actions (all persistent now); only the timed one-shot Run stays
// orthogonal and never publishes.
function requireStarted(epoch: number | null): number {
  if (epoch === null) throw new Error("start superseded");
  return epoch;
}
async function prepareDrain(run: PendingStart, intent: { curfew: boolean; notifications?: boolean }): Promise<void> {
  const epoch = requireStarted(await run.epoch);
  if (!(await runIfCurrent(epoch, async () => {
    await chrome.storage.local.set({ [DRAIN_INTENT_KEY]: intent });
    await chrome.storage.local.remove([DISCOVERY_MODE_KEY, STOP_DAY_KEY, REMOTE_STATE_KEY]);
  }))) throw new Error("start superseded");
}
async function publishLocalIntent(desired: "running" | "stopped", epoch: number): Promise<void> {
  const cfg = await getConfig().catch(() => null);
  if (!cfg) return;
  if (!(await runIfCurrent(epoch, () => chrome.storage.local.set({ [REMOTE_STATE_KEY]: desired })).catch(() => false))) return;
  const s = await loadState().catch(() => null);
  const runState: "running" | "idle" = s?.status === "running" ? "running" : "idle";
  if (epoch !== await currentEpoch().catch(() => null)) return;
  await new ActuatorApi(cfg).ackIntent(runState, desired).catch(() => {});
}

chrome.tabs.onCreated.addListener((tab) => { void childTabGuard.onCreated(tab); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url && !isXPageUrl(change.url)) void recoverPinnedTab(tabId);
});

chrome.runtime.onStartup.addListener(() => { void ensureAutonomyAlarm(); void ensureIntentLoop(); void checkDrainResume(); void checkAutonomy(); });
chrome.runtime.onInstalled.addListener(() => { void ensureAutonomyAlarm(); void ensureIntentLoop(); void checkDrainResume(); });

chrome.alarms.onAlarm.addListener((a) => {
  // The 0.5-min ALARM survives a self-reload/SW-death (alarms persist), so it is
  // the fastest place to resume a wiped standing drain — checkDrainResume no-ops
  // when a run is already live, so this never double-starts one.
  if (a.name === ALARM) { void ensureIntentLoop(); void tick(); void checkDrainResume(); void pulseBridge(false); }
  else if (a.name === AUTONOMY_ALARM) { void ensureIntentLoop(); void checkAutonomy(); void checkDrainResume(); void checkSelfReload(); void pulseBridge(true); }
});
chrome.runtime.onMessage.addListener((msg: { cmd: string; params?: never; cap?: unknown; minimum?: unknown }, _s, reply) => {
  (async () => {
    try {
      // No auto-enable of reply_send_enabled on Run/Drain (unlike the LinkedIn
      // actuator): on X that column also arms the x-intern official-API send
      // worker — see the block comment above endRun. The operator enables reply
      // sending from the Vega agent page; with it off these run against an
      // empty queue (likes/ambient only).
      if (msg.cmd === "startRun") {
        const run = reserveStart();
        const epoch = requireStarted(await run.epoch);
        if (!(await runIfCurrent(epoch, () => chrome.storage.local.remove(DISCOVERY_MODE_KEY)))) throw new Error("start superseded");
        requireStarted(await startRun(msg.params!, undefined, run));
        reply({ ok: true });
      }
      else if (msg.cmd === "startDrain" || msg.cmd === "startFullAuto") {
        const run = reserveStart();
        const curfew = msg.cmd === "startFullAuto";
        await prepareDrain(run, { curfew });
        const epoch = requireStarted(await startDrain({ manual: true, curfew }, run));
        void publishLocalIntent("running", epoch);
        reply({ ok: true });
      }
      else if (msg.cmd === "startDiscovery") {
        const expectedEpoch = await currentEpoch();
        if (!(await getConfig())) throw new Error("not configured");
        const current = await loadState();
        const decision = discoveryStartDecision(current, ticking);
        if (decision === "blocked") throw new Error("X challenge is active; discovery remains stopped");
        if (!(await runIfCurrent(expectedEpoch, async () => {
          await chrome.storage.local.set({ [DISCOVERY_MODE_KEY]: true, [DRAIN_INTENT_KEY]: { curfew: false } });
          await chrome.storage.local.remove([STOP_DAY_KEY, REMOTE_STATE_KEY]);
          await chrome.storage.session.remove("actuator.lastDryXDiscoveryMs").catch(() => {});
        }))) throw new Error("start superseded");
        let epoch = expectedEpoch;
        if (decision === "defer") discoveryDrainAfterTick = expectedEpoch;
        else if (decision === "start") epoch = requireStarted(await startDrain({ manual: true, curfew: false, expectedEpoch }));
        void publishLocalIntent("running", epoch);
        reply({ ok: true });
      }
      // Auto notifications: an unattended drain WITH the notifications sweep on.
      // It has to be a drain, not a sweep-only mode — a sweep-only run would
      // harvest replies-to-us, hand them to Vega, and then never post the
      // drafts, because the thing that posts approvals is the drain it would
      // have superseded. One click therefore runs the whole conversation loop.
      else if (msg.cmd === "startNotifications") {
        // Kill switch. Refuse even when invoked directly (an old content script
        // still holding the button, a stale message, a console call) — the
        // panel hiding the button is cosmetic, this is the actual gate.
        if (!NOTIFICATIONS_ACTOR_ENABLED) {
          reply({ ok: false, error: "notifications actor is disabled in code (lib/notifications-feature.ts)" });
          return;
