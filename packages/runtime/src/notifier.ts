import { SecretAccessError, type SecretsClient } from "@noelle/secrets";
import { PushoverError, sendPushover } from "./pushoverClient.js";
export { createAlertOnce, type AlertTarget, type AlertOnceResult } from "./notifierAlerts.js";

/**
 * Per-org notification dispatcher, consolidated from the four per-app copies
 * that lived at apps/{x,linkedin,reddit,video}-intern/src/lib/notifications.ts.
 * Only Pushover is wired today. Used by the classifier to optionally ping the
 * operator when it skips a borderline lead (notify_low_confidence).
 *
 * Returns `{ status: 'no_channel' }` WITHOUT throwing when no keys exist, so an
 * org that never configured Pushover is a silent no-op rather than an error on
 * the classifier's happy path.
 *
 * The four copies were behaviourally identical — same channel resolution, same
 * no_channel / error / swallow semantics. No copy paged on anything another did
 * not, so nothing here is parameterised. The per-agent difference in how NOISY
 * each intern is comes from how many of its workers construct a notifier
 * (Vega 5, Lyra 3, Orion 2, Nova 0), which is a call-site concern.
 */

export interface NotifyArgs {
  orgId: string;
  title: string;
  message: string;
  url?: string;
  url_title?: string;
}

export type NotifyResult =
  | { status: "sent"; channel: "pushover"; request: string }
  | { status: "no_channel"; channel: null; detail: string }
  | { status: "error"; channel: "pushover"; detail: string };

export interface Notifier {
  notify(args: NotifyArgs): Promise<NotifyResult>;
}

export interface PreparedNotification {
  notify(args: Omit<NotifyArgs, "orgId">, options?: { timeoutMs?: number }): Promise<NotifyResult>;
}
export interface PreparedNotifier extends Notifier {
  /** Resolve credentials before acquiring a database notification lease. */
  prepare(orgId: string): Promise<PreparedNotification>;
}

/**
 * Just the two methods the notifier calls. Declared structurally rather than
 * importing `Logger` from @noelle/worker-runtime, so this package needs no
 * dependency on it — every app's pino logger already satisfies this shape.
 */
export interface NotifierLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface CreateNotifierDeps {
  secrets: SecretsClient;
  log: NotifierLogger;
  fetchImpl?: typeof fetch;
}

export function createNotifier(deps: CreateNotifierDeps): PreparedNotifier {
  const prepare = async (orgId: string): Promise<PreparedNotification> => {
    const credentials = await loadPushoverCredentials(deps, orgId);
    return {
      async notify(args, options) {
        if (!credentials) {
          deps.log.info({ orgId }, "notify: no pushover keys for org — no_channel");
          return {
            status: "no_channel",
            channel: null,
            detail: "no pushover keys configured (email/slack land in 0.1.0)",
          };
        }
        try {
          const res = await sendPushover(
            {
              user: credentials.user,
              token: credentials.token,
              title: args.title,
              message: args.message,
              // Conditional spread, not `url: args.url`. The two forms behave
              // identically — sendPushover gates each field with `if (args.url)`
              // in pushoverClient.ts, so absent, undefined and "" all produce the
              // same request body — but this package compiles under
              // exactOptionalPropertyTypes (from tsconfig.base) where the app
              // tsconfigs do not, and the unconditional form is a TS2379 here.
              ...(args.url ? { url: args.url } : {}),
              ...(args.url_title ? { url_title: args.url_title } : {}),
            },
            deps.fetchImpl,
            { timeoutMs: Math.min(8000, options?.timeoutMs ?? 8000) },
          );
          return { status: "sent", channel: "pushover", request: res.request };
        } catch (err) {
          const detail =
            err instanceof PushoverError
              ? `${err.message}${err.status ? ` (${err.status})` : ""}`
              : (err as Error).message;
          deps.log.error({ orgId, err: detail }, "notify: pushover send failed");
          return { status: "error", channel: "pushover", detail };
        }
      },
    };
  };
  return {
    prepare,
    async notify(args) { return (await prepare(args.orgId)).notify(args); },
  };
}

interface PushoverCredentials {
  user: string;
  token: string;
}

async function loadPushoverCredentials(
  deps: CreateNotifierDeps,
  orgId: string,
): Promise<PushoverCredentials | null> {
  const user = await tryGetSecret(deps, orgId, "pushover-user-key");
  const token = await tryGetSecret(deps, orgId, "pushover-token");
  if (!user || !token) return null;
  return { user, token };
}

async function tryGetSecret(
  deps: CreateNotifierDeps,
  orgId: string,
  fragment: string,
): Promise<string | null> {
  try {
    return await deps.secrets.getForOrg(orgId, fragment);
  } catch (err) {
    // A missing secret is the normal "this org has no Pushover" case. Anything
    // else — auth, network, a malformed name — must propagate. Swallowing it
    // would turn a broken secrets client into a permanent silent no_channel,
    // which is the failure mode you least want on an alerting path.
    if (err instanceof SecretAccessError && /NOT_FOUND/.test(err.message)) {
      return null;
    }
    throw err;
  }
}
