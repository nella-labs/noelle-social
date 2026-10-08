import type { Rng } from "../lib/rng.js";
import { planDrainTimeline } from "../lib/scheduler.js";
import type { EngineQueue } from "../lib/api.js";
import type { RunState } from "./state.js";
import type { VisibleTweet } from "../content/discovery.js";
import { mergePool, shouldExtendDrain } from "./replenish.js";
import type { AmbientKind } from "./ambient.js";

export const DISCOVERY_MODE_KEY = "actuator.browserDiscovery";
export const DRY_DISCOVERY_POLL_MS = 90_000;
const MAX_TARGET_GAP_MS = 10 * 60_000;
type DiscoveryTarget = { kind: "profile"; handle: string } | { kind: "keyword"; value: string };

export function discoveryStartDecision(
  current: Pick<RunState, "status" | "mode"> | null,
  tickInFlight: boolean,
): "blocked" | "keep" | "defer" | "start" {
  if (current?.status === "halted-challenge") return "blocked";
  if (current?.status === "running" && current.mode === "drain") return "keep";
  if (current?.status === "running" && tickInFlight) return "defer";
  return "start";
}

/** Lost claim responses are ambiguous: a reservation may already exist. */
export async function claimReplyBeforeSubmit(
  api: { claimReply(approvalId: string): Promise<{ claimed: boolean }> },
  approvalId: string,
): Promise<boolean> {
  try { return (await api.claimReply(approvalId)).claimed === true; }
  catch { return false; }
}

export function discoveryTargetUrl(target: DiscoveryTarget | null, nowMs = Date.now()): string | null {
  if (!target) return null;
  if (target.kind === "profile") {
    const handle = target.handle.replace(/^@/, "");
    return /^[A-Za-z0-9_]{1,15}$/.test(handle) ? `https://x.com/${handle}` : null;
  }
  const value = target.value.trim();
  if (value.length === 0 || value.length > 500) return null;
  // Saved keywords are the operator-owned search contract. Do not silently
  // strengthen their engagement floor: these searches are already narrow, and
  // replacing min_faves:1/2 with 10 can turn a valid query into an empty page.
  // Latest results plus the date window keep discovery current; saved queries
  // can still opt into any min_faves floor they need.
  const since = new Date(nowMs - 24 * 3600_000).toISOString().slice(0, 10);
  return `https://x.com/search?q=${encodeURIComponent(`${value} since:${since}`)}&src=typed_query&f=live`;
}

function firstTopLevelClause(query: string): string | null {
  const value = query.trim();
  if (!value) return null;
  if (value[0] === "(") {
    let depth = 0;
    let quoted = false;
    for (let i = 0; i < value.length; i++) {
      if (value[i] === '"' && value[i - 1] !== "\\") quoted = !quoted;
      if (quoted) continue;
      if (value[i] === "(") depth++;
      if (value[i] === ")" && --depth === 0) return value.slice(0, i + 1);
    }
    return null;
  }
  if (value[0] === '"') {
    for (let i = 1; i < value.length; i++) {
      if (value[i] === '"' && value[i - 1] !== "\\") return value.slice(0, i + 1);
    }
    return null;
  }
  return value.match(/^\S+/)?.[0] ?? null;
}

function firstTopicalClause(query: string): { clause: string; rest: string } | null {
  let remaining = query.trim();
  while (remaining) {
    const clause = firstTopLevelClause(remaining);
    if (!clause) return null;
    const rest = remaining.slice(clause.length).trimStart();
    const operator = clause.startsWith("-") || /^-?(?:lang|filter|min_faves|min_retweets|min_replies|since|until|since_time|until_time|from|to|url|list|near|within|geocode|is):/i.test(clause);
    if (!operator) return { clause, rest };
    remaining = rest;
  }
  return null;
}

/** Broaden an empty saved search without abandoning its primary topic. */
export function emptySearchFallbackUrl(targetUrl: string): string | null {
  let target: URL;
  try { target = new URL(targetUrl); }
  catch { return null; }
  if ((target.hostname !== "x.com" && target.hostname !== "twitter.com") || target.pathname !== "/search") return null;
  const query = target.searchParams.get("q")?.trim() ?? "";
  const topical = firstTopicalClause(query);
  if (!topical) return null;
  const lang = query.match(/(?:^|\s)(lang:[\w-]+)/i)?.[1];
  const replies = /(?:^|\s)-filter:replies(?:\s|$)/i.test(query) ? "-filter:replies" : undefined;
  const since = query.match(/(?:^|\s)(since:\d{4}-\d{2}-\d{2})(?:\s|$)/i)?.[1];
  const retained = [topical.clause, lang, replies, since].filter((clause): clause is string => Boolean(clause));
  // A single topical clause can still be narrowed by an engagement floor.
  // Retry only when some saved clause is actually removed; reordering the
  // preserved operators would revisit the same empty result.
  const clauses: string[] = [];
  let remaining = query;
  while (remaining) {
    const clause = firstTopLevelClause(remaining);
    if (!clause) return null;
    clauses.push(clause);
    remaining = remaining.slice(clause.length).trimStart();
  }
  if (clauses.length === retained.length && retained.every((clause) => clauses.includes(clause))) return null;
  const relaxed = retained.join(" ");
  return `https://x.com/search?q=${encodeURIComponent(relaxed)}&src=typed_query&f=live`;
}

