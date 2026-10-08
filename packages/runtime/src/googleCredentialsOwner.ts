import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { killProcessGroup } from "@noelle/process";
import type { GoogleAuthOptions } from "google-auth-library";

export type CredentialOperation = "token" | "metadata" | "sign";
export type CredentialErrorCode = "busy" | "closed" | "timeout" | "failed" | "cleanup_failed" | "invalid_request" | "invalid_response";
export class GoogleCredentialError extends Error {
  constructor(readonly code: CredentialErrorCode, readonly operation: CredentialOperation) {
    super(`Google credential ${operation} ${code}`); this.name = "GoogleCredentialError";
  }
}
export type GoogleCredentialOptions = {
  authOptions?: Omit<GoogleAuthOptions, "authClient">;
  /** Explicit Compute metadata credentials; omitted options preserve default ADC discovery. */
  compute?: boolean;
  metadataHost?: string;
  timeoutMs?: number;
  /** Maximum admitted operations, including the active one; at most 32. */
  maxQueue?: number;
  idleMs?: number;
};
type Item = { id: number; operation: CredentialOperation; args: unknown[]; timer: NodeJS.Timeout; deadline: number;
  resolve(value: unknown): void; reject(error: GoogleCredentialError): void; stopping?: boolean };
function bounded(value: number | undefined, fallback: number, max: number): number {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < 1 || n > max) throw new GoogleCredentialError("invalid_request", "token");
  return n;
}

/** One SDK operation at a time; an executing deadline awaits owned process-group termination before rejection. */
export class GoogleCredentialsOwner {
  private worker: ChildProcess | undefined;
  private stopping: Promise<CredentialErrorCode | undefined> | undefined;
  private idle: NodeJS.Timeout | undefined;
  private active: Item | undefined;
  private queue: Item[] = [];
  private sequence = 0;
  private closed = false;
  private readonly timeout: number;
  private readonly maxQueue: number;
  private readonly idleMs: number;
  private readonly options: GoogleCredentialOptions;
  constructor(options: GoogleCredentialOptions) {
    if (process.platform === "win32") throw new GoogleCredentialError("invalid_request", "token");
    this.timeout = bounded(options.timeoutMs, 8000, 30000);
    this.maxQueue = bounded(options.maxQueue, 32, 32);
    this.idleMs = bounded(options.idleMs, 30000, 300000);
    try { this.options = structuredClone(options); }
    catch { throw new GoogleCredentialError("invalid_request", "token"); }
  }
  request(operation: CredentialOperation, args: unknown[], timeoutMs?: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new GoogleCredentialError("closed", operation));
    if (this.queue.length + Number(!!this.active) >= this.maxQueue) return Promise.reject(new GoogleCredentialError("busy", operation));
    let timeout: number;
    try { timeout = bounded(timeoutMs, this.timeout, 30000); }
    catch { return Promise.reject(new GoogleCredentialError("invalid_request", operation)); }
    return new Promise((resolve, reject) => {
      const item: Item = { id: ++this.sequence, operation, args, resolve, reject, deadline: performance.now() + timeout,
        timer: setTimeout(() => { void this.expire(item); }, timeout) };
      this.queue.push(item); this.pump();
    });
  }
  private async expire(item: Item): Promise<void> {
    if (this.active === item) {
      if (item.stopping) return;
      item.stopping = true;
      const failure = await this.stopWorker();
      this.finish(item, failure ?? "timeout");
    } else {
      const index = this.queue.indexOf(item);
      if (index < 0) return;
      this.queue.splice(index, 1); item.reject(new GoogleCredentialError("timeout", item.operation));
    }
  }
  private startWorker(): ChildProcess {
    if (this.worker) return this.worker;
    const worker = spawn(process.execPath, ["--max-old-space-size=64", fileURLToPath(new URL("./googleCredentialsWorker.mjs", import.meta.url))], {
      detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced",
      ...(this.options.metadataHost ? { env: { ...process.env, GCE_METADATA_HOST: this.options.metadataHost } } : {}),
    });
    worker.on("message", (message: { id?: number; code?: CredentialErrorCode; value?: unknown }) => {
      const item = this.active;
      if (worker !== this.worker || !item || item.stopping || message.id !== item.id) return;
      if (performance.now() >= item.deadline) { void this.expire(item); return; }
      this.finish(item, message.code, message.value);
    });
    worker.on("error", () => { void this.workerFailed(worker); });
    worker.on("exit", () => { void this.workerFailed(worker); });
    this.worker = worker;
    worker.send({ authModule: createRequire(import.meta.url).resolve("google-auth-library"),
      authOptions: this.options.authOptions ?? { scopes: ["https://www.googleapis.com/auth/cloud-platform"] },
      compute: this.options.compute ?? false });
    return worker;
  }
  private async workerFailed(worker: ChildProcess): Promise<void> {
    if (worker !== this.worker || this.active?.stopping) return;
    const item = this.active;
    if (item) item.stopping = true;
    const failure = await this.stopWorker();
    if (item) this.finish(item, failure ?? "failed");
  }
  private pump(): void {
    if (this.closed || this.active || this.stopping) return;
    clearTimeout(this.idle);
    let item = this.queue.shift();
    while (item && performance.now() >= item.deadline) {
      clearTimeout(item.timer); item.reject(new GoogleCredentialError("timeout", item.operation));
      item = this.queue.shift();
    }
    if (!item) {
      if (!this.worker) return;
      this.worker.unref(); this.worker.channel?.unref();
      this.idle = setTimeout(() => { void this.stopWorker().then(() => this.pump()); }, this.idleMs);
      this.idle.unref(); return;
    }
    this.active = item;
    try {
      const worker = this.startWorker(); worker.ref(); worker.channel?.ref();
      worker.send({ id: item.id, operation: item.operation, args: item.args });
    } catch {
      if (this.worker) void this.workerFailed(this.worker);
      else if (!item.stopping) this.finish(item, "failed");
    }
  }
  private finish(item: Item, code?: CredentialErrorCode, value?: unknown): void {
    if (this.active !== item) return;
    clearTimeout(item.timer); this.active = undefined;
    if (code) item.reject(new GoogleCredentialError(code, item.operation)); else item.resolve(value);
    this.pump();
  }
  private rejectQueued(code: CredentialErrorCode): void {
    for (const item of this.queue.splice(0)) { clearTimeout(item.timer); item.reject(new GoogleCredentialError(code, item.operation)); }
  }
  private stopWorker(): Promise<CredentialErrorCode | undefined> {
    if (this.stopping) return this.stopping;
    clearTimeout(this.idle);
    const worker = this.worker; this.worker = undefined;
    if (!worker) return Promise.resolve(undefined);
    const closed = new Promise<void>(resolve => {
      if (worker.exitCode !== null || worker.signalCode !== null) resolve();
      else worker.once("close", () => resolve());
    });
    let failure: CredentialErrorCode | undefined;
    if (worker.pid) {
      try { killProcessGroup(worker.pid); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          failure = "cleanup_failed"; this.closed = true; this.rejectQueued(failure); worker.kill("SIGKILL");
        }
      }
    }
    this.stopping = closed.then(() => failure).finally(() => { this.stopping = undefined; });
    return this.stopping;
  }
  async close(): Promise<void> {
    this.closed = true; clearTimeout(this.idle);
    this.rejectQueued("closed");
    const item = this.active; if (item) item.stopping = true;
    const failure = await this.stopWorker(); if (item) this.finish(item, failure ?? "closed");
    if (failure) throw new GoogleCredentialError(failure, item?.operation ?? "token");
  }
}
