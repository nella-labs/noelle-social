import { fetchBoundedHttpResponse, decodeHttpJson } from "@noelle/runtime/bounded-http";
import {
  ActionableRedditResponseSchema,
  RedditReplyItemSchema, RedditReplyClaimInSchema, RedditReplyClaimOutSchema,
  type RedditReplyItem,
  ActuatorIntentResponseSchema,
  type ActuatorIntentResponse,
  type RedditActivityEvent,
} from "@noelle/contracts";
import type { ActuatorConfig } from "./types.js";

// The shared background engine (copied from the X/LinkedIn actuators) consumes a
// queue shaped as { comments, dms }. Reddit is reply-only — no DMs, and crucially
// NO votes (automated up/down-voting is vote manipulation under Reddit's policies
// and is bannable) — so fetchQueue adapts the Reddit-native { replies } response
// onto that shape: every reply becomes a "comment" pool item and dms is always
// empty. Reddit additionally carries a target TYPE (post | comment) + commentId so
// the background can reply under a specific most-upvoted COMMENT, not just the
// source post. This is the ONLY place the naming is bridged — the engine
// (scheduler/state/replenish) stays untouched.
export interface EngineQueueTarget {
  url: string; // the permalink to open (post comments page, or the comment permalink)
  type: "post" | "comment";
  commentId?: string; // the t1 id (t1_ stripped) when type === "comment"
}
export interface EngineQueueItem {
  capturedReply?: RedditReplyItem;
  approval_id: string;
  draft_id: string;
  body: string;
  target: EngineQueueTarget;
}
export interface EngineQueue {
  comments: EngineQueueItem[];
  dms: EngineQueueItem[];
}

