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
          if (!marked) events.push({ type: "skip", reason: "marksent-unconfirmed", at });
          // Each reply also reacts to the post — a human likes what they engage
          // with, and it gives visible engagement even while standalone feed-likes
          // are flaky. Best-effort + not counted against the like target. But a
          // human doesn't like EVERY post they reply to, and a 100%-consistent
          // reply→like pairing is a tell — so skip the reaction on a small,
          // drifting fraction of replies (~2%, re-rolled in [1%,5%] every 123;
          // see ../lib/like-skip). State persists via saveIfCurrent at tick end.
          if (action.kind === "comment") {
            const { skip: skipLike, next: nextSkip } = rollLikeSkip(s.likeSkip, () => rng.next());
            s.likeSkip = nextSkip;
            if (!skipLike) {
              const rx = await likeCurrentPost(tabId, cfg, rng);
              if (rx) events.push({ type: "like", reaction: rx, at });
            }
          }
          // Drain mode: return to the feed after replying so the gap's scheduled
          // likes + ambient browsing happen on the feed (not the post page).
          if (s.mode === "drain" && action.kind === "comment") {
            await navigateTab(tabId, "https://www.linkedin.com/feed/", rng).catch(() => {});
            await waitTabComplete(tabId);
          }
        } else {
          // Transient failure. Two changes from the old `pool.unshift` (retry at the
          // FRONT, forever): (1) name the failing stage in the skip reason + attach
          // the post's activity URN, so linkedin_activity says WHY and on WHICH post
          // — the current bare `comment-failed` is undiagnosable; (2) cap per-draft
          // retries and re-queue at the BACK, so one post the composer/submit can't
          // handle (or a live action-block) can no longer be retried every slot and
          // starve every other pending draft (the "wall of comment-failed" symptom).
          const { tries, giveUp } = retryDecision(item.tries ?? 0);
          item.tries = tries;
          const stage = res.detail ? `:${res.detail}` : "";
          const skip: LinkedInActivityEvent = {
            type: "skip",
            reason: giveUp
              ? `${action.kind}-failed:gave-up-after-${tries}${stage}`
              : `${action.kind}-failed${stage}`,
            at,
          };
          if (action.kind === "comment") {
            const urn = activityUrnFrom(item.url);
            if (urn) skip.activity_urn = urn;
          }
          if (action.kind === "comment" && res.claimed) {
            // After a submit click or chord, confirmation can be lost. Keep the
            // server claim reserved and never automatically try this post again.
            s.doneDraftIds.push(item.draftId);
            action.executed = true;
            skip.reason = `comment-failed:claim-reserved${stage}`;
          } else if (giveUp) {
            // Drop the draft for this session (mark done locally, do NOT markSent —
            // nothing posted) so it stops monopolizing comment slots. The queue's
            // persistent dedup is unaffected; a later session re-serves it fresh.
            s.doneDraftIds.push(item.draftId);
            action.executed = true;
          } else {
            pool.push(item); // BACK of the queue — let healthy drafts go first
            const d = deferLater(action, now, s.startMs + s.windowHours * 3600_000, rng);
            action.atMs = d.atMs;
          }
          events.push(skip);
        }
      }
    }
  } catch (e) {
    // A STOP that unwound an in-flight action surfaces as AbortError — log it as
    // a clean "stopped" skip, not a scary error string.
    const reason = isAbortError(e) ? "stopped" : `err:${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`;
    events.push({ type: "skip", reason, at });
    // Mirror real errors (not clean stops) to the Chrome Bridge sink so the
    // doctor can see selector drift / attach failures without DevTools open.
    if (!isAbortError(e)) sinkLog("error", "tick action failed", { reason });
  }

  // Surface the outcome to the panel (DevTools can't be open during a run).
  const last = events[events.length - 1];
  if (last) {
    s.lastEvent =
      last.type === "like"
        ? (last.reaction && last.reaction !== "LIKE"
            ? `reacted ${reactionLabel(last.reaction as ReactionType)} to ${last.author_name ?? "a post"} (${s.done.likes}/${s.targets.likes})`
            : `liked ${last.author_name ?? "a post"} (${s.done.likes}/${s.targets.likes})`)
      : last.type === "comment" ? `commented (${s.done.comments}/${s.targets.comments})`
      : last.type === "dm" ? `sent DM (${s.done.dms}/${s.targets.dms})`
      : `skip: ${last.reason ?? "?"}`;
  }

  // Drain auto-continue: before ending a finished drain, try to append another
  // batch for any approvals still in the inbox, so one Drain clears it all.
  if (s.mode === "drain" && s.actions.every((a) => a.executed)) {
    const extended = await maybeExtendDrain(s, api, now, rng); // appends non-executed slots when work remains
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

// markSent, retried with backoff. Returns whether the send was confirmed to the
// server. The caller has ALREADY recorded the draft locally as done, so a false
// return never causes a re-post — it only means the DB approval may still read
// 'pending' until a later tick reconciles.
async function markSentWithRetry(api: ActuatorApi, approvalId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await api.markSent(approvalId);
      return true;
    } catch {
      if (stopped()) return false;
      if (attempt < 3) await sleep(800 * (attempt + 1)); // backoff (abort-aware)
    }
  }
  return false;
}

// Best-effort reaction on the post currently open (doComment just navigated to
// it) — a human likes/reacts to what they engage with. Uses the same weighted
// variety as feed likes. Not counted against the like target. Returns the
// reaction landed, or null if it was skipped (already-liked / no button / STOP).
async function likeCurrentPost(tabId: number, cfg: ActuatorConfig, rng: ReturnType<typeof makeRng>): Promise<ReactionType | null> {
  if (stopped()) return null;
  const loc = await send<{ ok: boolean; x?: number; y?: number; rect?: Rect }>(tabId, { cmd: "locatePostLike" }).catch(() => null);
  if (!loc?.ok || loc.x == null) return null;
  await sleep(rng.float(500, 2200)); // widened dwell (anti-fingerprint, #429)
  if (stopped()) return null;
  return reactWithVariety(tabId, rectFrom(loc), cfg, rng);
}

