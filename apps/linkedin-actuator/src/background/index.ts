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
    runAbort = run.controller;
    needsRunRestore = false;
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
  ensurePriorityLoop();
  return state.epoch;
}
function reserveStop(): Promise<number> {
  runAbort.abort();
  return bumpEpoch();
}

async function startRun(
  params: { windowHours: number; targetComments: number; targetLikes: number },
  opts?: { manual?: boolean; curfew?: boolean; expectedEpoch?: number },
  run = reserveStart(opts?.expectedEpoch),
): Promise<number | null> {
  const epoch = await activateStart(run);
  if (epoch === null) return null;
  const cfg = await getConfig();
  if (!cfg) throw new Error("not configured");
  if (!(await startIsCurrent(run, epoch))) return null;
  if (opts?.manual) await withSendSwitch(() => enableSendForManualRun(run, epoch));
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
    deepNightTaper: cfg.deepNightTaper, maxWritesPerHour: cfg.maxWritesPerHour ?? 8, rng,
  });
  const actions: SlotAction[] = planned.map((a) => ({ kind: a.kind, atMs: a.atMs, executed: false }));

  // Pin the actuated tab for the whole run: every tick reuses it while it stays
  // open (tickOnce passes s.tabId to findLinkedInTab), so a profile tab that
  // merely sorts first can't hijack the loop.
  const tabId = await findLinkedInTab();
  const state: RunState = {
    sessionId: crypto.randomUUID(), epoch, startMs, windowHours: params.windowHours, actions,
    persona, warmupSuppressMs, tabId: tabId ?? undefined, curfewEnabled: opts?.curfew === true,
    targets: {
      likes: actions.filter((a) => a.kind === "like").length,
      comments: actions.filter((a) => a.kind === "comment").length,
      dms: actions.filter((a) => a.kind === "dm").length,
    },
    done: { likes: 0, comments: 0, dms: 0 },
    commentPool: queue.comments.map((c) => ({
      approvalId: c.approval_id,
      draftId: c.draft_id,
      body: c.body,
      url: c.target.url,
      // Carried through so doComment knows to THREAD rather than add a
      // top-level comment. api-vm only sets these for notification leads.
      commentUrn: c.target.comment_urn ?? null,
      commentAuthorName: c.target.comment_author_name ?? null,
    })),
    dmPool: queue.dms.map((d) => ({ approvalId: d.approval_id, draftId: d.draft_id, body: d.body, url: d.target.url })),
    doneDraftIds: [], lastPollMs: startMs, status: "running",
  };
  return finishStart(state, run);
}

// Drain mode: post ALL approved replies a short gap apart (default 1–3 min),
// each gap shaped by a randomly drawn pattern — likes scattered/bunched/
// clustered, or a like-free cooldown — plus ambient browsing (see the
// GAP_PATTERNS table in ../lib/scheduler.ts). Reuses the whole tick engine —
// it just builds a drain schedule and flags the run as mode:"drain"
// (which makes each reply return to the feed so the gap browses the feed).
async function startDrain(opts?: { manual?: boolean; curfew?: boolean; notifications?: boolean; expectedEpoch?: number },
  run = reserveStart(opts?.expectedEpoch),
): Promise<number | null> {
  const epoch = await activateStart(run);
  if (epoch === null) return null;
  const cfg = await getConfig();
  if (!cfg) throw new Error("not configured");
  if (!(await startIsCurrent(run, epoch))) return null;
  if (opts?.manual) await withSendSwitch(() => enableSendForManualRun(run, epoch));
  if (!(await startIsCurrent(run, epoch))) return null;
  const api = new ActuatorApi(cfg);
  const queue = await api.fetchQueue();
  if (!(await startIsCurrent(run, epoch))) return null;
  const rng = makeRng((Date.now() & 0xffffffff) >>> 0);
  const startMs = Date.now();
  const persona = makeSessionPersona((Date.now() & 0xffffffff) >>> 0);
  // Per-session drain temperament, drawn from its OWN seed (not the plan rng) so
  // the plan stream is untouched. Persisted on RunState so every auto-continue
  // round shares the same mood (see maybeExtendDrain).
  const drainStyle = pickDrainArchetype(makeRng((Date.now() ^ 0x9e3779b1) >>> 0));

  const nComments = queue.comments.length;
  // drainStyle is exactly the archetype-shaped subset of DrainOpts, so spread it
  // in — one source of truth for which fields the temperament controls.
  const planned = planDrainTimeline({ approvedComments: nComments, startMs, rng, ...drainStyle });
  const actions: SlotAction[] = planned.map((a) => ({ kind: a.kind, atMs: a.atMs, executed: false }));
  const lastAt = actions.reduce((m, a) => Math.max(m, a.atMs), startMs);
  const windowHours = (lastAt - startMs) / 3600_000 + 0.15; // pad so the last slot fits

  const tabId = await findLinkedInTab(); // pin for the run (reused via s.tabId in tickOnce)
  const state: RunState = {
    sessionId: crypto.randomUUID(), epoch, startMs, windowHours, actions,
    persona, drainStyle, warmupSuppressMs: 0, mode: "drain", manualDrain: opts?.manual === true, curfewEnabled: opts?.curfew === true, notifications: opts?.notifications === true, tabId: tabId ?? undefined,
    targets: {
      likes: actions.filter((a) => a.kind === "like").length,
      comments: nComments,
      dms: 0,
    },
    done: { likes: 0, comments: 0, dms: 0 },
    commentPool: queue.comments.map((c) => ({
      approvalId: c.approval_id,
      draftId: c.draft_id,
      body: c.body,
      url: c.target.url,
      // Carried through so doComment knows to THREAD rather than add a
      // top-level comment. api-vm only sets these for notification leads.
      commentUrn: c.target.comment_urn ?? null,
      commentAuthorName: c.target.comment_author_name ?? null,
    })),
    dmPool: [],
    doneDraftIds: [], lastPollMs: startMs, status: "running",
  };
  return finishStart(state, run);
}

