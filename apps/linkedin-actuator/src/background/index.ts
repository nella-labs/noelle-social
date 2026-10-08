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
        !(await remoteStopped()) && await browserDiscoveryEnabled();
      const recovered = await recoverReceiverWithBuildHandoff({
        isCurrent,
        checkNewBuild: async () => {
          try { return await checkSelfReload({ receiverSlotIsCurrent: isCurrent }); }
          catch (error) {
            sinkLog("warn", "browser receiver build check failed", { instanceId, error: discoveryError(error) });
            return false;
          }
        },
        recoverPage: () => recoverMissingDiscoveryReceiver({
          tabId: id,
          buildStamp: typeof __BUILD_STAMP__ === "string" ? __BUILD_STAMP__ : "unknown",
          now: Date.now,
          isCurrent,
          waitForLoad: async () => { await waitTabComplete(id); await sleep(500); },
          onSkip: (reason) => sinkLog("warn", "browser receiver recovery skipped", { instanceId, reason }),
        }),
      });
      if (recovered) sinkLog("info", "browser receiver recovery started", { instanceId, tabId: id });
      return recovered;
    },
    onVisible: (items) => { visibleFingerprints = [...new Set(items.map((item) => item.fingerprint))]; },
    submit: (items) => api.postObservations(items),
    report: reportBrowserDiscovery,
  });
  if (deferredOnly || !status || (status.result === "failed" && status.accepted === 0) || stopped() || !(await browserDiscoveryEnabled())) return;
  // The classifier wakes on the observation notification. Hold the same card
  // briefly for its Jev verdict, then resolve only a qualified card's link.
  // These are API reads, not extra LinkedIn navigation or browser requests.
  const attempted = new Set<string>();
  // Jev classifies a bounded batch one card at a time. Poll only the backend
  // while those cards are processing; the page stays in this existing read slot.
  const maxPolls = status.accepted > 0 ? 20 : 1;
  for (let attempt = 0; attempt < maxPolls; attempt++) {
    try {
      const result = await resolveQualifiedVisiblePost(tabId, api, rng, visibleFingerprints, attempted, s);
      if (result !== "classifying") break;
    } catch (error) {
      await reportBrowserDiscovery({
        at: new Date().toISOString(), instanceId, result: "failed", stage: "identity",
        observed: status.observed, accepted: status.accepted,
        duplicates: status.duplicates, invalid: status.invalid, error: discoveryError(error),
      });
      break;
    }
    if (attempt < maxPolls - 1 && !stopped()) await sleep(500);
  }
}

