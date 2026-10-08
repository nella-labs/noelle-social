/**
 * Pushover Messages API client. Callers supply per-user and application keys.
 * The shared notifier resolves those keys for the owning organization.
 * API docs: https://pushover.net/api
 */

import { decodeHttpJson, fetchBoundedHttpResponse, HttpBodyError } from "./boundedHttp.js";
const PUSHOVER_API = "https://api.pushover.net/1/messages.json";

export class PushoverError extends Error {
  readonly status: number | undefined;
  readonly body: unknown;
  constructor(message: string, status?: number, body?: unknown) {
    super(message);
    this.name = "PushoverError";
    this.status = status;
    this.body = body;
  }
}

export interface PushoverSendArgs {
  /** Per-user Pushover key (30 chars). */
  user: string;
  /** App-level Pushover API token (30 chars). */
  token: string;
  /** Short title — shown at the top of the notification. <= 250 chars. */
  title: string;
  /** Body text. <= 1024 chars. Longer messages are truncated by Pushover. */
  message: string;
  /** -2 lowest, -1 low, 0 normal, 1 high, 2 emergency. Default 0. */
  priority?: -2 | -1 | 0 | 1 | 2;
  /** Optional clickable URL. */
  url?: string;
  /** Optional title for the URL link. */
  url_title?: string;
}

export interface PushoverSendResult {
  status: number;
  request: string;
}

/**
 * Fire one Pushover notification. Throws PushoverError on non-200
 * responses; the caller decides whether to log + swallow or surface.
 *
 * @param fetchImpl override for testing; defaults to global fetch
 */
export async function sendPushover(
  args: PushoverSendArgs,
  fetchImpl: typeof fetch = fetch,
  options: { timeoutMs?: number } = {},
): Promise<PushoverSendResult> {
  const body = new URLSearchParams({
    token: args.token,
    user: args.user,
    title: args.title.slice(0, 250),
    message: args.message.slice(0, 1024),
  });
  if (args.priority != null) body.set("priority", String(args.priority));
  if (args.url) body.set("url", args.url);
  if (args.url_title) body.set("url_title", args.url_title.slice(0, 100));

  let received: Awaited<ReturnType<typeof fetchBoundedHttpResponse>>;
  try {
    received = await fetchBoundedHttpResponse(PUSHOVER_API, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    }, { fetchImpl, timeoutMs: options.timeoutMs ?? 8000, maxBytes: 65_536 });
  } catch (err) {
    throw new PushoverError(
      `pushover request: ${err instanceof HttpBodyError ? err.message : "failed"}`,
      err instanceof HttpBodyError ? err.status : undefined,
    );
  }

  let payload: unknown;
  try {
    payload = decodeHttpJson(received.bytes);
  } catch {
    payload = null;
  }

  const res = received.response;
  if (!res.ok) {
    throw new PushoverError(`pushover ${res.status}`, res.status);
  }
  const receipt = payload as { status?: unknown; request?: unknown } | null;
  if (receipt?.status !== 1 || typeof receipt.request !== "string" || !receipt.request.trim()) {
    throw new PushoverError("pushover returned an invalid acceptance receipt", res.status);
  }
  return { status: 1, request: receipt.request };
}