// The operator explicitly clicking Run/Drain in the extension IS the consent to
// post, so auto-enable the master reply switch (reply_send_enabled) for this
// instance — approved replies then flow to the queue without the operator ever
// having to flip a dashboard toggle. Called from startRun/startDrain only when
// `opts.manual` (i.e. the manual message handler), never from the unattended
// auto-start path (checkAutonomy calls startRun with no manual flag), so the
// global panic-stop kill switch (which sets reply_send_enabled=false on every
// intern) stays authoritative for lights-out runs. Best-effort: a failure — e.g.
// an older api-vm without this endpoint — is logged, not fatal, so Run still
// proceeds against whatever the flag already is.
async function enableSendForManualRun(run: PendingStart, epoch: number): Promise<void> {
  const cfg = await getConfig();
  if (!cfg || !(await startIsCurrent(run, epoch))) return;
  try {
    await new ActuatorApi(cfg).enableSend(cfg.instanceId, true);
  } catch (e) {
    console.warn("[actuator] could not auto-enable sending:", e instanceof Error ? e.message : e);
  }
}

async function endRun(status: RunState["status"], terminal = reserveStop()): Promise<number> {
  const term = await terminal;
  // Abort immediately when STOP is reserved, then recheck the owned controller
  // after the epoch write: a start may have activated while that write waited.
  if (!(await runIfCurrent(term, async () => {
    runAbort.abort();
    pendingPriority = null;
    needsRunRestore = false;
    if (status === "halted-challenge") {
      await chrome.storage.local.set({ [CHALLENGE_DAY_KEY]: localDayKey(new Date()) });
    }
  }))) return term;
  const s = await loadState();
  if (s) {
    s.status = status;
    s.epoch = term;
    if (!(await saveIfCurrent(s))) return term;
    // Detach EVERY tab this run attached (a re-pin after the pinned tab closed
    // attaches more than one, and the re-pin may not be persisted yet), so no
    // debugger session — or its banner — lingers after the run halts.
    if (term === await currentEpoch()) await cdp.detachAll();
  }
  const cfg = await getConfig();
  if (cfg) {
    const api = new ActuatorApi(cfg);
    // A manual start can enable sending before it has saved its first state.
    // Serialize consent writes separately from storage; a newer run owns its flag.
    await withSendSwitch(async () => {
      if (tickIsCurrent(term, await currentEpoch())) {
        await api.enableSend(cfg.instanceId, false).catch(() => {});
      }
    });
    if (s) {
      const events: LinkedInActivityEvent[] = [];
      const at = new Date(Date.now()).toISOString();
      for (const k of ["comments", "dms"] as const) {
        const miss = shortfall(s.targets[k], s.done[k]);
        if (miss > 0) events.push({ type: "skip", reason: `shortfall-${k}-${miss}`, at });
      }
      if (events.length) await api.logActivity(s.sessionId, events).catch(() => {});
    }
  }
  await runIfCurrent(term, async () => { await chrome.alarms.clear(ALARM); });
  return term;
}

