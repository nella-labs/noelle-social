import {
  ActionableLinkedInResponseSchema,
  ActuatorIntentResponseSchema,
  InboundReplyResponseSchema,
  type ActionableLinkedInResponse,
  type ActuatorIntentResponse,
  type InboundReplyIn,
  type InboundReplyResponse,
  type LinkedInActivityEvent,
} from "@noelle/contracts";
import type { ActuatorConfig } from "./types.js";
import type { VisiblePost } from "../content/discovery.js";
import type { PendingDiscoveryIdentity } from "../background/discovery-identity.js";
import { directShortPostUrl } from "./urn.js";

export type DiscoveryTarget = { kind: "profile" | "keyword"; id: string; url: string };
export type DiscoveryCapacity = { limit: number; occupied: number; available: number };
export type ReplyCapState = { sent: number; cap: number | null; remaining: number | null };

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

  private async replyCapRequest(cap?: number | null): Promise<ReplyCapState> {
    const url = `${this.config.apiBaseUrl}/api/actuator/reply-cap?platform=linkedin&instanceId=${encodeURIComponent(this.config.instanceId)}`;
    const res = await this.ok(await this.fetchImpl(url, {
      method: cap === undefined ? "GET" : "POST", headers: this.headers(),
      ...(cap === undefined ? {} : { body: JSON.stringify({ cap }) }),
    }));
    const body = (await res.json()) as ReplyCapState;
    if (!Number.isSafeInteger(body.sent) || body.sent < 0 ||
        (body.cap !== null && (!Number.isSafeInteger(body.cap) || body.cap < 0 || body.cap > 500)) ||
        (body.remaining !== null && (!Number.isSafeInteger(body.remaining) || body.remaining < 0))) {
      throw new Error("invalid browser reply cap response");
    }
    return body;
  }

  fetchReplyCap(): Promise<ReplyCapState> { return this.replyCapRequest(); }
  setReplyCap(cap: number | null): Promise<ReplyCapState> { return this.replyCapRequest(cap); }

  async fetchQueue(): Promise<ActionableLinkedInResponse> {
    const url = `${this.config.apiBaseUrl}/api/actionable-linkedin?instanceId=${encodeURIComponent(this.config.instanceId)}`;
    const res = await this.ok(await this.fetchImpl(url, { headers: this.headers() }));
    return ActionableLinkedInResponseSchema.parse(await res.json());
  }

  async fetchApprovalState(approvalId: string): Promise<{ status: string; autosend_pending: boolean }> {
    const url = `${this.config.apiBaseUrl}/api/actuator/approval-state/${encodeURIComponent(approvalId)}`;
    const res = await this.ok(await this.fetchImpl(url, { headers: this.headers() }));
    const body = (await res.json()) as { status?: unknown; autosend_pending?: unknown };
    if (typeof body.status !== "string" || typeof body.autosend_pending !== "boolean") {
      throw new Error("invalid approval-state response");
    }
    return { status: body.status, autosend_pending: body.autosend_pending };
  }

  async fetchDiscoveryTarget(): Promise<DiscoveryTarget | null> {
    const url = `${this.config.apiBaseUrl}/api/actuator/discovery-target?instanceId=${encodeURIComponent(this.config.instanceId)}`;
    const res = await this.ok(await this.fetchImpl(url, { headers: this.headers() }));
    const body = (await res.json()) as { target?: DiscoveryTarget | null };
    return body.target?.url?.startsWith("https://www.linkedin.com/") ? body.target : null;
  }

  async fetchDiscoveryCapacity(): Promise<DiscoveryCapacity> {
    const url = `${this.config.apiBaseUrl}/api/actuator/discovery-capacity?instanceId=${encodeURIComponent(this.config.instanceId)}`;
    const res = await this.ok(await this.fetchImpl(url, { headers: this.headers() }));
    const body = (await res.json()) as Partial<DiscoveryCapacity>;
    if (!Number.isSafeInteger(body.limit) || !Number.isSafeInteger(body.occupied) ||
        !Number.isSafeInteger(body.available) || body.limit !== 5 || body.occupied! < 0 ||
        body.available! !== Math.max(0, body.limit! - body.occupied!)) {
      throw new Error("invalid discovery capacity");
    }
    return body as DiscoveryCapacity;
  }

  async postObservations(items: VisiblePost[]): Promise<{ accepted: number; duplicates: number; invalid: number }> {
    if (items.length === 0) return { accepted: 0, duplicates: 0, invalid: 0 };
    const url = `${this.config.apiBaseUrl}/api/actuator/observations`;
    const res = await this.ok(await this.fetchImpl(url, {
      method: "POST", headers: this.headers(),
      body: JSON.stringify({ instanceId: this.config.instanceId, items }),
    }));
    return (await res.json()) as { accepted: number; duplicates: number; invalid: number };
  }

  async fetchDiscoveryIdentities(fingerprints: string[]): Promise<{ items: PendingDiscoveryIdentity[]; processing: number }> {
    const url = `${this.config.apiBaseUrl}/api/actuator/discovery-identities?instanceId=${encodeURIComponent(this.config.instanceId)}&fingerprints=${encodeURIComponent(JSON.stringify(fingerprints))}`;
    const res = await this.ok(await this.fetchImpl(url, { headers: this.headers() }));
    const body = (await res.json()) as { items?: unknown; processing?: unknown };
    if (!Array.isArray(body.items) || !Number.isInteger(body.processing) || (body.processing as number) < 0) {
      throw new Error("invalid discovery-identities response");
    }
    return { items: body.items.filter((item): item is PendingDiscoveryIdentity =>
      typeof item === "object" && item !== null
      && typeof item.leadId === "string" && typeof item.fingerprint === "string"),
      processing: body.processing as number };
  }

  private async submitDiscoveryIdentity(payload: { leadId: string; fingerprint: string; urn?: string; shortUrl?: string }): Promise<{ resolved: boolean; duplicate: boolean }> {
    const url = `${this.config.apiBaseUrl}/api/actuator/discovery-identities`;
    const res = await this.ok(await this.fetchImpl(url, {
      method: "POST", headers: this.headers(),
      body: JSON.stringify({ instanceId: this.config.instanceId, ...payload }),
    }));
    const body = (await res.json()) as { resolved?: unknown; duplicate?: unknown };
    if (typeof body.resolved !== "boolean" || typeof body.duplicate !== "boolean") {
      throw new Error("invalid discovery-identity response");
    }
    return { resolved: body.resolved, duplicate: body.duplicate };
  }

  resolveDiscoveryIdentity(leadId: string, fingerprint: string, urn: string): Promise<{ resolved: boolean; duplicate: boolean }> {
    return this.submitDiscoveryIdentity({ leadId, fingerprint, urn });
  }

  async resolveDiscoveryShortLink(leadId: string, fingerprint: string, shortUrl: string): Promise<{ resolved: boolean; duplicate: boolean }> {
    const validated = directShortPostUrl(shortUrl);
    if (!validated) throw new Error("invalid LinkedIn short post URL");
    return this.submitDiscoveryIdentity({ leadId, fingerprint, shortUrl: validated });
  }

  async fetchPriorityReady(sinceMs: number): Promise<ActionableLinkedInResponse> {
    const url = `${this.config.apiBaseUrl}/api/actuator/priority-ready?instanceId=${encodeURIComponent(this.config.instanceId)}&since=${sinceMs}&waitMs=25000`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 33_000);
    try {
      const res = await this.ok(await this.fetchImpl(url, { headers: this.headers(), signal: ctrl.signal }));
      return ActionableLinkedInResponseSchema.parse(await res.json());
    } finally {
      clearTimeout(timer);
    }
  }

  /** On-disk build stamp of the unpacked extension, as served by api-vm. Null
   * when the server has no readable stamp (fail-soft: caller does nothing). */
  async fetchExtensionBuild(): Promise<{ stamp: string | null }> {
    const url = `${this.config.apiBaseUrl}/api/actuator/extension-build`;
    const res = await this.ok(await this.fetchImpl(url, { headers: this.headers() }));
    const body = (await res.json()) as { stamp?: unknown };
    return { stamp: typeof body.stamp === "string" ? body.stamp : null };
  }

  async markSent(approvalId: string): Promise<void> {
    const url = `${this.config.apiBaseUrl}/api/actuator/mark-sent/${encodeURIComponent(approvalId)}`;
    await this.ok(await this.fetchImpl(url, { method: "POST", headers: this.headers(), body: JSON.stringify({ sent_via: "extension" }) }));
  }

  /** Reserve a post across every actor before any browser comment attempt. */
  async claimComment(approvalId: string): Promise<{ claimed: boolean; reason?: string }> {
    const url = `${this.config.apiBaseUrl}/api/actuator/claim-comment/${encodeURIComponent(approvalId)}`;
    const res = await this.ok(await this.fetchImpl(url, { method: "POST", headers: this.headers() }));
    const body = (await res.json()) as { claimed?: unknown; reason?: unknown };
    if (typeof body.claimed !== "boolean" || (body.reason !== undefined && typeof body.reason !== "string")) {
      throw new Error("invalid claim-comment response");
    }
    return { claimed: body.claimed, ...(typeof body.reason === "string" ? { reason: body.reason } : {}) };
  }

  // Mark an approval `skipped` server-side (nothing was posted). The extension
  // calls this when the target post/profile is permanently gone ("This post
  // cannot be displayed") so the queue stops re-serving the dead permalink on
  // every future run — without it the approval stays 'pending' forever (markSent
  // only fires on a real post) and each new session re-navigates to the dead post
  // and drops it again. Best-effort at the call site (a failure just means it gets
  // re-served next session, same as before).
  async markSkipped(approvalId: string, reason: string): Promise<void> {
    const url = `${this.config.apiBaseUrl}/api/actuator/mark-skipped/${encodeURIComponent(approvalId)}`;
    await this.ok(await this.fetchImpl(url, { method: "POST", headers: this.headers(), body: JSON.stringify({ reason }) }));
  }

  // Flip the master reply switch (reply_send_enabled) for this instance. Called
  // with enabled=true when the operator starts a Run/Drain (so approved replies
  // flow without a dashboard toggle) and enabled=false when the run ends. `this.ok`
  // throws on non-2xx so callers can decide fatal vs best-effort.
  async enableSend(instanceId: string, enabled: boolean): Promise<void> {
    const url = `${this.config.apiBaseUrl}/api/actuator/enable-send`;
    await this.ok(await this.fetchImpl(url, { method: "POST", headers: this.headers(), body: JSON.stringify({ instanceId, enabled }) }));
  }

  async approveDm(draftId: string): Promise<void> {
    const url = `${this.config.apiBaseUrl}/api/drafts/${encodeURIComponent(draftId)}/approve-dm`;
    await this.ok(await this.fetchImpl(url, { method: "POST", headers: this.headers(), body: "{}" }));
  }

  // Server-side actuator health gate for lights-out auto-start. `this.ok` throws
