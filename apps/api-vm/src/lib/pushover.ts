import { PushoverError, sendPushover as sendBoundedPushover } from "@noelle/runtime";
import { loadEnv } from "../env.js";

// Thin Pushover client. Soft-fail: a Pushover outage MUST NOT bubble up to
// the drafter — the draft is already saved and the dashboard is the canonical
// review surface. Complete provider acceptance is required for `{ ok: true }`.

export type PushoverArgs = {
  /** The shared client limits titles to 250 characters. */
  title: string;
  /** The shared client limits messages to 1024 characters. */
  message: string;
  url?: string;
  /** -2 (lowest) … 2 (emergency). Default 0. */
  priority?: -2 | -1 | 0 | 1 | 2;
  /** The shared client limits link titles to 100 characters. */
  urlTitle?: string;
};

export type PushoverResult = { ok: boolean; reason?: string };

export async function sendPushover(args: PushoverArgs): Promise<PushoverResult> {
  const env = loadEnv();
  if (!env.PUSHOVER_USER_KEY || !env.PUSHOVER_APP_TOKEN) {
    return { ok: false, reason: "pushover_not_configured" };
  }

  try {
    await sendBoundedPushover({
      token: env.PUSHOVER_APP_TOKEN,
      user: env.PUSHOVER_USER_KEY,
      title: args.title,
      message: args.message,
      priority: args.priority ?? 0,
      ...(args.url ? { url: args.url } : {}),
      ...(args.urlTitle ? { url_title: args.urlTitle } : {}),
    }, undefined, { timeoutMs: 5_000 });
    return { ok: true };
  } catch (error) {
    const status = error instanceof PushoverError ? error.status : undefined;
    return { ok: false, reason: status !== undefined && (status < 200 || status >= 300)
      ? `pushover_http_${status}` : "pushover_not_accepted" };
  }
}