// Drain auto-continue. A drain plans a FIXED number of comment slots (the queue
// size at start), so it used to STOP after that first batch even when the inbox
// still held approvals — the ones capped at start, that arrived mid-run, or that
// were re-queued after a transient failure ("the actuator stopped before
// finishing the approvals inbox"). When every planned slot is done, re-fetch the
// queue and, if pending comments remain, APPEND a fresh batch of comment+like
// slots and extend the window — so one operator Drain clears the WHOLE inbox
// without a manual re-trigger. Returns true iff it extended (caller keeps the run
// running). Bounded by MAX_DRAIN_ROUNDS. Naturally self-limiting: an empty queue
// (nothing left, or sending disabled server-side) returns false → the drain ends;
// posts that keep failing hit the per-draft retry cap → doneDraftIds → filtered
// out of the next fetch → remaining reaches 0.
async function maybeExtendDrain(
  s: RunState, api: ActuatorApi, now: number, rng: ReturnType<typeof makeRng>,
): Promise<boolean> {
  if (s.mode !== "drain") return false;
  const q = await api.fetchQueue().catch(() => null);
  if (!q) return false;
  const done = new Set(s.doneDraftIds);
  s.commentPool = mergePool(
    s.commentPool,
    q.comments.map((c) => ({
      approvalId: c.approval_id,
      draftId: c.draft_id,
      body: c.body,
      url: c.target.url,
      // Carried through so doComment knows to THREAD rather than add a
      // top-level comment. api-vm only sets these for notification leads.
      commentUrn: c.target.comment_urn ?? null,
      commentAuthorName: c.target.comment_author_name ?? null,
    })),
    done,
  );
  s.lastPollMs = now; // this fetch counts as a poll; don't double-fetch next tick
  const remaining = s.commentPool.length;
  if (!shouldExtendDrain(s.mode, s.drainRounds ?? 0, remaining)) return false;

  // Plan a fresh drain batch for the remaining comments, starting shortly from
  // now, and splice it onto the timeline. The existing comment-slot executor
  // shifts these off s.commentPool exactly as it did the first batch. Carries the
  // SAME persisted session temperament so every round keeps one coherent mood
  // (old states without drainStyle fall back to today's defaults via `?? {}`).
  const planned = planDrainTimeline({ approvedComments: remaining, startMs: now, rng, ...(s.drainStyle ?? {}) });
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
  s.commentPool = mergePool(s.commentPool, q.comments.map((c) => ({
      approvalId: c.approval_id,
      draftId: c.draft_id,
      body: c.body,
      url: c.target.url,
      // Carried through so doComment knows to THREAD rather than add a
      // top-level comment. api-vm only sets these for notification leads.
      commentUrn: c.target.comment_urn ?? null,
      commentAuthorName: c.target.comment_author_name ?? null,
    })), done);
  s.dmPool = mergePool(s.dmPool, q.dms.map((d) => ({ approvalId: d.approval_id, draftId: d.draft_id, body: d.body, url: d.target.url })), done);
}

// Ambient read-actions (expand "…more" / open a post's comments to read) are
// paced by a rolling cooldown so they cluster like real reading instead of
// firing on every ~4s idle tick. Base gap × a 1–2 jitter ⇒ roughly one every
// 20–40s at most; many attempts also find nothing in view and downgrade to a
// scroll, so the real rate is lower. Read-only + non-counted against targets.
// Tightened (was 30s×1–2.5) so the actor actively clicks "…more" while waiting.
const AMBIENT_READ_MIN_GAP_MS = 20_000;

// Minimum spacing between idle-likes (a like slipped into the wait between
// scheduled actions — Run/auto mode only; drain never idle-likes, see the
// shouldIdleLike inDrain gate). 2026-07-23 quiet re-tune: raised 45s → 5 min
// (×1-1.8 jitter ⇒ one like per ~5-9 min of waiting, was ~45-80s) — the
// operator wants waits to look idle, not busy. The filler still tops the
// session toward its like budget, just at a reading pace.
const IDLE_LIKE_MIN_GAP_MS = 300_000;