// Outcome of a comment/DM attempt. "unavailable" means the target post/profile
// no longer exists (a deleted permalink) — a PERMANENT failure the caller must
// drop, not retry. "failed" is transient (slow load, missing selector, submit
// that never landed) → retry. On "failed", `detail` names the exact stage that
// broke ("box-not-found" / "submit-not-found" / "not-cleared" / …) so the DB skip
// row (linkedin_activity.reason = `comment-failed:<detail>`) says WHY without a
// live DevTools session — mirroring the like path's `no-likeable-post(...)`
// diagnostics. This is the difference between "comments broke, unknown why" and a
// row that points straight at the failing component.
type ActionKindResult = "ok" | "unavailable" | "failed" | "claim-unavailable" | "claim-denied";
type ActionResult = { kind: ActionKindResult; detail?: string; claimed?: boolean };
type CommentClaim = "claimed" | "already-claimed" | "unavailable";

// Open the post, locate + type + submit via trusted CDP input.
/**
 * Empty whichever composer still holds text, and confirm it where LinkedIn
 * gives us a read.
 *
 * LinkedIn registers a `beforeunload` handler while a comment, reply or message
 * box holds un-sent text. The actuator's next `chrome.tabs.update` — the return
 * to the feed, or the hop to the next post — then navigates away from that dirty
 * box and Chromium raises "Leave site? Changes you made may not be saved." The
 * dialog blocks the renderer, freezes the content script's tick loop, and wedges
 * the run until a human clicks it. It cannot be answered over CDP either:
 * handling `beforeunload` via Page.handleJavaScriptDialog is broken upstream
 * (puppeteer/puppeteer#9871), so removing the TRIGGER is the only fix.
 *
 * Tries each composer LinkedIn can leave dirty, and BOTH are verified by a read:
 * `readCommentBox` for the comment/reply boxes, `readMessageCompose` for the
 * message compose. Never throws: it runs on paths that already decided the
 * draft's fate.
 *
 * Each pass confirms emptiness itself afterwards rather than trusting
 * runClearComposer's return. That helper reports success when the box cannot be
 * FOCUSED, on the reasonable assumption that an unfocusable box is an absent
 * one — but a composer can also be present, dirty and unfocusable: a minimised
 * messaging bubble measures 0x0, and the locators correctly refuse a zero rect
 * rather than clicking the viewport corner. Trusting the helper there would
 * report "cleared" for a box still holding text and swallow the warning, which
 * is the one outcome that leaves the dialog armed with nobody told.
 */
async function clearComposer(
  tabId: number,
  rng: ReturnType<typeof makeRng>,
  /**
   * The DM body this run typed, when the caller is the DM path. Absent for every
   * other caller, and that default is the important part.
   *
   * The comment/reply box is ours: nothing but this actuator types in it, and
   * its text does not survive a `chrome.tabs.update` anyway, so clearing it on
   * any navigation only ever discards our own un-sent reply a beat before the
   * navigation would have.
   *
   * `.msg-form` is neither. It is the messaging overlay that rides along on
   * every LinkedIn page, the text in it is usually something the operator is
   * writing, and LinkedIn RESTORES message drafts — so the "the navigation
   * would have discarded it anyway" defence does not carry, and clearing it on
   * routine ambient/ensureOnFeed hops would destroy a human's message for good.
   *
   * Passing the body rather than a boolean is what makes the DM path safe too:
   * findMessageCompose returns the FIRST `.msg-form` editable and the messaging
   * rail can hold several open bubbles, so even doDm's own unwind must confirm
   * the box holds OUR draft before wiping it. Without that, a send-not-found or
   * a STOP would erase an unrelated conversation.
   */
  ownDmBody?: string,
  commentUrn?: string,
): Promise<void> {
  // Focus a composer by locate-command. false when that box isn't on the page.
  const focus = async (cmd: string, targetCommentUrn?: string): Promise<boolean> => {
    const loc = await send<{ ok: boolean; x?: number; y?: number; rect?: Rect }>(
      tabId, { cmd, ...(targetCommentUrn ? { commentUrn: targetCommentUrn } : {}) },
    ).catch(() => null);
    if (!loc?.ok || loc.x == null) return false;
    await cdp.moveAndClick(tabId, rectFrom(loc), rng, sleep);
    return true;
  };

  // 1) The comment/reply box — LinkedIn gives us a read, so this one is
  //    verified: focus, clear, poll until the box reports empty.
  await runClearComposer({
    focusBox: () => commentUrn ? focus("locateReplyComposer", commentUrn) : focus("locateCommentBox"),
    clearKeys: () => cdp.clearFocusedEditor(tabId, sleep),
    isEmpty: () => commentPosted(tabId, commentUrn),
    sleep,
  });
  // Confirmed independently, not from the return value — see the header: a
  // present-but-unfocusable box makes runClearComposer report success.
  //
  // The test is POSITIVE ("can we still see our text?"), not `!empty`.
  // commentPosted answers false for an unreadable composer too, so the negated
  // form warns every time the content script is mid-reinject — noise in the one
  // channel the comment-failed diagnostics have to survive in.
  if (await commentBoxHasText(tabId, commentUrn)) {
    sinkLog("warn", "comment box would not clear; next navigation may raise a leave-site dialog", { tabId });
  }

  // 2) The message compose — only for the caller that put the text there, and
  //    only when the box still holds THAT text.
  //
  //    It was a blind focus + clear until the review on #559, on the grounds
  //    that an unverified clear beats a certain stall. readMessageCompose makes
  //    it verified: runClearComposer reads first, so an empty or absent box
  //    costs one round trip with no click and no keystrokes.
  //
  //    But verified is not the same as safe. The box this clears is the
  //    operator's messaging overlay, and a NON-empty one is precisely the case
  //    where clearing destroys something a human typed — see ownDmBody.
  if (ownDmBody === undefined) {
    // Not ours to clear. A dirty overlay is still what would raise the dialog on
    // the next hop, so it is worth saying — but ONCE. LinkedIn restores drafts
    // and the bubble is on every page, so one un-sent operator message would
    // otherwise log on every navigation for the rest of the run and flush the
    // 200-entry sink ring, evicting exactly the comment-failed rows this change
    // exists to make readable. Latched, and re-armed when the overlay goes clean.
    if (await messageComposeHasText(tabId)) {
      if (!warnedOverlayDirty) {
        warnedOverlayDirty = true;
        sinkLog("warn", "message compose holds text (left alone — operator's); a navigation may raise a leave-site dialog", { tabId });
      }
    } else {
      warnedOverlayDirty = false;
    }
    return;
  }
  await runClearComposer({
    focusBox: () => focus("locateMessageCompose"),
    clearKeys: () => cdp.clearFocusedEditor(tabId, sleep),
    // "Nothing for us to do here" covers both an empty box AND a box holding
    // someone else's conversation: the messaging rail can have several bubbles
    // open and findMessageCompose returns the first, so even our own unwind must
    // not wipe a draft it cannot prove it wrote.
    //
    // NOT messageComposeStillHasText: its bias ("unreadable ⇒ not a miss") is
    // right for deciding a send failed and wrong for deciding a box is clean.
    // Inverted here, an unreadable composer would answer "already empty",
    // clear nothing, and — since the confirmation below uses the positive
    // predicate — log no warning either.
    isEmpty: () => messageComposeClearOfOurDraft(tabId, ownDmBody),
    sleep,
  });
  // Same independent confirmation, and this is the box it was written for: the
  // messaging bubble is MINIMISED by default, which is exactly the present +
  // dirty + zero-rect state that makes the helper's return value a lie.
  if (await messageComposeStillHasText(tabId, ownDmBody)) {
    sinkLog("warn", "message compose would not clear; next navigation may raise a leave-site dialog", { tabId });
  }
}