function cachedDiscoveryTarget(value: unknown): DiscoveryTarget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const target = value as Record<string, unknown>;
  if (target.kind === "profile" && typeof target.handle === "string") return { kind: "profile", handle: target.handle };
  if (target.kind === "keyword" && typeof target.value === "string") return { kind: "keyword", value: target.value };
  return null;
}

/** Retry a selected target before asking the mutating scheduler for another one. */
export async function discoveryNavigationTarget(args: {
  nowMs: number;
  lastSelectedMs: number | null;
  randomRoll: number;
  cachedTarget: unknown;
  fetchTarget: () => Promise<DiscoveryTarget | null>;
  cacheTarget: (target: DiscoveryTarget) => Promise<void>;
  discardCachedTarget: () => Promise<void>;
  onCacheFailure: () => void;
}): Promise<string | null> {
  const cachedUrl = discoveryTargetUrl(cachedDiscoveryTarget(args.cachedTarget), args.nowMs);
  if (cachedUrl) return cachedUrl;
  if (args.cachedTarget !== null && args.cachedTarget !== undefined) {
    try { await args.discardCachedTarget(); }
    catch { args.onCacheFailure(); return null; }
  }
  if (args.lastSelectedMs !== null && args.nowMs - args.lastSelectedMs < MAX_TARGET_GAP_MS && args.randomRoll >= 0.3) return null;
  const target = await args.fetchTarget();
  const url = discoveryTargetUrl(target, args.nowMs);
  if (!target || !url) return null;
  try { await args.cacheTarget(target); }
  catch { args.onCacheFailure(); return null; }
  return url;
}

/** A selected URL counts only after the pinned-tab runner completes its visit. */
export async function stampCompletedDiscoveryTarget(args: {
  outcome: AmbientKind | null;
  targetUrl: string | null;
  completedAtMs: number;
  commitVisit: (record: { completedAtMs: number; pendingTarget: null }) => Promise<void>;
  onStampFailure: () => void;
}): Promise<void> {
  if (args.outcome !== "navigate" || !args.targetUrl) return;
  try { await args.commitVisit({ completedAtMs: args.completedAtMs, pendingTarget: null }); }
  catch { args.onStampFailure(); }
}

export function dryDiscoveryDue(lastReadMs: number, nowMs: number): boolean {
  return nowMs - lastReadMs >= DRY_DISCOVERY_POLL_MS;
}

export function discoveryBrowseDecision(args: {
  enabled: boolean; lastReadMs: number; nowMs: number; available: number | null;
}): "browse" | "waiting" | "full" | "unavailable" {
  if (!args.enabled) return "browse";
  if (args.available === null) return "unavailable";
  if (args.available <= 0) return "full";
  return dryDiscoveryDue(args.lastReadMs, args.nowMs) ? "browse" : "waiting";
}

/** A read can submit only the open slots, even when target and feed both expose posts. */
export function observationBatch<T extends VisibleTweet>(pending: T[], available: number): T[] {
  return pending.slice(0, Math.min(12, Math.max(0, Math.floor(available))));
}

/** Fill the existing drain schedule; the normal tick remains the only sender. */
export function integratePriorityReady(state: RunState, queue: EngineQueue, now: number, rng: Rng): number {
  if (state.status !== "running") return 0;
  const before = state.commentPool.length;
  state.commentPool = mergePool(state.commentPool, queue.comments.map((r) => ({
    approvalId: r.approval_id, draftId: r.draft_id, body: r.body, url: r.target.url,
  })), new Set(state.doneDraftIds));
  const added = state.commentPool.length - before;
  if (added === 0 || !state.actions.every((a) => a.executed) ||
      !shouldExtendDrain(state.mode, state.drainRounds ?? 0, state.commentPool.length)) return added;
  // Keep the reply cadence already used by the actor. The first new slot is
  // scheduled a few seconds from now, or at least a minute after its last send.
  const startMs = Math.max(now, (state.lastProgressMs ?? 0) + 60_000);
  const planned = planDrainTimeline({
    approvedComments: state.commentPool.length,
    startMs, rng, ...(state.drainStyle ?? {}),
  });
  for (const action of planned) state.actions.push({ ...action, executed: false });
  const lastAt = planned.reduce((latest, action) => Math.max(latest, action.atMs), startMs);
  state.windowHours = (lastAt - state.startMs) / 3600_000 + 0.15;
  state.targets.comments += state.commentPool.length;
  state.targets.likes += planned.filter((action) => action.kind === "like").length;
  state.drainRounds = (state.drainRounds ?? 0) + 1;
  state.lastEvent = `priority reply ready — ${added} added at next scheduled slot`;
  return added;
}
