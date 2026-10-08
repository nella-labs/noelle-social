import {
  ActionableXResponseSchema,
  ActorReplyCapWriteSchema,
  ActorReplyCapStateSchema,
  ActuatorIntentResponseSchema,
  InboundReplyResponseSchema,
  type ActuatorIntentResponse,
  type ActorReplyCapState,
  type InboundReplyIn,
  type InboundReplyResponse,
  type XActivityEvent,
} from "@noelle/contracts";
import type { ActuatorConfig } from "./types.js";
import type { VisibleTweet } from "../content/discovery.js";

// The shared background engine (copied from the LinkedIn actuator) consumes a
// queue shaped as { comments, dms }. X is reply-only, so fetchQueue adapts the
// X-native { replies } response onto that shape: every reply becomes a
// "comment" pool item and dms is always empty. This is the ONLY place the
// naming is bridged — keeping the engine (scheduler/state/replenish) untouched.
export interface EngineQueueItem {
  approval_id: string;
  draft_id: string;
  body: string;
  target: { url: string };
}
export interface EngineQueue {
  comments: EngineQueueItem[];
  dms: EngineQueueItem[];
}

export type ReplyCapState = ActorReplyCapState;

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

  private async replyCapRequest(cap?: number | null, minimum?: number | null): Promise<ReplyCapState> {
    const write = cap === undefined ? undefined : ActorReplyCapWriteSchema.parse({ cap,
      ...(minimum === undefined ? {} : { minimum }) });
    const url = `${this.config.apiBaseUrl}/api/actuator/reply-cap?platform=x&instanceId=${encodeURIComponent(this.config.instanceId)}`;
    const res = await this.ok(await this.fetchImpl(url, {
      method: cap === undefined ? "GET" : "POST", headers: this.headers(),
      ...(write === undefined ? {} : { body: JSON.stringify(write) }),
    }));
    const parsed = ActorReplyCapStateSchema.safeParse(await res.json());
    if (!parsed.success) throw new Error("invalid browser reply cap response");
    if (write?.minimum != null && (parsed.data.configuredCap !== write.cap ||
        parsed.data.minimum !== write.minimum || parsed.data.day === undefined)) {
      throw new Error("API did not confirm the daily reply range");
    }
    return parsed.data;
  }

  fetchReplyCap(): Promise<ReplyCapState> { return this.replyCapRequest(); }
  setReplyCap(cap: number | null, minimum?: number | null): Promise<ReplyCapState> { return this.replyCapRequest(cap, minimum); }

  async fetchQueue(): Promise<EngineQueue> {
    const url = `${this.config.apiBaseUrl}/api/actionable-x?instanceId=${encodeURIComponent(this.config.instanceId)}`;
    const res = await this.ok(await this.fetchImpl(url, { headers: this.headers() }));
    const parsed = ActionableXResponseSchema.parse(await res.json());
    return {
      comments: parsed.replies.map((r) => ({
        approval_id: r.approval_id,
        draft_id: r.draft_id,
        body: r.body,
        target: { url: r.target.url },
      })),
      dms: [], // X DMs stay manual — never auto-sent.
    };
  }

  async fetchDiscoveryTarget(): Promise<{ kind: "profile"; handle: string } | { kind: "keyword"; value: string } | null> {
    const url = `${this.config.apiBaseUrl}/api/x-actuator/discovery-target?instanceId=${encodeURIComponent(this.config.instanceId)}`;
    const res = await this.ok(await this.fetchImpl(url, { headers: this.headers() }));
    const body = (await res.json()) as { target?: unknown };
    const target = body.target;
    if (!target || typeof target !== "object") return null;
    const value = target as Record<string, unknown>;
    if (value.kind === "profile" && typeof value.handle === "string") return { kind: "profile", handle: value.handle };
    if (value.kind === "keyword" && typeof value.value === "string") return { kind: "keyword", value: value.value };
    return null;
  }

  async fetchDiscoveryCapacity(): Promise<{ limit: number; occupied: number; available: number }> {
    const url = `${this.config.apiBaseUrl}/api/x-actuator/discovery-capacity?instanceId=${encodeURIComponent(this.config.instanceId)}`;
    const res = await this.ok(await this.fetchImpl(url, { headers: this.headers() }));
    const body = (await res.json()) as Record<string, unknown>;
    const { limit, occupied, available } = body;
    if (![limit, occupied, available].every((value) => typeof value === "number" && Number.isInteger(value)) ||
        (limit as number) < 0 || (occupied as number) < 0 || (available as number) < 0 ||
        (available as number) !== Math.max(0, (limit as number) - (occupied as number))) {
      throw new Error("invalid X discovery capacity");
    }
    return { limit: limit as number, occupied: occupied as number, available: available as number };
  }

  async postObservations(items: VisibleTweet[]): Promise<{ accepted: number; duplicates: number; invalid: number }> {
    if (items.length === 0) return { accepted: 0, duplicates: 0, invalid: 0 };
    const url = `${this.config.apiBaseUrl}/api/x-actuator/observations`;
    const res = await this.ok(await this.fetchImpl(url, {
      method: "POST", headers: this.headers(),
      body: JSON.stringify({ instanceId: this.config.instanceId, items: items.slice(0, 50) }),
    }));
    const body = (await res.json()) as Record<string, unknown>;
    if (![body.accepted, body.duplicates, body.invalid].every((v) => typeof v === "number" && Number.isFinite(v))) {
      throw new Error("invalid X observations response");
    }
    return body as { accepted: number; duplicates: number; invalid: number };
  }

  /** Browser-qualified approvals only; the route repeats the ordinary send gates. */
  async fetchPriorityReady(): Promise<EngineQueue> {
    const url = `${this.config.apiBaseUrl}/api/actionable-x/priority-ready?instanceId=${encodeURIComponent(this.config.instanceId)}`;
    const res = await this.ok(await this.fetchImpl(url, { headers: this.headers() }));
    const parsed = ActionableXResponseSchema.parse(await res.json());
    return {
      comments: parsed.replies.map((r) => ({
        approval_id: r.approval_id,
        draft_id: r.draft_id,
        body: r.body,
        target: { url: r.target.url },
      })),
      dms: [],
    };
  }

  /** A permanent per-tweet reservation immediately before the browser submit. */
  async claimReply(approvalId: string): Promise<{ claimed: boolean }> {
    const url = `${this.config.apiBaseUrl}/api/x-actuator/claim-reply/${encodeURIComponent(approvalId)}`;
    const res = await this.fetchImpl(url, { method: "POST", headers: this.headers() });
    if (res.status === 409) return { claimed: false };
    await this.ok(res);
    const body = (await res.json()) as { claimed?: unknown };
    if (typeof body.claimed !== "boolean") throw new Error("invalid X claim response");
    return { claimed: body.claimed };
  }

  /** On-disk build stamp of the unpacked extension, as served by api-vm. Null
   * when the server has no readable stamp (fail-soft: caller does nothing). */
  async fetchExtensionBuild(): Promise<{ stamp: string | null }> {
    const url = `${this.config.apiBaseUrl}/api/actuator/x-extension-build`;
    const res = await this.ok(await this.fetchImpl(url, { headers: this.headers() }));
    const body = (await res.json()) as { stamp?: unknown };
    return { stamp: typeof body.stamp === "string" ? body.stamp : null };
  }

  async markSent(approvalId: string): Promise<void> {
    // Reuses the generic, platform-agnostic actuator mark-sent (approval-id keyed).
    const url = `${this.config.apiBaseUrl}/api/actuator/mark-sent/${encodeURIComponent(approvalId)}`;
    await this.ok(await this.fetchImpl(url, { method: "POST", headers: this.headers(), body: JSON.stringify({ sent_via: "extension" }) }));
  }

  // Mark an approval `skipped` server-side (nothing was posted). The extension
  // calls this when the target is permanently un-replyable — the post is gone
  // (deleted by its author, protected account, dead permalink, account
  // suspended, "this page doesn't exist") or replies are restricted ("Who can
  // reply?") — so the queue stops re-serving the dead permalink on every
  // future run. Without it the approval stays 'pending' forever (markSent only
  // fires on a real post) and each new session re-navigates to it and drops it
  // again. Reuses the generic, platform-agnostic actuator mark-skipped
  // (approval-id keyed; status='pending' guard server-side). Best-effort at
  // the call site (a failure just means it gets re-served next session, same
  // as before).
  async markSkipped(approvalId: string, reason: string): Promise<void> {
    const url = `${this.config.apiBaseUrl}/api/actuator/mark-skipped/${encodeURIComponent(approvalId)}`;
    await this.ok(await this.fetchImpl(url, { method: "POST", headers: this.headers(), body: JSON.stringify({ reason }) }));
  }

  // Re-verify one approval immediately before posting it. Pool items can sit
  // queued for minutes-to-hours after fetchQueue; in that window the approval
  // can be decided elsewhere (human skip/sent) or claimed by the x-intern
  // API-autosend pipeline (auto_send_target_at stamped → claimAutoSendDue
  // posts it via the official API). The caller wraps in `.catch(() => null)`
  // and preSendDecision FAILS CLOSED on null — never post unverified, never
  // post a non-pending or autosend-owned approval (duplicate public reply).
  async approvalState(approvalId: string): Promise<{ status: string; autosend_pending: boolean }> {
    const url = `${this.config.apiBaseUrl}/api/actuator/approval-state/${encodeURIComponent(approvalId)}`;
    const res = await this.ok(await this.fetchImpl(url, { headers: this.headers() }));
    const body = (await res.json()) as { status?: unknown; autosend_pending?: unknown };
    if (typeof body.status !== "string") throw new Error("approval-state: malformed response");
    return { status: body.status, autosend_pending: body.autosend_pending === true };
  }

  // DELIBERATELY NO enableSend() here, unlike the LinkedIn actuator's api.ts.
  // On X, agent_instances.reply_send_enabled is not just this extension's queue
  // gate — it is the MASTER GATE of the x-intern official-API send worker
  // (apps/x-intern/src/workers/send.ts), which once armed fires any
  // auto_send_target_at-stamped pending approval unattended. A browser
  // extension flipping that column would (a) arm a second sender over the same
  // approval pool (duplicate public posts) and (b) on disable, silently revoke
  // the operator's standing dashboard consent. The operator manages the switch
  // from the Vega agent page; this client only ever reads its effect (an empty
  // /api/actionable-x queue when off).

  // Server-side actuator health gate for lights-out auto-start. `this.ok` throws
  // on non-2xx; network errors reject — the caller wraps in `.catch(() => null)`
  // so any failure collapses to null → fail-closed (skip auto-start).
  async health(): Promise<{ status: "ok" | "warn" | "halt" }> {
    const url = `${this.config.apiBaseUrl}/api/actuator/x-health?instanceId=${encodeURIComponent(this.config.instanceId)}`;
    const res = await this.ok(await this.fetchImpl(url, { headers: this.headers() }));
    return (await res.json()) as { status: "ok" | "warn" | "halt" };
  }

  // Ingest replies-to-us harvested from the notifications page. This is the ONLY
  // write the notifications sweep makes, and it writes to noelle — never to X.
  // Each item becomes a lead the drafter picks up; the reply itself still flows
  // out through the normal approval → actionable-x → actuate path, so nothing
  // here can post. Throws on non-2xx (the caller downgrades it to a panel line
  // and retries on the next sweep — the items stay unseen until the server has
  // decided on them).
  async postInboundReplies(body: InboundReplyIn): Promise<InboundReplyResponse> {
    const url = `${this.config.apiBaseUrl}/api/actuator/inbound-reply`;
    const res = await this.ok(
      await this.fetchImpl(url, { method: "POST", headers: this.headers(), body: JSON.stringify(body) }),
    );
    return InboundReplyResponseSchema.parse(await res.json());
  }

  async logActivity(sessionId: string, events: XActivityEvent[]): Promise<void> {
    if (events.length === 0) return;
    const url = `${this.config.apiBaseUrl}/api/x-activity`;
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
  // liveness. `setDesired` is passed ONLY on an explicit local panel action
  // (Full-automatic / STOP) to publish the operator's new intent so the local
  // panel and the remote switch never disagree. Best-effort at the call site.
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
