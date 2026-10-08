/**
 * Helper for calling the Hono service at api.trynoelle.com.
 *
 * Forwards the user's Supabase JWT (per docs/architecture.md § 5 Auth layers).
 * Server-side only — must be called from Server Actions or Route Handlers
 * so we can read the session cookie.
 */

import { getApiSessionAccessToken } from "@/lib/supabase/api-session";
import { ApiSessionError } from "@/lib/supabase/api-session-owner";
import { isLocalAuth, localOperatorJwt } from "@/lib/local-auth";
import { createBoundedHttpFetch, HttpBodyError } from "@noelle/runtime/bounded-http";

const BASE = process.env.NOELLE_API_BASE_URL ?? "https://api.trynoelle.com";

export class NoelleApiError extends Error {
  /**
   * When the server emits a 429, this carries the `retry_after_ms` field
   * from the rate-limited envelope (or the parsed Retry-After header in
   * seconds, in ms). undefined for non-429 errors.
   */
  public retryAfterMs?: number;

  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
    opts?: { retryAfterMs?: number },
  ) {
    super(message);
    this.name = "NoelleApiError";
    this.retryAfterMs = opts?.retryAfterMs;
  }
}

interface FetchOpts {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  /** Force-skip auth header (only for /health). */
  skipAuth?: boolean;
  /** Deadline covers session preparation, dispatch and the complete response body. */
  timeoutMs?: number;
}

export async function noelleFetch<T>(path: string, opts: FetchOpts = {}): Promise<T> {
  const started = performance.now();
  // Validate through the HTTP owner before auth work; the timer starts at dispatch.
  if (opts.timeoutMs !== undefined) createBoundedHttpFetch({ timeoutMs: opts.timeoutMs, maxBytes: 65_536 });
  const remaining = () => {
    if (opts.timeoutMs === undefined) return undefined;
    const ms = Math.floor(opts.timeoutMs - (performance.now() - started));
    if (ms < 1) throw new HttpBodyError("timeout", "API request deadline expired during session preparation");
    return ms;
  };
  const { method = "GET", body, skipAuth } = opts;
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  if (!skipAuth) {
    if (isLocalAuth()) {
      // Self-host: forward the CLI-minted operator JWT. api-vm verifies it via
      // the same HS256 path (NOELLE_SUPABASE_JWT_SECRET) it uses for Supabase.
      const jwt = localOperatorJwt();
      if (!jwt) {
        throw new NoelleApiError(
          401,
          "no_local_jwt",
          "NOELLE_LOCAL_OPERATOR_JWT is not set; run `noelle init` to mint one",
        );
      }
      headers.Authorization = `Bearer ${jwt}`;
    } else {
      let token: string | null;
      try { token = await getApiSessionAccessToken(Math.min(8_000, remaining() ?? 8_000)); }
      catch (error) {
        if (!(error instanceof ApiSessionError)) throw error;
        remaining();
        throw new NoelleApiError(503, "session_unavailable", "Authentication is temporarily unavailable");
      }
      if (!token) {
        throw new NoelleApiError(401, "no_session", "No active Supabase session");
      }
      headers.Authorization = `Bearer ${token}`;
    }
  }

  const init: RequestInit = {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  };
  const timeoutMs = remaining();
  const fetchImpl = timeoutMs === undefined ? fetch
    : createBoundedHttpFetch({ timeoutMs, maxBytes: 65_536 });
  const res = await fetchImpl(`${BASE}${path}`, init);

  if (!res.ok) {
    // N2's Hono service returns the flat envelope from @noelle/contracts
    // (ErrorBodySchema): { error: string, detail?: string, request_id?: string }.
    // `error` is the short code (e.g. "not_found"); `detail` is the human message.
    let code = "http_error";
    let message = `${method} ${path} → ${res.status}`;
    let details: unknown;
    let retryAfterMs: number | undefined;
    try {
      const parsed = await res.json();
      if (typeof parsed?.error === "string") {
        code = parsed.error;
        if (typeof parsed.detail === "string") message = parsed.detail;
        if (parsed.request_id) details = { request_id: parsed.request_id };
      }
      // Rate-limit envelope carries retry_after_ms directly.
      if (typeof parsed?.retry_after_ms === "number") {
        retryAfterMs = parsed.retry_after_ms;
      }
    } catch {
      // non-JSON body — keep defaults
    }
    // Fall back to the standard Retry-After header (seconds → ms) when
    // the body didn't carry retry_after_ms.
    if (retryAfterMs === undefined && res.status === 429) {
      const ra = res.headers.get("Retry-After");
      if (ra && /^\d+$/.test(ra.trim())) {
        retryAfterMs = parseInt(ra.trim(), 10) * 1000;
      }
    }
    throw new NoelleApiError(res.status, code, message, details, { retryAfterMs });
  }

  return (await res.json()) as T;
}
