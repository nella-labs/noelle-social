/**
 * Pure, deterministic derivations for the autopilot status panel on Vega's
 * agent page (behind NOELLE_AUTOPILOT_PANEL). Nothing here reads the clock or
 * touches the network — `now`/`nowMs` is always passed in — so it unit-tests
 * cleanly and never re-introduces the VegaSendQueuePanel hydration-abort bug
 * (a render-time Date.now() mismatch between server and client).
 *
 * The panel is REFLECT-ONLY: it labels the true (reply_send_enabled,
 * auto_send_enabled) state so the operator can never mistake "armed but master
 * off" for "off", nor "live autopilot" for "drafting only". It arms nothing and
 * sends nothing.
 */

/** Re-export the display-only quiet-window helper under the name the panel and
 * its tests use, so autopilot readouts share one source of truth with the
 * approvals chip. */
export { quietHoldEndMs as quietUntilMs } from "@/lib/quiet-window";

export type AutopilotState =
  | "off"
  | "drafting-only"
  | "queued-master-off"
  | "live";

/** Semantic tone → maps to a Constellation token in the component. */
export type AutopilotTone = "muted" | "ok" | "warn" | "accent";

export interface AutopilotStatus {
  state: AutopilotState;
  /** Short chip label. */
  label: string;
  tone: AutopilotTone;
  /** One-line honest description of what will (or won't) post. */
  description: string;
}

/**
 * Collapse the two master switches into one honest status the operator reads
 * at a glance. The order of danger:
 *   - reply_send_enabled is the master send gate BOTH send paths fail closed
 *     on (send.ts / actuator.ts): false => nothing posts, period.
 *   - auto_send_enabled is "posts without me clicking" (autopilot).
 *
 * The dangerous, easy-to-misread combo is {reply:false, auto:true} — autopilot
 * looks armed but the master switch silently blocks every send. That returns
 * the amber "Armed — master OFF" warn state so the operator isn't lulled into
 * thinking sends are flowing (or, worse, that they're safely off).
 */
export function deriveAutopilotStatus(input: {
  replySendEnabled: boolean;
  autoSendEnabled: boolean;
}): AutopilotStatus {
  const { replySendEnabled, autoSendEnabled } = input;

  if (autoSendEnabled && replySendEnabled) {
    return {
      state: "live",
      label: "Live · autopilot",
      tone: "ok",
      description:
        "Autopilot is live: the drafter stamps a send time and the worker posts through your token automatically.",
    };
  }
  if (autoSendEnabled && !replySendEnabled) {
    return {
      state: "queued-master-off",
      label: "Armed — master OFF",
      tone: "warn",
      description:
        "Autopilot is armed, but the master send switch is off — nothing posts until you turn sending on.",
    };
  }
  if (!autoSendEnabled && replySendEnabled) {
    return {
      state: "drafting-only",
      label: "Drafting only",
      tone: "accent",
      description:
        "Sending is on, but autopilot is off: replies post only when you approve and send them.",
    };
  }
  return {
    state: "off",
    label: "Off",
    tone: "muted",
    description:
      "Sending and autopilot are both off. Drafts still queue for your approval — nothing posts.",
  };
}

/**
 * Earliest upcoming send time across a set of stamped rows, as an ISO string,
 * or null when there is nothing scheduled. Rows may arrive unordered; rows with
 * an unparseable `targetAt` are skipped rather than poisoning the min (a NaN
 * comparison would otherwise silently win or lose depending on order). Pure:
 * no clock read — it reports the earliest STAMP, not a countdown.
 */
export function nextSendTargetAt(
  rows: ReadonlyArray<{ targetAt: string }>,
): string | null {
  let bestMs = Infinity;
  let bestIso: string | null = null;
  for (const row of rows) {
    const ms = new Date(row.targetAt).getTime();
    if (Number.isNaN(ms)) continue;
    if (ms < bestMs) {
      bestMs = ms;
      bestIso = row.targetAt;
    }
  }
  return bestIso;
}
