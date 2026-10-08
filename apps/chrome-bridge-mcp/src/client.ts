import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  decodeHttpText,
  fetchBoundedHttpResponse,
  HttpBodyError,
  type BoundedHttpOptions,
} from "@noelle/runtime/bounded-http";
import type {
  BridgeHealth,
  ChromeOp,
  ChromeOpResult,
  HeartbeatStatus,
  LogQueryResult,
} from "@noelle/contracts";

// Thin HTTP client for the Chrome Bridge control server (apps/chrome-bridge,
// 127.0.0.1:18792). The MCP layer turns each chrome_* tool into one of these
// calls. Every method returns either the route's success payload or a
// structured BridgeError so a dead bridge becomes actionable data instead of an
// uncaught rejection. Uses global fetch (Node >= 18); no logging here — stdout
// is the JSON-RPC channel and errors travel back as return values.

const DEFAULT_BRIDGE_URL = "http://127.0.0.1:18792";

// Uniform client-level failure. `ok:false` lets the MCP layer flag isError with
// a single check (and lines up with ChromeOpResult.ok for op failures). `hint`
// nudges the agent toward the fix.
export interface BridgeError {
  ok: false;
  error: string;
  hint?: string;
  code?: HttpBodyError["code"];
  status?: number;
}

function statusHint(status: number | undefined): string | undefined {
  if (status === 503) {
    return "503: the bridge is up but the Chrome extension is not connected. Load/enable the chrome-bridge-ext at chrome://extensions.";
  }
  if (status === 401) return "401: NOELLE_BRIDGE_TOKEN is missing or wrong for this bridge.";
  if (status === 504) return "504: the op timed out inside the extension (the tab may be busy or gone).";
  return undefined;
}

// GET /heartbeats response shape.
export interface HeartbeatsResult {
  sources: HeartbeatStatus[];
}

export interface LogQuery {
  source?: string;
  sinceMs?: number;
  level?: string;
  grep?: string;
  limit?: number;
}

export class BridgeClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly httpOptions: Pick<BoundedHttpOptions, "timeoutMs" | "maxBytes">;

  constructor(options: Pick<BoundedHttpOptions, "timeoutMs" | "maxBytes"> = {}) {
    this.baseUrl = (process.env.NOELLE_BRIDGE_URL || DEFAULT_BRIDGE_URL).replace(/\/+$/, "");
    this.token = process.env.NOELLE_BRIDGE_TOKEN || undefined;
    // Allow the bridge's normal 20s op result; bound screenshots and all other
    // responses through the same canonical full-body HTTP owner.
    this.httpOptions = {
      timeoutMs: options.timeoutMs ?? 30_000,
      maxBytes: options.maxBytes ?? 16 * 1024 * 1024,
    };
  }

  private headers(hasBody: boolean): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    if (hasBody) h["content-type"] = "application/json";
    return h;
  }

  // The one place fetch happens. Network failure -> BridgeError with a "bridge
  // may not be running" hint; non-2xx -> BridgeError carrying the bridge's own
  // error message when it sent one.
  private async request<T>(
    method: "GET" | "POST",
    path: string,
    opts: { body?: unknown; query?: Record<string, string | number | undefined> } = {},
  ): Promise<T | BridgeError> {
    let url = `${this.baseUrl}${path}`;
    if (opts.query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== "") qs.set(k, String(v));
      }
      const s = qs.toString();
      if (s) url += `?${s}`;
    }

    const hasBody = opts.body !== undefined;
    let res: Response;
    let rawText: string;
    try {
      const received = await fetchBoundedHttpResponse(url, {
        method,
        headers: this.headers(hasBody),
        body: hasBody ? JSON.stringify(opts.body) : undefined,
      }, this.httpOptions);
      res = received.response;
      rawText = decodeHttpText(received.bytes);
    } catch (err) {
      if (err instanceof RangeError) {
        return { ok: false, error: `Invalid Bridge HTTP options: ${err.message}` };
      }
      const msg = err instanceof HttpBodyError ? err.message : "HTTP request failed";
      const status = err instanceof HttpBodyError ? err.status : undefined;
      const hint = statusHint(status) ?? (status === undefined
        ? "The bridge may not be running. Start it with `noelle bridge start`."
        : undefined);
      const failure: BridgeError = {
        ok: false,
        error: status === undefined
          ? `Cannot reach the Chrome Bridge at ${this.baseUrl} (${msg}).`
          : `Bridge ${method} ${path} -> HTTP ${status}: ${msg}`,
      };
      if (err instanceof HttpBodyError) failure.code = err.code;
      if (status !== undefined) failure.status = status;
      if (hint) failure.hint = hint;
      return failure;
    }

    if (!res.ok) {
      let detail = rawText.slice(0, 500);
      try {
        const j = JSON.parse(rawText) as unknown;
        if (j && typeof j === "object" && "error" in j) detail = String((j as { error: unknown }).error);
      } catch {
        // keep the raw text
      }
      const err: BridgeError = {
        ok: false,
        error: `Bridge ${method} ${path} -> HTTP ${res.status}: ${detail || res.statusText}`,
      };
      const hint = statusHint(res.status);
      if (hint) err.hint = hint;
      return err;
    }

    if (!rawText) return {} as T;
    try {
      return JSON.parse(rawText) as T;
    } catch {
      return {
        ok: false,
        error: `Bridge ${path} returned non-JSON: ${rawText.slice(0, 200)}`,
      };
    }
  }

  // POST /op — the whole Chrome control surface. `op` is a validated ChromeOp.
  op(op: ChromeOp): Promise<ChromeOpResult | BridgeError> {
    return this.request<ChromeOpResult>("POST", "/op", { body: op });
  }

  // GET /logs — the actuator log sink.
  logs(query: LogQuery = {}): Promise<LogQueryResult | BridgeError> {
    return this.request<LogQueryResult>("GET", "/logs", {
      query: {
        source: query.source,
        sinceMs: query.sinceMs,
        level: query.level,
        grep: query.grep,
        limit: query.limit,
      },
    });
  }

  // GET /heartbeats — latest heartbeat per actuator source (age + stale flag).
  heartbeats(): Promise<HeartbeatsResult | BridgeError> {
    return this.request<HeartbeatsResult>("GET", "/heartbeats");
  }

  // GET /health — the bridge itself (ext_connected, versions, uptime). No auth.
  health(): Promise<BridgeHealth | BridgeError> {
    return this.request<BridgeHealth>("GET", "/health");
  }

  // The actuator-doctor writes its latest snapshot to disk; read it back. Absent
  // file -> a helpful BridgeError (the doctor has not run yet), not a throw.
  async doctorReport(): Promise<unknown> {
    const path = join(homedir(), ".noelle", "doctor", "last-report.json");
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e && e.code === "ENOENT") {
        return {
          ok: false,