// One ambient browse: pick a behavior (read-actions gated by cooldown + config
// kill switch, default ON) and run it. Advances the cooldown anchor only on an
// action that actually happened, so a downgraded-to-scroll attempt doesn't burn
// the gap. Mutates `s` in place; the caller persists it.
async function resolveQualifiedVisiblePost(tabId: number, api: ActuatorApi, rng: ReturnType<typeof makeRng>, visibleFingerprints: string[], attempted: Set<string>, s: RunState): Promise<"resolved" | "none" | "classifying" | "not-visible" | "unresolved" | "stopped"> {
  return resolveVisibleDiscoveryIdentity({
    stopped, enabled: browserDiscoveryEnabled,
    visibleFingerprints, attempted, pending: (fingerprints) => api.fetchDiscoveryIdentities(fingerprints),
    locate: (fingerprint) => send(tabId, { cmd: "locateDiscoveryPostMenu", fingerprint }),
    click: async (rect) => { await cdp.attach(tabId); await cdp.moveAndClick(tabId, rect, rng, sleep); },
    wait: () => sleep(350),
    readShareUrn: () => send(tabId, { cmd: "readDiscoveryMenuShareUrn" }),
    captureCopyLink: async () => {
      const isCurrent = async (): Promise<boolean> => {
        if (stopped() || s.status !== "running" || s.epoch !== await currentEpoch() ||
            await remoteStopped() || !(await browserDiscoveryEnabled())) return false;
        const challenge = await send<{ ok?: boolean; observed?: { challenge?: boolean } }>(
          tabId, { cmd: "detectChallenge" },
        ).catch(() => null);
        return challenge?.ok === true && challenge.observed?.challenge === false &&
          !stopped() && s.epoch === await currentEpoch();
      };
      const target = await locateCopyLinkAfterHydration({
        isCurrent,
        locate: () => send(tabId, { cmd: "locateDiscoveryCopyLink" }),
        wait: () => sleep(350),
      });
      if (target.skipReason === "stopped") return { failure: { stage: "stopped" } as const };
      if (!target?.ok || !target.rect) return { failure: {
        stage: "locate" as const,
        ...(target?.skipReason ? { locatorReason: target.skipReason } : {}),
        ...(target?.diagnostic ? { menuDiagnostic: target.diagnostic } : {}),
      } };
      if (!(await isCurrent())) return { failure: { stage: "stopped" } as const };
      let captureFailure: CopyCaptureFailure | undefined;
      const identity = await captureCopyLinkIdentity({
        evaluate: (expression) => cdp.evaluatePage(tabId, expression),
        click: async () => {
          if (!(await isCurrent())) throw new Error("identity capture no longer current");
          await cdp.moveAndClick(tabId, target.rect!, rng, sleep);
        },
        wait: () => sleep(350),
        stopped,
        onFailure: (failure) => { captureFailure = failure; },
      });
      if (!(await isCurrent())) return { failure: { stage: "stopped" } as const };
      return identity ?? { failure: captureFailure ?? { stage: "exception" } };
    },
    closeMenu: () => cdp.pressEscape(tabId),
    resolve: (item, urn) => api.resolveDiscoveryIdentity(item.leadId, item.fingerprint, urn),
    resolveShortLink: (item, shortUrl) => api.resolveDiscoveryShortLink(item.leadId, item.fingerprint, shortUrl),
    report: async ({ result, reason, diagnostic, copy }) => {
      const status = { at: new Date().toISOString(), result,
        ...(reason ? { reason } : {}), ...(diagnostic ? { diagnostic } : {}), ...(copy ? { copy } : {}) };
      await chrome.storage.local.set({ [DISCOVERY_IDENTITY_STATUS_KEY]: status }).catch((error) => {
        sinkLog("warn", "discovery identity telemetry write failed", { error: discoveryError(error) });
      });
      sinkLog(result === "unresolved" ? "warn" : "info", "discovery identity", status);
    },
  });
}

async function observeVisiblePosts(tabId: number, api: ActuatorApi, instanceId: string, rng: ReturnType<typeof makeRng>, s: RunState, available: number, deferredOnly = false): Promise<void> {
  let visibleFingerprints: string[] = [];
  const status = await runBrowserObservation({
    tabId, instanceId, seen: observedUrns, deferred: (s.deferredObservations ??= []), available, deferredOnly,
    stopped, enabled: browserDiscoveryEnabled, now: Date.now, wait: sleep,
    send: (id) => send<{ ok: boolean; items?: VisiblePost[] }>(id, { cmd: "harvestVisiblePosts" }),
    recoverReceiver: async (id) => {
      const isCurrent = async () => !stopped() && s.epoch === (await currentEpoch()) &&