/**
 * Latch for the "operator's overlay is dirty" warning, so one un-sent message
 * cannot log on every navigation for the rest of the run. Re-armed as soon as
 * the overlay reads clean, so a genuinely new dirty episode is still reported.
 */
let warnedOverlayDirty = false;

/** Can we POSITIVELY see text still in the comment composer? Distinct from
 *  `!commentPosted`, which is also true when the box cannot be READ — the state
 *  that would otherwise log a spurious "would not clear" on every reinject. */
async function commentBoxHasText(tabId: number, commentUrn?: string): Promise<boolean> {
  const st = await readCommentState(tabId, commentUrn);
  return st?.ok === true && st.observed?.present === true && st.observed?.empty === false;
}

/**
 * Is the message composer confirmed to be holding nothing OF OURS — either
 * empty/absent, or occupied by a conversation that is not the draft we typed?
 *
 * Biased the opposite way to messageComposeStillHasText, deliberately. This one
 * gates whether the clear runs, so an unreadable composer must answer FALSE
 * ("not confirmed clean") and let the clear proceed; the other one gates whether
 * a send is declared a miss, where an unreadable composer must answer "no
 * evidence of a miss" so the DM is never sent twice. Same read, opposite
 * default, because the costly mistake is opposite.
 */
async function messageComposeClearOfOurDraft(tabId: number, body: string): Promise<boolean> {
  const st = await send<{ ok: boolean; observed?: { present?: boolean; empty?: boolean; text?: string } }>(
    tabId, { cmd: "readMessageCompose" },
  ).catch(() => null);
  if (!st) return false; // unreadable → not confirmed clean → try to clear
  if (st.observed?.present !== true || st.observed?.empty === true) return true;
  return !sameDraft(st.observed.text ?? "", body); // someone else's draft → not ours to touch
}

/** Same positive read for the message composer, ownership aside. */
async function messageComposeHasText(tabId: number): Promise<boolean> {
  const st = await send<{ ok: boolean; observed?: { present?: boolean; empty?: boolean } }>(
    tabId, { cmd: "readMessageCompose" },
  ).catch(() => null);
  return st?.observed?.present === true && st.observed?.empty === false;
}

/** Is the DM composer empty (or absent)? Mirrors commentPosted for the message
 *  box. A read error is "not confirmed", never a false empty. */
async function messageComposeEmpty(tabId: number): Promise<boolean> {
  const st = await send<{ ok: boolean; observed?: { present?: boolean; empty?: boolean } }>(
    tabId, { cmd: "readMessageCompose" },
  ).catch(() => null);
  if (!st) return false;
  return st.observed?.present === false || st.observed?.empty === true;
}

/**
 * Did the DM text POSITIVELY survive in the box? true only when the composer is
 * readable, present, and still holding text.
 *
 * The distinction from `!messageComposeEmpty` is the whole point, and it is not
 * symmetry for its own sake: on this actuator a "failed" DM is re-queued
 * (pool.push) and re-sent from a later slot, so a wrong failure does not lose a
 * message — it sends a SECOND one to a real person. A dropped message port, a
 * suspended service worker, a content script mid-reinject: every one of those
 * makes the read fail, and treating "could not read" as "did not send" would
 * duplicate the DM.
 *
 * So the burden of proof sits on the failure: only text we can actually SEE
 * still sitting there reports a miss. Every ambiguous answer keeps the previous
 * behaviour of assuming the send landed.
 */
async function messageComposeStillHasText(tabId: number, body: string): Promise<boolean> {
  const st = await send<{ ok: boolean; observed?: { present?: boolean; empty?: boolean; text?: string } }>(
    tabId, { cmd: "readMessageCompose" },
  ).catch(() => null);
  if (!st) return false; // unreadable → not proof of a miss
  if (st.observed?.present !== true || st.observed?.empty !== false) return false;
  // It must be OUR text. findMessageCompose returns the FIRST `.msg-form`
  // editable on the page, and LinkedIn's messaging rail can hold several open
  // conversation bubbles — so a DM that actually went out can still find a
  // non-empty box belonging to a different thread the operator is typing in.
  // Reporting that as a miss re-queues the item and sends a SECOND DM to a real
  // person, which is the precise harm this function exists to avoid.
  return sameDraft(st.observed.text ?? "", body);
}