export class ActuatorApi {
  constructor(
    private readonly config: ActuatorConfig,
    // MUST be bound to the global scope: calling it as `this.fetchImpl(...)`
    // rebinds `this` to the instance, and the browser's fetch throws
    // "Illegal invocation" unless `this` is the realm global.
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.config.token}`, "content-type": "application/json" };
  }

  private async ok(res: Response): Promise<Response> {
    if (!res.ok) throw new Error(`actuator api ${res.status}: ${await res.text().catch(() => "")}`);
    return res;
  }

  async fetchQueue(): Promise<EngineQueue> {
    const url = `${this.config.apiBaseUrl}/api/actionable-reddit?instanceId=${encodeURIComponent(this.config.instanceId)}`;
    const res = await this.ok(await this.fetchImpl(url, { headers: this.headers() }));
    const parsed = ActionableRedditResponseSchema.parse(await res.json());
    return {
      comments: parsed.replies.map((r) => ({
        capturedReply: r,
        approval_id: r.approval_id,
        draft_id: r.draft_id,
        body: r.body,
        target: {
          url: r.target.url,
          type: r.target.type,
          commentId: r.target.type === "comment" ? r.target.comment_id : undefined,
        },
      })),
      dms: [], // Reddit is reply-only — never any DMs.
    };
  }

  /** Reserve exactly the original queued body and target; one transport attempt only. */
  async claimReply(reply: RedditReplyItem): Promise<void> {
    const body = JSON.stringify(RedditReplyClaimInSchema.parse({ instance_id: this.config.instanceId, reply }));
    const { response, bytes } = await fetchBoundedHttpResponse(
      `${this.config.apiBaseUrl}/api/reddit-reply-claim`,
      { method: "POST", headers: this.headers(), body },
      { timeoutMs: 5000, maxBytes: 16384, fetchImpl: this.fetchImpl },
    );
    if (!response.ok) throw new Error(`Reddit claim unavailable (${response.status})`);
    RedditReplyClaimOutSchema.parse(decodeHttpJson(bytes));
  }

  /** On-disk build stamp of the unpacked extension, as served by api-vm. Null
   * when the server has no readable stamp (fail-soft: caller does nothing). */
  async fetchExtensionBuild(): Promise<{ stamp: string | null }> {
    const url = `${this.config.apiBaseUrl}/api/actuator/reddit-extension-build`;
    const res = await this.ok(await this.fetchImpl(url, { headers: this.headers() }));
    const body = (await res.json()) as { stamp?: unknown };
    return { stamp: typeof body.stamp === "string" ? body.stamp : null };
  }

  async markSent(approvalId: string): Promise<void> {
    // Reuses the generic, platform-agnostic actuator mark-sent (approval-id keyed).
    const url = `${this.config.apiBaseUrl}/api/actuator/mark-sent/${encodeURIComponent(approvalId)}`;
    await this.ok(await this.fetchImpl(url, { method: "POST", headers: this.headers(), body: JSON.stringify({ sent_via: "extension" }) }));
  }

  // Flip the master reply switch (reply_send_enabled) for this instance. Called
  // with enabled=true when the operator starts a Run/Drain (so approved replies
  // flow without a dashboard toggle) and enabled=false when the run ends. `this.ok`
  // throws on non-2xx so callers can decide fatal vs best-effort. The route is the
  // shared org-scoped POST /api/actuator/enable-send (same one LinkedIn uses).
  // Returns the server-reported PRIOR value of the flag (before this write) so
  // the arm can be transition-aware: `prior` is undefined against an older
  // api-vm that doesn't report it (or an unparseable body) — callers MUST treat
  // that as prior=true (fail-safe: never disarm the operator's standing consent).
  async enableSend(instanceId: string, enabled: boolean): Promise<{ prior?: boolean }> {
    const url = `${this.config.apiBaseUrl}/api/actuator/enable-send`;
    const res = await this.ok(await this.fetchImpl(url, { method: "POST", headers: this.headers(), body: JSON.stringify({ instanceId, enabled }) }));
    const body = (await res.json().catch(() => null)) as { prior?: unknown } | null;
    return typeof body?.prior === "boolean" ? { prior: body.prior } : {};
  }

  // Mark an approval `skipped` server-side (nothing was posted). Reuses the
  // generic, platform-agnostic actuator mark-skipped (approval-id keyed; skips
  // only a still-pending approval, never clobbers a sent one). The extension
  // calls this when the target thread can NEVER take the reply — removed/deleted,
  // comments locked, or the post archived — so the queue stops re-serving the
  // dead permalink on every future run; without it the approval stays 'pending'
  // forever (markSent only fires on a real post) and each new session
  // re-navigates to it and drops it again. Best-effort at the call site (a
  // failure just means it gets re-served next session, same as before).
  async markSkipped(approvalId: string, reason: string): Promise<void> {
    const url = `${this.config.apiBaseUrl}/api/actuator/mark-skipped/${encodeURIComponent(approvalId)}`;
    await this.ok(await this.fetchImpl(url, { method: "POST", headers: this.headers(), body: JSON.stringify({ reason }) }));
  }

  // Server-side actuator health gate for lights-out auto-start. `this.ok` throws
  // on non-2xx; network errors reject — the caller wraps in `.catch(() => null)`
  // so any failure collapses to null → fail-closed (skip auto-start).
  async health(): Promise<{ status: "ok" | "warn" | "halt" }> {
    const url = `${this.config.apiBaseUrl}/api/actuator/reddit-health`;
    const res = await this.ok(await this.fetchImpl(url, { headers: this.headers() }));
    return (await res.json()) as { status: "ok" | "warn" | "halt" };
  }

  async logActivity(sessionId: string, events: RedditActivityEvent[]): Promise<void> {
    if (events.length === 0) return;
    const url = `${this.config.apiBaseUrl}/api/reddit-activity`;
    await this.ok(await this.fetchImpl(url, { method: "POST", headers: this.headers(), body: JSON.stringify({ session_id: sessionId, events }) }));
  }

  // Long-poll the operator's REMOTE start/stop intent for this actuator (0089).
  // Holds server-side up to ~25s, returning immediately once the desired state
  // advances past `sinceMs` (the commandAt this extension last saw). A client
  // abort at 33s guards a wedged connection so the intent loop can re-poll; the
  // in-flight fetch also keeps the MV3 service worker alive. `this.ok` throws on
  // non-2xx and the fetch rejects on abort/network error — the caller wraps in
  // `.catch(() => null)` and backs off, so a down api-vm never wedges the loop.
  async fetchIntent(sinceMs: number): Promise<ActuatorIntentResponse> {
    const url = `${this.config.apiBaseUrl}/api/actuator/intent?instanceId=${encodeURIComponent(this.config.instanceId)}&since=${sinceMs}&waitMs=25000`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 33_000);
    try {
      const res = await this.ok(await this.fetchImpl(url, { headers: this.headers(), signal: ctrl.signal }));
      return ActuatorIntentResponseSchema.parse(await res.json());
    } finally {
      clearTimeout(timer);
    }
  }

  // Report the extension's ACTUAL run state for the dashboard's live status +
  // liveness. `setDesired` is passed ONLY on an explicit local panel action (STOP)
  // to publish the operator's new intent so the local panel and the remote switch
  // never disagree. Best-effort at the call site.
  async ackIntent(runState: "running" | "idle", setDesired?: "running" | "stopped"): Promise<void> {
    const url = `${this.config.apiBaseUrl}/api/actuator/intent-ack`;
    const body: { instanceId: string; runState: "running" | "idle"; setDesired?: "running" | "stopped" } = {
      instanceId: this.config.instanceId,
      runState,
    };
    if (setDesired) body.setDesired = setDesired;
    await this.ok(await this.fetchImpl(url, { method: "POST", headers: this.headers(), body: JSON.stringify(body) }));
  }
}

/** Persisted old queues without their original capture cannot authorize a new dispatch. */
export function readCapturedReply(item: {
  approvalId: string; draftId: string; body: string; url: string; targetType?: "post" | "comment"; commentId?: string;
}): RedditReplyItem | null {
  const captured = RedditReplyItemSchema.safeParse((item as { capturedReply?: unknown }).capturedReply);
  if (!captured.success) return null;
  const reply = captured.data;
  return reply.approval_id === item.approvalId && reply.draft_id === item.draftId && reply.body === item.body
    && reply.target.url === item.url && reply.target.type === (item.targetType ?? "post")
    && (reply.target.type !== "comment" || reply.target.comment_id === item.commentId) ? reply : null;
}