async function ambientBrowse(
  s: RunState,
  cfg: ActuatorConfig,
  tabId: number,
  rng: ReturnType<typeof makeRng>,
  now: number,
): Promise<void> {
  const api = new ActuatorApi(cfg);
  const canary = await browserDiscoveryEnabled();
  const gate = await withDiscoveryBrowseGate({
    enabled: canary, lastReadMs: s.lastDiscoveryReadMs ?? 0, nowMs: now,
    capacity: async () => (await api.fetchDiscoveryCapacity()).available,
    stillCurrent: async () => !stopped() && s.epoch === (await currentEpoch()),
    onCapacityError: async (error) => reportBrowserDiscovery({
        at: new Date(now).toISOString(), instanceId: cfg.instanceId,
        result: "failed", stage: "capacity", observed: 0, accepted: 0, duplicates: 0, invalid: 0,
        error: discoveryError(error),
    }),
    browse: async (available) => {
      if (available !== null && hasDeferredCanonicalObservations(s.deferredObservations)) {
        await observeVisiblePosts(tabId, api, cfg.instanceId, rng, s, available, true);
        return;
      }
      // Re-assert the feed only for a browse that the capacity gate permits.
      await ensureOnFeed(tabId, rng);
      if (stopped() || s.epoch !== (await currentEpoch())) return;
      const readEnabled = cfg.ambientReadActions !== false; // undefined ⇒ ON
      const sinceRead = now - (s.lastAmbientReadMs ?? 0);
      const readActionsAllowed = readEnabled && sinceRead > AMBIENT_READ_MIN_GAP_MS * rng.float(1, 2.6);
      const kind = chooseAmbient(rng, { readActionsAllowed });
      let discovery: Awaited<ReturnType<ActuatorApi["fetchDiscoveryTarget"]>> = null;
      if (available !== null && kind === "navigate") {
        try {
          discovery = await api.fetchDiscoveryTarget();
        } catch (error) {
          await reportBrowserDiscovery({
            at: new Date(now).toISOString(), instanceId: cfg.instanceId,
            result: "failed", stage: "target", observed: 0, accepted: 0, duplicates: 0, invalid: 0,
            error: discoveryError(error),
          });
        }
      }
      let readDiscoveryPage = false;
      const did = await runAmbient(tabId, kind, {
        cdp, rng, sleep, send, wpm: s.persona.wpm,
        navigate: (id, url) => navigateTab(id, url, rng, async () => !stopped() && (!discovery || await browserDiscoveryEnabled())),
        ...(discovery ? { navigationTarget: discovery.url, onPageRead: async (id: number) => {
          readDiscoveryPage = true;
          await observeVisiblePosts(id, api, cfg.instanceId, rng, s, available!);
        } } : {}),
      }).catch(() => null);
      if (available !== null && !readDiscoveryPage) await observeVisiblePosts(tabId, api, cfg.instanceId, rng, s, available);
      if (did === "expand" || did === "comments") s.lastAmbientReadMs = now;
    },
  });
  if (gate.checked) s.lastDiscoveryReadMs = now; // pace full and failed checks too
}

// Deliver a reaction to the Like button at `likeRect`, WITH VARIETY: most often
// a plain Like, but per the weighted mix (cfg.reactionWeights, default inclined
// to Like → Support → applause/Celebrate) sometimes another reaction. For a
// non-Like pick we hover the Like button to reveal LinkedIn's six-reaction
// flyout, give it a beat to appear, then click the chosen reaction. If the
// flyout never opens or the reaction can't be located, we fall back to a plain
// Like on the still-hovered button — so a react attempt never costs us the like.
// Returns the reaction actually landed (LIKE on the fallback path).
async function reactWithVariety(
  tabId: number,
  likeRect: Rect,
  cfg: ActuatorConfig,
  rng: ReturnType<typeof makeRng>,
): Promise<ReactionType> {
  const type = pickReaction(rng, cfg.reactionWeights);
  if (type === "LIKE") {
    await cdp.moveAndClick(tabId, likeRect, rng, sleep);
    return "LIKE";
  }
  await cdp.hover(tabId, likeRect, rng, sleep); // reveal the reaction flyout
  await sleep(rng.float(220, 520)); // let it finish opening before we locate
  const r = await send<{ ok: boolean; x?: number; y?: number; rect?: Rect }>(
    tabId, { cmd: "locateReaction", reaction: type },
  ).catch(() => null);
  if (r?.ok && r.x != null) {
    await cdp.moveAndClick(tabId, rectFrom(r), rng, sleep);
    return type;
  }
  await cdp.moveAndClick(tabId, likeRect, rng, sleep); // fallback: plain like
  return "LIKE";
}