/**
 * Every navigation this actuator makes. Binds the shared clear-then-navigate
 * helper (see makeNavigateTab for why the clear belongs at the navigation and
 * not only on the failure path) to Lyra's composers.
 *
 * Declared as a `function` deliberately: ensureOnFeed calls it hundreds of lines
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
  /**
   * The DM body this run typed, for the hops that follow a DM. Passed through to
   * clearComposer so the return-to-feed hop empties OUR message text before
   * navigating away from it — without it, an assume-sent verdict (or a missed
   * confirmation) leaves the full DM in the box and the hop raises the exact
   * dialog this function exists to prevent. See clearComposer's ownDmBody: the
   * clear still refuses to touch a draft it cannot prove it wrote.
   */
  ownDmBody?: string,
): Promise<void> {
  return makeNavigateTab({
    clearComposer: (id) => clearComposer(id, rng, ownDmBody),
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
 * Wrapper around the real reply/comment flow: whatever happens, a comment that
 * did NOT land must not leave its text in the box (see clearComposer). `finally`
 * rather than a check on the result, so a STOP unwinding mid-flow is covered too.
 */
async function doComment(
  tabId: number, item: PoolItem, rng: ReturnType<typeof makeRng>, wpm: number,
  claim: () => Promise<CommentClaim>,
): Promise<ActionResult> {
  let res: ActionResult | undefined;
  try {
    res = await doCommentInner(tabId, item, rng, wpm, claim);
    return res;
  } finally {
    if (res?.kind !== "ok") await clearComposer(tabId, rng, undefined, item.commentUrn ?? undefined);
  }
}

async function doCommentInner(
  tabId: number, item: PoolItem, rng: ReturnType<typeof makeRng>, wpm: number,
  claim: () => Promise<CommentClaim>,
): Promise<ActionResult> {
  await navigateTab(tabId, item.url, rng);
  await waitTabComplete(tabId);
  // Read the target post like a human before replying — dwell proxied from a
  // ~60-word read at this session's pace (we don't have the post's wc here).
  await sleep(readingDwellMs(rng, Math.max(0, Math.round(rng.normal(60, 40))), {}, wpm));
  // Deleted/unavailable post → the permalink shows "This post cannot be
  // displayed" and will NEVER render a composer. Report it as permanent so the
  // caller drops the draft instead of re-navigating to the dead post every slot.
  const state = await send<{ observed?: { unavailable?: boolean } }>(tabId, { cmd: "detectPostUnavailable" }).catch(() => null);
  if (state?.observed?.unavailable) return { kind: "unavailable", detail: "post-unavailable" };
  // Comments restricted to connections ("Only connections can comment on this
  // post. You can still react or share it.") — shown IN PLACE of the composer, so
  // no comment box ever renders. Permanent for this account: drop it (permanent
  // like unavailable → the caller marks it skipped server-side) instead of the
  // box-not-found retry loop that burned 3 tries then gave up.
  const restricted = await send<{ observed?: { restricted?: boolean } }>(tabId, { cmd: "detectCommentRestricted" }).catch(() => null);
  if (restricted?.observed?.restricted) return { kind: "unavailable", detail: "comment-restricted" };
  // ── THREADED REPLY ───────────────────────────────────────────────────────
  // A notification lead answers a specific person under THEIR comment. This
  // path never touches the post-level composer: posting a conversation reply
  // there is not a reply, it is a second top-level comment from the operator on
  // a thread he already commented on (five of those went live before the dedup
  // was tightened). Every step below FAILS rather than degrading, and the
  // failures are transient so the draft is retried on a later slot instead of
  // being silently published in the wrong place.
  if (item.commentUrn) {
    const urn = item.commentUrn;

    // REACH the comment before looking for it. The first threaded runs all
    // failed on `comment-not-found`, and the locator was never the problem:
    // LinkedIn renders only a handful of comments and hides the rest behind
    // "See 33 more comments", so the one we were sent to answer simply was not
    // in the DOM. Get to it the way a person does — follow the deep link, then
    // expand and scroll until it appears.
    const deep = commentDeepLink(item.url, activityUrnFrom(item.url), urn);
    if (deep !== item.url) {
      await navigateTab(tabId, deep, rng);
      await waitTabComplete(tabId);
      await sleep(rng.float(900, 2000)); // the thread expands + scrolls itself
    }

    let reply = await send<{ ok: boolean; x?: number; y?: number; rect?: Rect; skipReason?: string }>(
      tabId, { cmd: "locateCommentReply", commentUrn: urn },
    );
    // Up to 4 rounds of "expand a bit more, read a bit further". Bounded so a
    // genuinely absent comment costs one slot rather than the whole run.
    for (let i = 0; i < 4 && (!reply.ok || reply.x == null); i++) {
      throwIfAborted(runAbort.signal);
      const more = await send<{ ok: boolean; x?: number; y?: number; rect?: Rect }>(
        tabId, { cmd: "locateLoadMoreComments" },
      ).catch(() => ({ ok: false }) as { ok: boolean; x?: number; y?: number; rect?: Rect });
      if (more.ok && more.x != null) {
        await cdp.moveAndClick(tabId, rectFrom(more), rng, sleep);
        await sleep(rng.float(700, 1600)); // the next page of comments renders
      } else {
        // No expander left: the rest is lazy-rendered, so read further down.
        await cdp.wheel(tabId, { x: 500, y: 420 }, Math.round(rng.float(500, 1100)), rng, sleep);
        await sleep(rng.float(400, 900));
      }
      reply = await send<{ ok: boolean; x?: number; y?: number; rect?: Rect; skipReason?: string }>(
        tabId, { cmd: "locateCommentReply", commentUrn: urn },
      );
    }
    if (!reply.ok || reply.x == null) {
      // Still absent after expanding: deleted, or buried deeper than we will
      // dig. Transient — a later slot retries rather than posting at post level.
      return { kind: "failed", detail: `thread-${reply.skipReason ?? "reply-button-not-found"}` };
    }
    await cdp.moveAndClick(tabId, rectFrom(reply), rng, sleep); // opens ITS reply box
    await sleep(rng.float(500, 1400)); // the box mounts + focuses

    const composer = await send<{ ok: boolean; x?: number; y?: number; rect?: Rect; skipReason?: string }>(
      tabId, { cmd: "locateReplyComposer", commentUrn: urn },
    );
    if (!composer.ok || composer.x == null) {
      return { kind: "failed", detail: `thread-${composer.skipReason ?? "composer-not-found"}` };
    }
    await cdp.moveAndClick(tabId, rectFrom(composer), rng, sleep); // focus it
    throwIfAborted(runAbort.signal); // STOP before we type anything
    await cdp.typeText(tabId, item.body, rng, sleep);
    await sleep(rng.float(400, 2000));
    throwIfAborted(runAbort.signal); // STOP before we publish

    // The submit resolves ONLY inside a real reply box (its label is "Reply";
    // the post composer's is "Comment") and, when we know the name, only when
    // the box's pre-filled mention chip names the person we mean to answer.
    const rsub = await send<{ ok: boolean; x?: number; y?: number; rect?: Rect; skipReason?: string }>(
      tabId,
      {
        cmd: "locateReplySubmit",
        commentUrn: urn,
        ...(item.commentAuthorName ? { expectMention: item.commentAuthorName } : {}),
      },
    );
    if (!rsub.ok || rsub.x == null) {
      return { kind: "failed", detail: `thread-${rsub.skipReason ?? "submit-not-found"}` };
    }
    throwIfAborted(runAbort.signal);
    const reserved = await claim();
    if (reserved !== "claimed") return { kind: reserved === "unavailable" ? "claim-unavailable" : "claim-denied" };
    throwIfAborted(runAbort.signal);
    await cdp.moveAndClick(tabId, rectFrom(rsub), rng, sleep);
    await sleep(rng.float(900, 2200));
    // A dirty or unreadable target is an uncertain dispatched attempt. Keep its
    // claim without reporting a sent reply or sending another submit gesture.
    for (let i = 0; i < 8; i++) {
      if (await commentPosted(tabId, urn)) return { kind: "ok" };
      if (stopped()) break;
      if (i < 7) await sleep(400);
    }
    return { kind: "failed", detail: "thread-not-confirmed", claimed: true };
  }

  const box = await locateOrOpenCommentBox({
    locateBox: () => send<{ ok: boolean; x?: number; y?: number; rect?: Rect; skipReason?: string }>(
      tabId, { cmd: "locateCommentBox" },
    ),
    locateAction: () => send<{ ok: boolean; x?: number; y?: number; rect?: Rect; skipReason?: string }>(
      tabId, { cmd: "locatePostCommentAction" },
    ),
    canContinue: async () => {
      throwIfAborted(runAbort.signal);
      const guard = await send<{ observed?: { challenge?: boolean } }>(
        tabId, { cmd: "detectChallenge" },
      ).catch(() => null);
      return guard?.observed?.challenge === false;
    },
    openAction: async (action) => {
      throwIfAborted(runAbort.signal);
      await cdp.moveAndClick(tabId, rectFrom(action), rng, sleep);
      await sleep(rng.float(500, 1400)); // the post composer mounts after its action
    },
    waitForRetry: () => sleep(rng.float(350, 700)),
  });
  if (!box.ok || box.x == null) {
    // No composer. Re-check the restriction banner (it can render a beat after the
    // dwell): a restricted post is permanent (drop), everything else is transient.
    const r2 = await send<{ observed?: { restricted?: boolean } }>(tabId, { cmd: "detectCommentRestricted" }).catch(() => null);
    if (r2?.observed?.restricted) return { kind: "unavailable", detail: "comment-restricted" };
    return { kind: "failed", detail: `box-${box.skipReason ?? "not-found"}` };
  }
  await cdp.moveAndClick(tabId, rectFrom(box), rng, sleep); // focus the box
  throwIfAborted(runAbort.signal); // STOP before we type anything
  await cdp.typeText(tabId, item.body, rng, sleep);
  await sleep(rng.float(400, 2000));
  throwIfAborted(runAbort.signal); // STOP before we post the comment
  const sub = await submitComment(tabId, rng, claim, item.body);
  if (sub.claim && sub.claim !== "claimed") {
    return { kind: sub.claim === "unavailable" ? "claim-unavailable" : "claim-denied" };
  }
  return sub.ok ? { kind: "ok" } : { kind: "failed", detail: sub.detail, claimed: sub.claim === "claimed" };
}

// Read the composer state: has the just-typed comment posted? LinkedIn clears the
// box on a successful post, so an empty (or vanished) box = landed, a populated
// box = did NOT land. Any read error is treated as "not confirmed" (caller retries
// / falls back) rather than a false success.
type CommentState = { ok: boolean; observed?: { present?: boolean; empty?: boolean; text?: string } };
async function readCommentState(tabId: number, commentUrn?: string): Promise<CommentState | null> {
  return send<CommentState>(tabId, commentUrn
    ? { cmd: "readReplyComposer", commentUrn }
    : { cmd: "readCommentBox" }).catch(() => null);
}
async function commentPosted(tabId: number, commentUrn?: string): Promise<boolean> {
  const st = await readCommentState(tabId, commentUrn);
  return st?.ok === true && st.observed?.empty === true && typeof st.observed.present === "boolean";
}

// Submit the just-typed comment and CONFIRM it actually landed. Returns true ONLY
// when the composer clears — so a click that missed an off-viewport submit button,
// or a submit that never fired, is reported as a failure (→ comment-failed, the
// item is retried) instead of a phantom success that marks the draft sent with
// nothing posted (the live symptom: replies typed but never landing).
//
// Order: (1) poll for the submit button to appear/enable — LinkedIn enables it a
// beat after input — click it, confirm cleared; (2) keyboard chord fallback
// (⌘/Ctrl+Enter) that works even when the button is off-viewport or disabled. The
// empty-box guard makes the fallback safe from double-posting: once the click
// posts and the box clears, a chord fires into an empty composer and no-ops.
async function submitComment(
  tabId: number, rng: ReturnType<typeof makeRng>, claim: () => Promise<CommentClaim>,
  body: string,
): Promise<{ ok: boolean; detail?: string; claim?: CommentClaim }> {
  // 1) Button path: poll up to ~12s for a clickable submit, click, verify cleared.
  //    Widened 6s→12s: the 2026 permalink composer's submit enables/lays-out a
  //    beat after typing, and the SAME post lands on one attempt and reports
  //    submit-not-found on another — a race the poll rides out. The extra time
  //    is only ever spent on an attempt that would otherwise fail; a success
  //    returns immediately. If it still fails, the diagnostic below (wf/en/vis)
  //    names which stage never resolved.
  const deadline = Date.now() + 12000;
  let sawSubmit = false; // did a clickable submit button ever appear?
  // Descriptor of the submit we actually clicked (locateCommentSubmit's
  // observed via/aria/text/type) — stamped into the not-cleared detail below so
  // a failure row in linkedin_activity names WHICH button the click landed on
  // (the real submit vs a decoy) without a live DevTools session.
  let clicked: SubmitObserved | undefined;
  let reservation: CommentClaim | undefined;
  const reserveOnce = async (): Promise<CommentClaim> => reservation ??= await claim();
  while (Date.now() < deadline) {
    if (stopped()) return { ok: false, detail: "stopped" };
    const submit = await send<{ ok: boolean; x?: number; y?: number; rect?: Rect; observed?: SubmitObserved }>(tabId, { cmd: "locateCommentSubmit" });
    if (submit.ok && submit.x != null) {
      sawSubmit = true;
      clicked = submit.observed;
      throwIfAborted(runAbort.signal);
      const reserved = await reserveOnce();
      if (reserved !== "claimed") return { ok: false, claim: reserved };
      throwIfAborted(runAbort.signal);
      await cdp.moveAndClick(tabId, rectFrom(submit), rng, sleep);
      // Poll for the post to settle (~3.2s) before we conclude it missed —
      // widened from ~1.6s: a real submit now gets clicked on 2026 surfaces
      // where post latency can outlive a short window, and a false "missed"
      // here costs a retry that re-types the whole comment on a fresh page
      // load (a duplicate if the first one landed late).
      for (let i = 0; i < 8; i++) {
        await sleep(400);
        if (await commentPosted(tabId)) return { ok: true, claim: reservation };
      }
      break; // button was there but nothing cleared → keyboard fallback
    }
    await sleep(400); // submit not ready yet — LinkedIn is still enabling it
  }

  // 2) Keyboard fallback: refocus the composer, then ⌘+Enter (macOS) / Ctrl+Enter.
  //    Verify after each so we never fire the second chord once the first posted.
  if (stopped()) return { ok: false, detail: "stopped" };
  // One more posted-check before any chord: if the click's post landed just
  // after the loop above gave up, chording now would fire into (or re-submit)
  // a composer we no longer need to touch.
  if (sawSubmit && (await commentPosted(tabId))) return { ok: true, claim: reservation };
  const ownsDraft = (state: CommentState | null) => state?.ok === true &&
    state.observed?.present === true && state.observed.empty === false &&
    sameDraft(state.observed.text ?? "", body);
  const locateDraft = async () => {
    const box = await send<{ ok: boolean; x?: number; y?: number; rect?: Rect }>(
      tabId, { cmd: "locateCommentBox" },
    ).catch(() => null);
    return box?.ok && box.x != null && ownsDraft(await readCommentState(tabId)) ? box : null;
  };
  for (const mod of [4, 2]) { // 4 = Meta/⌘, 2 = Ctrl
    if (stopped()) return { ok: false, detail: "stopped" };
    throwIfAborted(runAbort.signal);
    if (!(await locateDraft())) return { ok: false, detail: "fallback-draft-not-found", claim: reservation };
    const reserved = await reserveOnce();
    if (reserved !== "claimed") return { ok: false, claim: reserved };
    throwIfAborted(runAbort.signal);
    // Claim admission can await HTTP. Re-resolve the proper composer afterward
    // and again after focusing; a vanished box must never send into a DM pane.
    const box = await locateDraft();
    if (!box) return { ok: false, detail: "fallback-draft-not-found", claim: reservation };
    await cdp.moveAndClick(tabId, rectFrom(box), rng, sleep);
    throwIfAborted(runAbort.signal);
    if (!ownsDraft(await readCommentState(tabId))) {
      return { ok: false, detail: "fallback-draft-not-found", claim: reservation };
    }
    await cdp.pressSubmitChord(tabId, mod);
    for (let i = 0; i < 3; i++) {
      await sleep(400);
      if (await commentPosted(tabId)) return { ok: true, claim: reservation };
    }
  }
  // Nothing landed. Name the stage so the DB skip row is diagnostic:
  //   submit-not-found(box=…,empty=…,wf=…,en=…,vis=…,top=…) → no clickable submit
  //                      ever appeared in the poll. The composer read + search
  //                      diagnostic split the causes: box=present,empty=false =
  //                      the reply is still sitting there; wf=0 = no worded
  //                      submit exists (selector model wrong), en=0 = it never
  //                      enabled (typing/state), en>0,vis=0 = enabled but no
  //                      layout box yet, top=<label>_<why> names the candidate.
  //   not-cleared(via=…,btn=…,type=…) → a submit was clicked/chorded but the
  //                      composer never cleared (submit rejected — a live
  //                      action-block — or the click hit a decoy; btn/via name
  //                      the exact button so a decoy is visible in the row). A
  //                      wall of `not-cleared` on the REAL submit across posts
  //                      is the signature of a LinkedIn comment action-block.
  let detail: string;
  if (sawSubmit) {
    detail = notClearedDetail(clicked);
  } else {
    const st = await send<{ ok: boolean; observed?: { present?: boolean; empty?: boolean } }>(
      tabId, { cmd: "readCommentBox" },
    ).catch(() => null);
    // Why did the submit never resolve? diagnoseCommentSubmit re-walks the
    // search and buckets the failure (an older content script without this
    // command returns nothing → detail formats without the extra fields).
    const dg = await send<{ ok: boolean; observed?: SubmitDiag }>(
      tabId, { cmd: "diagnoseCommentSubmit" },
    ).catch(() => null);
    detail = submitNotFoundDetail(st?.observed, dg?.observed);
  }
  console.warn("[actuator] comment did not land", { detail });
  return { ok: false, detail, claim: reservation };
}

// DM: open the profile, locate Message → compose → Send. Messaging locators
// mirror the comment ones; see docs/linkedin-actuator.md. Browser-only (manual smoke).
/** Same guard as doComment: a DM that did not send must not leave its text in
 *  the message box for the next navigation to trip over. This is the ONE caller
 *  that clears the message composer, because it is the one that typed into it —
 *  see clearComposer's ownDmBody — which is also what keeps that clear from
 *  touching a bubble whose draft it cannot prove it wrote. */
async function doDm(tabId: number, item: PoolItem, rng: ReturnType<typeof makeRng>, wpm: number): Promise<ActionResult> {
  let res: ActionResult | undefined;
  try {
    res = await doDmInner(tabId, item, rng, wpm);
    return res;
  } finally {
    if (res?.kind !== "ok") await clearComposer(tabId, rng, item.body);
  }
}

async function doDmInner(tabId: number, item: PoolItem, rng: ReturnType<typeof makeRng>, wpm: number): Promise<ActionResult> {
  await navigateTab(tabId, item.url, rng);
  await waitTabComplete(tabId);
  // Read the profile like a human before messaging — same reading-dwell proxy.
  await sleep(readingDwellMs(rng, Math.max(0, Math.round(rng.normal(60, 40))), {}, wpm));
  // Deleted/unavailable profile → drop instead of retrying the dead permalink.
  const state = await send<{ observed?: { unavailable?: boolean } }>(tabId, { cmd: "detectPostUnavailable" }).catch(() => null);
  if (state?.observed?.unavailable) return { kind: "unavailable" };
  const compose = await send<{ ok: boolean; x?: number; y?: number; rect?: Rect; skipReason?: string }>(tabId, { cmd: "locateMessageCompose" });
  // Carry the locator's own reason through: `compose-zero-rect` (a MINIMISED
  // messaging overlay) is a different problem from a missing `.msg-form`, and
  // collapsing both into compose-not-found makes them indistinguishable in
  // linkedin_activity — the one channel this change exists to make readable.
  if (!compose.ok || compose.x == null) {
    return { kind: "failed", detail: compose.skipReason ?? "compose-not-found" };
  }
  await cdp.moveAndClick(tabId, rectFrom(compose), rng, sleep);
  throwIfAborted(runAbort.signal); // STOP before we type anything
  await cdp.typeText(tabId, item.body, rng, sleep);
  await sleep(rng.float(500, 2400));
  const sendBtn = await send<{ ok: boolean; x?: number; y?: number; rect?: Rect; skipReason?: string }>(tabId, { cmd: "locateMessageSend" });
  if (!sendBtn.ok || sendBtn.x == null) {
    return { kind: "failed", detail: sendBtn.skipReason ?? "send-not-found" };
  }
  throwIfAborted(runAbort.signal); // STOP before we send the DM
  await cdp.moveAndClick(tabId, rectFrom(sendBtn), rng, sleep);
  // CONFIRM the text left the box. LinkedIn clears the message composer on a
  // successful send, so text still visibly sitting there means the click missed
  // and nothing was delivered.
  //
  // Until the review on #559 this returned ok unconditionally: a missed send was
  // recorded as delivered, markSent fired, and nothing anywhere said otherwise.
  // The draft left in the box was the only trace, and reading it is not
  // something anything downstream does — so the miss was silent.
  //
  // But the check is deliberately ASYMMETRIC with submitComment's, because the
  // costs are asymmetric. A failed DM is re-queued and re-sent from a later
  // slot, so a false failure does not lose a message, it sends a duplicate one
  // to a real person. Only text we can positively SEE still sitting there counts
  // as a miss; an unreadable composer keeps the old assume-sent behaviour.
  //
  // Known gap, stated: a click that DISMISSED the overlay instead of sending
  // also leaves no text, and still reads as sent. Closing that needs positive
  // evidence of delivery (the message appearing in the thread), which this
  // locator set cannot give — and it is no worse than the unconditional ok this
  // replaces. Poll rather than read once: the composer is React-controlled and
  // the send lands a frame or two later.
  // ~12s, matching submitComment's window rather than the 3.2s this started at.
  // Same latency class, and here the cost of giving up early is strictly worse:
  // a slow-but-successful send would read as our own text still sitting there —
  // exactly the "positive evidence" this check trusts — and a failed DM is
  // re-queued, so the operator's contact receives the message twice.
  const DM_CONFIRM_POLLS = 30;
  let missed = false;
  for (let i = 0; i < DM_CONFIRM_POLLS; i++) {
    await sleep(400);
    if (await messageComposeEmpty(tabId)) break;
    if (i === DM_CONFIRM_POLLS - 1) missed = await messageComposeStillHasText(tabId, item.body);
  }
  if (missed) return { kind: "failed", detail: "dm-not-cleared" };
  // A DM always lands on a /in/ profile; return to the feed so the following idle
  // likes + ambient browse run on the feed instead of lingering on the profile
  // (mirrors drain-mode's post-comment return). The ambient/like feed guards
  // would recover it next tick anyway, but doing it here avoids a visible stall.
  // Skip on STOP so a stopped run doesn't autonomously move the operator's tab
  // (moveAndClick fast-forwards rather than throwing when aborted mid-motion).
  if (stopped()) return { kind: "ok" };
  await navigateTab(tabId, "https://www.linkedin.com/feed/", rng, undefined, item.body).catch(() => {});
  await waitTabComplete(tabId);
  return { kind: "ok" };
}

// ── Lights-out autonomy ────────────────────────────────────────────────────
// A persistent alarm (survives service-worker suspend) checks a few times an
// hour whether to auto-start the daily run, no manual Run click. Once started,
// the content-script tick loop drives it as usual; a persisted day key enforces
// one auto-start per day. Requires a logged-in linkedin.com tab open (startRun
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
// items still queued (no tab, comment-fail give-ups) — without it the 5-min
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
  console.info("[drain-resume] resuming persistent drain (standing intent, no live run)", { curfew: intent.curfew });
  await startDrain({ manual: true, curfew: intent.curfew, notifications: intent.notifications, expectedEpoch }).catch((e) =>
    console.warn("[drain-resume] resume failed:", e instanceof Error ? e.message : e),
  );
}
// Lights-out inbox clearing. When the operator opted in (Options → auto-drain),
// start a drain whenever the server is willing to serve approved comments and
// nothing is running — an approval made mid-afternoon goes out mid-afternoon
// instead of waiting for tomorrow's scheduled run or a manual Drain click.
// Consent to post is the STANDING dashboard switch the queue route enforces
// (reply_send_enabled, or auto_send_enabled as durable lights-out consent);
// this path NEVER arms sending itself, so the panic-stop kill switch stays
// authoritative: once Pause-all clears the flags the queue serves empty and
// this loop starves. Supply == what /api/actionable-linkedin returns, so every
// server-side withhold gate (challenge breaker, working hours, caps) also
// starves it. Runs behind the same health + challenge-cooldown safety gate as
// the daily auto-start, and a manual STOP silences it for the rest of the day.
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

  // Same safety gate as the daily auto-start: post-challenge cooldown + /health.
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
// setups). Never during a send; one attempt per served stamp so a stale disk
// copy (e.g. the laptop's unsynced dir) can't reload-loop every 5 minutes.
// A serialized missing-receiver read can also take this path before its page
// reload cooldown, but only for a persistent comment drain with no queued DMs.
// It has no send in flight; queued approvals rehydrate after the drain resumes.
async function checkSelfReload(opts?: { receiverSlotIsCurrent(): Promise<boolean> }): Promise<boolean> {
  if (opts && !(await opts.receiverSlotIsCurrent())) return false;
  const cfg = await getConfig();
  if (!cfg) return false;
  const api = new ActuatorApi(cfg);
  const served = await api.fetchExtensionBuild().catch(() => null); // fetch fail → null → no reload
  // Load run state AFTER the network round-trip: checkAutonomy runs concurrently
  // in the same alarm tick, and a run it auto-started DURING this fetch must be
  // seen as active — reloading then would wipe the run's just-saved session state
  // while the once-daily auto-start guard is already consumed (no run that day).
  const s = await loadState();
  const store = await chrome.storage.local.get([RELOAD_STAMP_KEY, DRAIN_INTENT_KEY]);
  // A persistent drain (Drain / Full automatic / auto-drain) never ends, so
  // `runActive` alone would block self-updates forever. The periodic alarm
  // requires empty pools. A serialized receiver read can have queued comments
  // in drain mode, but has no send in flight; scheduled runs and queued DMs keep
  // their existing protection. Both paths require a resume path: drain intent
  // (checkDrainResume) or lights-out auto-drain. That makes the self-update
  // invisible instead of a silent stop (the bug: reload wiped the run, nothing
  // restarted).
  const quiet = !!s && s.commentPool.length === 0 && s.dmPool.length === 0;
  const willResume =
    parseDrainIntent(store[DRAIN_INTENT_KEY]) !== null || (cfg.autonomous === true && cfg.autoDrain === true);
  const decide = shouldReloadBuildAtReceiver({
    runActive: s?.status === "running",
    poolsEmpty: quiet,
    hasResumePath: willResume,
    serializedReceiverSlot: opts !== undefined,
    mode: s?.mode,
    dmPoolSize: s?.dmPool.length ?? 0,
    embeddedStamp: typeof __BUILD_STAMP__ === "string" ? __BUILD_STAMP__ : null,
    servedStamp: served?.stamp ?? null,
    lastAttemptedStamp: (store[RELOAD_STAMP_KEY] as string | undefined) ?? null,
  });
  if (!decide || (opts && !(await opts.receiverSlotIsCurrent()))) return false;
  await chrome.storage.local.set({ [RELOAD_STAMP_KEY]: served!.stamp });
  console.info("[self-reload] newer build on disk; reloading extension", {
    from: __BUILD_STAMP__,
    to: served!.stamp,
  });
  chrome.runtime.reload();
  return true;
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
//   'running' → set the Full-auto standing intent (clearing a same-day STOP) and
//               let checkDrainResume resume the drain BEHIND the existing health +
//               challenge-cooldown + curfew safety gates.
//   null      → no remote override: clear the mirror; local autonomy governs.
async function applyRemoteIntent(desired: "running" | "stopped" | null): Promise<void> {
  const cfg = await getConfig();
  if (!cfg) return;
  const prevStore = await chrome.storage.local.get(REMOTE_STATE_KEY).catch(() => ({}));
  const prev = (prevStore as Record<string, unknown>)[REMOTE_STATE_KEY];

  if (desired === "stopped") {
    await chrome.storage.local.set({ [REMOTE_STATE_KEY]: "stopped" });
    await chrome.storage.local.remove([DRAIN_INTENT_KEY, DISCOVERY_CANARY_KEY]);
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

// The priority channel wakes the existing actor when a browser-observed post
// has a Jev qualification and a genuine passing review. It never sends directly:
// tick() remains the only action runner, with its curfew, challenge, pacing,
// duplicate, and STOP guards. The in-flight long poll also keeps MV3 awake.
let priorityLoopRunning = false;
function ensurePriorityLoop(): void {
  if (priorityLoopRunning) return;
  priorityLoopRunning = true;
  void runPriorityLoop().finally(() => { priorityLoopRunning = false; });
}

async function runPriorityLoop(): Promise<void> {
  let epoch = 0;
  let since = 0;
  for (;;) {
    await restoreRunAfterWorkerRestart();
    const cfg = await getConfig().catch(() => null);
    const state = await loadState().catch(() => null);
    if (!cfg || state?.status !== "running" || stopped() || !(await browserDiscoveryEnabled())) {
      pendingPriority = null;
      epoch = 0;
      since = 0;
      await plainSleep(5000);
      continue;
    }
    if (state.epoch !== epoch) {
      epoch = state.epoch;
      since = Math.max(0, state.startMs - 1000);
    }
    const requestStartedAt = Date.now();
    const ready = await new ActuatorApi(cfg).fetchPriorityReady(since).catch(async (error) => {
      if (Date.now() - lastPriorityErrorMs >= 60_000) {
        lastPriorityErrorMs = Date.now();
        await reportBrowserDiscovery({
          at: new Date().toISOString(), instanceId: cfg.instanceId,
          result: "failed", stage: "priority", observed: 0, accepted: 0, duplicates: 0, invalid: 0,
          error: discoveryError(error),
        });
