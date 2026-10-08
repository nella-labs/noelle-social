import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { createServerClient } from "@supabase/ssr";

export type SessionSnapshot = {
  url: string;
  anonKey: string;
  cookieName: string;
  cookies: { name: string; value: string }[];
};
export type ApiSessionErrorCode = "busy" | "closed" | "timeout" | "unavailable" | "cleanup_failed" | "invalid_request" | "invalid_response";
export class ApiSessionError extends Error {
  constructor(readonly code: ApiSessionErrorCode) {
    super(`API session ${code}`); this.name = "ApiSessionError";
  }
}
type Item = {
  snapshot: SessionSnapshot;
  deadline: number;
  deadlineNs: bigint;
  timer: NodeJS.Timeout;
  worker?: Worker;
  stopping?: Promise<void>;
  resolve(value: unknown): void;
  reject(error: ApiSessionError): void;
};

/** Fresh SDK threads isolate refresh retries; admission includes queue and startup time. */
export class ApiSessionOwner {
  private queue: Item[] = [];
  private active = new Set<Item>();
  private closed = false;

  request(snapshot: SessionSnapshot, timeoutMs = 8_000): Promise<unknown> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 8_000) return Promise.reject(new ApiSessionError("invalid_request"));
    if (this.closed) return Promise.reject(new ApiSessionError("closed"));
    if (this.active.size + this.queue.length >= 32) return Promise.reject(new ApiSessionError("busy"));
    return new Promise((resolve, reject) => {
      const item: Item = {
        snapshot, resolve, reject, deadline: performance.now() + timeoutMs,
        deadlineNs: process.hrtime.bigint() + BigInt(timeoutMs) * 1_000_000n,
        timer: setTimeout(() => { void this.expire(item); }, timeoutMs),
      };
      this.queue.push(item); this.pump();
    });
  }

  private pump(): void {
    while (!this.closed && this.active.size < 4 && this.queue.length) {
      const item = this.queue.shift()!;
      if (performance.now() >= item.deadline) {
        clearTimeout(item.timer); item.reject(new ApiSessionError("timeout")); continue;
      }
      this.active.add(item);
      try {
        // Keep the worker's SDK dependency in the compiled server trace.
        if (typeof createServerClient !== "function") throw new ApiSessionError("unavailable");
        const worker = new Worker(join(process.cwd(), "src/lib/supabase/api-session-worker.mjs"), {
          workerData: {
            ...item.snapshot, deadlineNs: item.deadlineNs,
          },
          resourceLimits: { maxOldGenerationSizeMb: 64 },
          stdout: true, stderr: true,
          name: "noelle-api-session",
        });
        item.worker = worker;
        worker.stdout?.resume(); worker.stderr?.resume();
        worker.once("message", value => {
          if (item.stopping) return;
          void this.stop(item, value, performance.now() >= item.deadline ? "timeout" : undefined);
        });
        worker.once("error", () => { void this.stop(item, undefined, "unavailable"); });
        worker.once("exit", () => { if (!item.stopping) void this.stop(item, undefined, "unavailable"); });
      } catch {
        void this.stop(item, undefined, "unavailable");
      }
    }
  }

  private expire(item: Item): Promise<void> {
    if (this.active.has(item)) return this.stop(item, undefined, "timeout");
    const index = this.queue.indexOf(item);
    if (index >= 0) {
      this.queue.splice(index, 1); item.reject(new ApiSessionError("timeout"));
    }
    return Promise.resolve();
  }

  private stop(item: Item, value?: unknown, code?: ApiSessionErrorCode): Promise<void> {
    if (item.stopping) return item.stopping;
    if (!this.active.has(item)) return Promise.resolve();
    item.stopping = Promise.resolve().then(async () => {
      try { await item.worker?.terminate(); }
      catch {
        code = "cleanup_failed"; this.closed = true;
        for (const queued of this.queue.splice(0)) {
          clearTimeout(queued.timer); queued.reject(new ApiSessionError("cleanup_failed"));
        }
      }
      if (!code && performance.now() >= item.deadline) code = "timeout";
      clearTimeout(item.timer); this.active.delete(item);
      if (code) item.reject(new ApiSessionError(code)); else item.resolve(value);
      this.pump();
    });
    return item.stopping;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const item of this.queue.splice(0)) {
      clearTimeout(item.timer); item.reject(new ApiSessionError("closed"));
    }
    await Promise.all([...this.active].map(item => this.stop(item, undefined, "closed")));
  }
}
