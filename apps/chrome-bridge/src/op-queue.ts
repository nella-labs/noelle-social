import { randomUUID } from "node:crypto";
import type { ChromeOp, ChromeOpResult, OpRequest } from "@noelle/contracts";

export interface ExtInfo {
  extId: string;
  extVersion: string;
  chromeVersion?: string;
  buildStamp?: string;
}

interface Pending {
  op: ChromeOp;
  resolve: (r: ChromeOpResult) => void;
  timer: ReturnType<typeof setTimeout>;
  enqueuedAt: number;
}

export interface OpQueueStatus {
  connected: boolean;
  extVersion?: string;
  chromeVersion?: string;
  lastPollAt: number | null;
  queued: number;
  pending: number;
}

// Default: treat the extension as disconnected if it hasn't polled this long.
const CONNECTED_WINDOW_MS = 10_000;

// In-memory op dispatch core (no external deps). enqueue() parks a promise and
// queues the op for the ext to drain on its next GET /ext/poll; report()
// (driven by POST /ext/result) resolves the parked promise. A never-reported op
// RESOLVES — it does not reject — to a uniform timeout result after
// opTimeoutMs, so every caller sees the same ChromeOpResult shape.
export class OpQueue {
  private queued: OpRequest[] = [];
  private readonly pending = new Map<string, Pending>();
  private lastPollAt: number | null = null;
  private ext: ExtInfo | null = null;
  private readonly opTimeoutMs: number;
  private readonly connectedWindowMs: number;
  private readonly now: () => number;

  constructor(opts: { opTimeoutMs: number; connectedWindowMs?: number; now?: () => number }) {
    this.opTimeoutMs = opts.opTimeoutMs;
    this.connectedWindowMs = opts.connectedWindowMs ?? CONNECTED_WINDOW_MS;
    this.now = opts.now ?? Date.now;
  }

  enqueue(op: ChromeOp): Promise<ChromeOpResult> {
    const id = randomUUID();
    const enqueuedAt = this.now();
    return new Promise<ChromeOpResult>((resolve) => {
      const timer = setTimeout(() => {
        this.expire(id);
      }, this.opTimeoutMs);
      // Don't let a parked op keep the process alive on its own.
      if (typeof timer.unref === "function") timer.unref();
      this.pending.set(id, { op, resolve, timer, enqueuedAt });
      this.queued.push({ id, op });
    });
  }

  // GET /ext/poll: hand the ext unexpired queued work and clear it. The poll itself
  // refreshes the connected clock — an empty poll still counts as "alive".
  drainForExt(): OpRequest[] {
    this.lastPollAt = this.now();
    if (this.queued.length === 0) return [];
    const queued = this.queued;
    this.queued = [];
    const batch = queued.filter(({ id }) => {
      const pending = this.pending.get(id);
      if (!pending) return false;
      if (this.now() - pending.enqueuedAt < this.opTimeoutMs) return true;
      this.expire(id);
      return false;
    });
    return batch;
  }

  // POST /ext/result: resolve the parked promise. Returns false for an
  // unknown/expired id (already timed out or never seen).
  report(id: string, result: ChromeOpResult): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    if (this.now() - p.enqueuedAt >= this.opTimeoutMs) {
      this.expire(id);
      return false;
    }
    clearTimeout(p.timer);
    this.pending.delete(id);
    const tookMs = result.tookMs ?? this.now() - p.enqueuedAt;
    p.resolve({ ...result, tookMs });
    return true;
  }

  private expire(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    this.queued = this.queued.filter((request) => request.id !== id);
    pending.resolve({ ok: false, error: "op timeout", tookMs: this.now() - pending.enqueuedAt });
  }

  // POST /ext/hello: record ext identity. A hello also refreshes the clock.
  hello(info: ExtInfo): void {
    this.ext = info;
    this.lastPollAt = this.now();
  }

  isConnected(): boolean {
    return this.lastPollAt !== null && this.now() - this.lastPollAt <= this.connectedWindowMs;
  }

  status(): OpQueueStatus {
    const status: OpQueueStatus = {
      connected: this.isConnected(),
      lastPollAt: this.lastPollAt,
      queued: this.queued.length,
      pending: this.pending.size,
    };
    if (this.ext?.extVersion) status.extVersion = this.ext.extVersion;
    if (this.ext?.chromeVersion) status.chromeVersion = this.ext.chromeVersion;
    return status;
  }
}