// Like one hydrated feed post as a human would: make sure we're on the feed,
// scroll-and-poll until a likeable post attaches, read it (dwelling proportional
// to its length, sometimes expanding "…more" first), then land a trusted click.
// Returns true iff a like was actually landed; increments s.done.likes and pushes
// the activity event on success, or a skip event on a miss. Shared by the
// scheduled 'like' slot and idle-liking so both behave identically.
async function likeAFeedPost(
  tabId: number,
  s: RunState,
  cfg: ActuatorConfig,
  rng: ReturnType<typeof makeRng>,
  events: LinkedInActivityEvent[],
  at: string,
): Promise<boolean> {
  // A standalone feed-like must run ON the feed. After a comment (non-drain mode)
  // the tab is left on a post permalink, where findFeedPosts finds no feed cards →
  // every like skipped `no-likeable-post(posts=0)`. Pull it back first (shared
  // guard, also used by the ambient browse). Best-effort — a failed nav just
  // falls through to the scan.
  await ensureOnFeed(tabId, rng);
  // Scroll-and-poll: the like button only attaches once a post is hydrated near
  // the viewport, so one blind scroll + immediate locate often finds nothing
  // likeable. Retry with small scrolls + waits to let posts hydrate.
  type LikeLoc = {
    ok: boolean; x?: number; y?: number; rect?: Rect;
    observed?: {
      activity_urn?: string; author_name?: string;
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
    // Read the post like a human BEFORE reacting: dwell proportional to its
    // length, and sometimes expand "…more" then read the fuller text.
    let wc = loc.observed?.wordCount ?? 0;
    const media = loc.observed?.hasMedia ?? false;
    const trunc = loc.observed?.isTruncated ?? false;
    const seeMoreRect = loc.observed?.seeMoreRect;
    const stop = decideStop(rng, wc, { hasMedia: media });
    if (stop && trunc && seeMoreRect && rng.next() < 0.7) {
      // expand-then-read: itself a strong human decoy action
      await cdp.moveAndClick(tabId, seeMoreRect, rng, sleep);
      await sleep(rng.float(300, 1100));
      wc = Math.round(wc * 2.2); // fuller text now visible → longer read
    }
    await sleep(stop ? readingDwellMs(rng, wc, { hasMedia: media }, s.persona.wpm) : glanceMs(rng));
    throwIfAborted(runAbort.signal); // STOP during the read → don't land the like
    // Re-locate the like button immediately before clicking. The rect captured
    // before the read goes STALE: expanding "…more" grows the post in place, and
    // lazy-loaded media above it shifts it down — so the pre-read coordinates now
    // land in the post BODY (an @mention → a profile, an external link → a new
    // tab), which navigates the tab off the feed AND misses the like. Clicking a
    // freshly-measured rect is what keeps the actuator on the feed. Fall back to
    // the pre-read rect only if the re-locate misses.
    let clickLoc: LikeLoc = loc;
    const fresh = await send<LikeLoc>(tabId, { cmd: "locateLike", preferWatchlist, watchlistNames: [] }).catch(() => null);
    if (fresh?.ok && fresh.x != null && fresh.y != null) clickLoc = fresh;
    throwIfAborted(runAbort.signal); // STOP during the re-locate → don't land the like
    const reaction = await reactWithVariety(tabId, rectFrom(clickLoc), cfg, rng);
    s.done.likes++;
    events.push({ type: "like", activity_urn: clickLoc.observed?.activity_urn, author_name: clickLoc.observed?.author_name, reaction, at });
    return true;
  }
  events.push({ type: "skip", reason: loc?.skipReason ?? "like-failed", at });
  return false;
}

// Serialize ticks so the content-script-driven loop can't overlap with the
// alarm-driven one (overlap would double-read/write state).
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await restoreRunAfterWorkerRestart();
    if (stopped()) return;
    await tickOnce();
  } finally {
    ticking = false;
    if (priorityRetryAfterTick) {
      priorityRetryAfterTick = false;
      setTimeout(() => void tick(), 0);
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

  // Reuse the run's pinned tab while it is still open; only re-pick (preferring a
  // feed tab) if it was closed. This stops the loop from silently following
  // whichever linkedin tab sorts first onto a profile — the core of the hijack.
  const tabId = await findLinkedInTab(s.tabId);
  if (tabId == null) return; // no tab → pause; resume next tick
  if (s.tabId !== tabId) s.tabId = tabId; // pin (or re-pin after the old tab closed)
  await cdp.attach(tabId).catch(() => {}); // idempotent-ish; re-attach if a detach happened

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

  const wake = pendingPriority;
  if (wake) {
    pendingPriority = null;
    if (wake.epoch === myEpoch && wake.instanceId === cfg.instanceId && await browserDiscoveryEnabled()) {
      integratePriorityReady(s, wake.comments, now, rng);
    }
  }

  const idx = dueActionIndex(s.actions, now);
  if (idx < 0) {
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
      await maybeExtendDrain(s, api, now, rng);
    }

    // Nothing due. While it waits, the actor stays lively with ambient browsing
    // (scroll / expand "…more" / read a thread). Likes are NOT part of the wait
    // in drain mode — the gap's planned like slots are the only likes there
    // (2026-07-23: the idle top-up shared the plan's budget and raced ahead of
    // it, stacking ~10 likes before a reply; the operator prefers a visibly
    // idle wait). Run/auto mode still slips a rare like toward its budget,
    // paced in minutes, not seconds.
    const idleLike = shouldIdleLike({
      doneLikes: s.done.likes,
      targetLikes: s.targets.likes,
      inCurfew: isWriteCurfew(now),
      sinceLastIdleLikeMs: now - (s.lastIdleLikeMs ?? 0),
      minGapMs: IDLE_LIKE_MIN_GAP_MS * rng.float(1, 1.8),
      inDrain: s.mode === "drain",
    });
    // The notifications sweep rides the idle branch: a run flagged
    // `notifications` spends one of its waits, every ~10-20 min, reading the
    // notifications page instead of ambient-browsing. Checking notifications IS
    // ambient behavior, so this costs no extra behavioral surface — and the
    // leads it files come back as approvals that THIS run then comments.
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
    if (activity === "quiet") {
      const store: Record<string, unknown> = await chrome.storage.session.get(DRY_DISCOVERY_KEY).catch(() => ({}));
      const lastRead = Number(store[DRY_DISCOVERY_KEY] ?? 0);
      if (now - lastRead >= DRY_DISCOVERY_POLL_MS && !stopped() && await browserDiscoveryEnabled()) {
        await chrome.storage.session.set({ [DRY_DISCOVERY_KEY]: now }).catch(() => {});
        await ambientBrowse(s, cfg, tabId, rng, now);
        s.lastEvent = "reading for new posts — no likes while the pipeline is empty";
      } else {
        s.lastEvent = "nothing to send — idle (no likes while the pipeline is empty)";
      }
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
      }).catch((e): SweepOutcome => ({
        fresh: 0, accepted: 0, skipped: 0,
        detail: isAbortError(e) ? "stopped" : `sweep-failed: ${e instanceof Error ? e.message : String(e)}`,
      }));
      // Say WHY a sweep found nothing — "nothing new" covered three different
      // states and made a broken sweep look identical to a quiet one.
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
          } as LinkedInActivityEvent,
        ])
        .catch(() => {});
      s.lastEvent = out.detail
        ? `notifications: ${out.detail}`
        : out.fresh === 0
          ? out.harvested
            ? `notifications: read ${out.harvested} cards, none are new replies to you`
            : "notifications: page rendered NO notification cards — selectors may have drifted"
          : `notifications: ${out.accepted} queued for drafting (${out.skipped} already known)`;
    } else if (activity === "like") {
      s.lastIdleLikeMs = now; // pace off the attempt, not just a hit (the scan is costly)
      const events: LinkedInActivityEvent[] = [];
      const at = new Date(now).toISOString();
      try {
        await likeAFeedPost(tabId, s, cfg, rng, events, at);
      } catch (e) {
        if (!isAbortError(e)) throw e; // STOP mid-like → fall through to the STOP-race guard below
      }
      await api.logActivity(s.sessionId, events).catch(() => {});
    } else {
      // A healthy content receiver never reaches the missing-receiver handoff.
      // Check only at this existing serialized, paced drain browse slot; an
      // in-flight send, timed Run, or queued DM is never interrupted.
      const receiverSlotIsCurrent = async () => {
        if (stopped() || myEpoch !== (await currentEpoch()) || await remoteStopped() ||
            !(await browserDiscoveryEnabled())) return false;
        const probe = await send<{ observed?: { challenge?: boolean } }>(
          tabId, { cmd: "detectChallenge" },
        ).catch(() => null);
        return probe?.observed?.challenge === false;
      };
      const reloaded = await handoffBuildAtHealthyBrowse({
        mode: s.mode, ambientBrowseSlot: true,
        discoveryEnabled: await browserDiscoveryEnabled(),
        lastReadMs: s.lastDiscoveryReadMs ?? 0, nowMs: now,
        receiverHealthy: ch?.observed?.challenge === false,
        isCurrent: receiverSlotIsCurrent,
        checkNewBuild: () => checkSelfReload({ receiverSlotIsCurrent }),
      });
      if (reloaded) return;
      await ambientBrowse(s, cfg, tabId, rng, now);
    }
    // STOP race: a stop/halt may have landed during the (now longer) idle
    // like/ambient read — don't resurrect the run by writing "running" back over it.
    const cur = await loadState();
    if (cur && cur.status !== "running") return;
    const nextAt = Math.min(...s.actions.filter((a) => !a.executed).map((a) => a.atMs));
    const inSec = Number.isFinite(nextAt) ? Math.max(0, Math.round((nextAt - now) / 1000)) : 0;
    // A sweep already wrote its own outcome line — don't clobber it with the
    // generic idle text, or the panel would never show what the sweep found.
    if (activity !== "sweep") {
      s.lastEvent = activity === "like" ? `liked while waiting — next action in ~${inSec}s` : `browsing — next action in ~${inSec}s`;
    }
    await saveIfCurrent(s);
    return;
  }

  const action = s.actions[idx]!;
  const events: LinkedInActivityEvent[] = [];
  const at = new Date(now).toISOString();
  const windowEndMs = s.startMs + s.windowHours * 3600_000;
  const isWrite = action.kind === "like" || action.kind === "comment" || action.kind === "dm";

  // Discovery has its own optional local quiet window. When it is enabled it
  // overrides the run's legacy Auto curfew, including a run already in flight.
  // Likes and browsing continue while comments/DMs wait for the next slot.
  const isPost = action.kind === "comment" || action.kind === "dm";
  const writeGate = isPost
    ? await discoveryWriteGate(chrome.storage.local, now, s.curfewEnabled === true)
    : { held: false };
  if (writeGate.held) {
    const d = deferLater(action, now, windowEndMs, rng);
    action.atMs = d.atMs;
    events.push({ type: "skip", reason: "curfew", at });
    s.lastEvent = writeGate.message ?? "comments/DMs paused";
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
    } else if (action.kind === "comment" || action.kind === "dm") {
      const pool = action.kind === "comment" ? s.commentPool : s.dmPool;
      const item = pool.shift();
      if (!item) {
        // supply-aware: defer this slot later in the window, do NOT execute
        const d = deferLater(action, now, s.startMs + s.windowHours * 3600_000, rng);
        action.atMs = d.atMs;
        events.push({ type: "skip", reason: `${action.kind}-awaiting-supply`, at });
      } else if (action.kind === "comment" && postDedupKey(item.url) && (s.actionedUrls ?? []).includes(postDedupKey(item.url)!)) {
        // Per-post guard: already commented on this post this session. Lyra can
        // queue >1 draft for one post; two comments on a single post reads as
        // spam. Keyed on the activity URN (postDedupKey) so two drafts whose URLs
        // differ only cosmetically still collapse. The server's persistent
        // dedup-by-link (migration 0084) covers the cross-session case; this is
        // the fast in-run guard. Drop the extra draft (mark done) not post it.
        s.doneDraftIds.push(item.draftId);
        action.executed = true;
        events.push({ type: "skip", reason: "duplicate-post", at });
      } else if (!(await isApprovalStillActionable(api, action.kind, item.approvalId)) || stopped() || myEpoch !== (await currentEpoch())) {
        // A missing queue item may be behind a temporary send gate OR already
        // decided elsewhere. Check its tenant-scoped approval state before
        // restoring it, and never mutate a superseded run after the awaits.
        if (stopped() || myEpoch !== (await currentEpoch())) return;
        const withheld = await classifyWithheldApproval(api, item.approvalId);
        if (stopped() || myEpoch !== (await currentEpoch())) return;
        if (withheld.kind === "drop") {
          if (withheld.terminal) s.doneDraftIds.push(item.draftId);
          action.executed = true;
          events.push({ type: "skip", reason: `${action.kind}-approval-${withheld.reason}`, at });
        } else if (restoreWithheldItem(pool, item, true)) {
          action.atMs = deferLater(action, now, s.startMs + s.windowHours * 3600_000, rng).atMs;
          events.push({ type: "skip", reason: `${action.kind}-server-withheld`, at });
        } else {
          // A still-pending approval can also be omitted permanently by a
          // verifier or dedup filter. Stop local retries; queue polling can
          // load it again if the server later serves it.
          action.executed = true;
          events.push({ type: "skip", reason: `${action.kind}-server-withheld-dropped`, at });
        }
      } else {
        const res = action.kind === "comment"
          ? await doComment(tabId, item, rng, s.persona.wpm, () => claimCommentForSend(api, item.approvalId))
          : await doDm(tabId, item, rng, s.persona.wpm);
        if (res.kind === "claim-unavailable") {
          pool.unshift(item);
          action.atMs = deferLater(action, now, s.startMs + s.windowHours * 3600_000, rng).atMs;
          events.push({ type: "skip", reason: "comment-claim-unavailable", at });
        } else if (res.kind === "claim-denied") {
          s.doneDraftIds.push(item.draftId);
          action.executed = true;
          events.push({ type: "skip", reason: "comment-already-claimed", at });
        } else if (res.kind === "unavailable") {
          // Permanent: the target can never be commented on from this account —
          // either the post is gone ("This post cannot be displayed") or comments
          // are restricted to connections ("Only connections can comment on this
          // post"). Either way no composer will ever render. DROP the draft (mark
          // done locally) so it isn't re-served this session — the old path
          // unshifted it to the front of the pool, so the SAME permalink was
          // retried on every slot, monopolizing the queue and thrashing the tab.
          // Do NOT markSent — nothing was posted. The specific cause rides in
          // res.detail (post-unavailable | comment-restricted) for the skip reason.
          s.doneDraftIds.push(item.draftId);
          action.executed = true;
          const detail = res.detail ?? "post-unavailable";
          const reason = `${action.kind}-${detail}`;
          // Also mark it skipped SERVER-SIDE so the queue stops re-serving this
          // permalink on every FUTURE run. The local drop only lasts the session;
          // the approval otherwise stays 'pending' forever (markSent never fires
          // for a post that can't be commented), so each new run re-navigates to
          // it and drops it again — the "falling here over and over" the operator
          // saw. Best-effort: a failure just means it's re-served next session.
          await api.markSkipped(item.approvalId, reason).catch(() => {});
          events.push({ type: "skip", reason, at });
        } else if (res.kind === "ok") {
          // Record the send LOCALLY *before* the network-fragile markSent, so a
          // transient "Failed to fetch" (e.g. api-vm restart) can't drop the
          // record and cause the draft to be re-served — and re-posted. markSent
          // is then retried best-effort; if it never confirms we still don't
          // re-post (the draft is in doneDraftIds), we just log it for reconcile.
          s.doneDraftIds.push(item.draftId);
          action.executed = true;
          if (action.kind === "comment") {
            s.done.comments++;
            const dk = postDedupKey(item.url);
            if (dk) (s.actionedUrls ??= []).push(dk);
          } else {
            s.done.dms++;
          }
          s.lastProgressMs = now; // a landed post = progress; the stall detector reads this
          const marked = await markSentWithRetry(api, item.approvalId);
          // Stamp the post's activity URN onto the comment activity row. This is
          // the durable dedup-by-link record: it's written at post time (this
          // logActivity call is independent of markSent), so it survives a failed
          // markSent, and the queue (0084) filters future pulls against it so this
          // post is never commented on again.
          const evt: LinkedInActivityEvent = { type: action.kind, at, approval_id: item.approvalId };
          if (action.kind === "comment") {
            const urn = activityUrnFrom(item.url);
            if (urn) evt.activity_urn = urn;
          }
          events.push(evt);
