import type { EngagementKind } from "./engagement.js";

// Shared engine vocabulary (unchanged from the LinkedIn actuator): "comment" is
// the generic write action — for the X actuator it posts a REPLY. "dm" is never
// planned for X (X DMs stay manual), so caps.dms below is inert here.
export type ActionKind = "like" | "comment" | "dm";

export interface ActuatorConfig {
  apiBaseUrl: string;     // api-vm base, e.g. http://127.0.0.1:18791
  token: string;          // static actuator bearer token
  instanceId: string;     // X (Vega) agent instance id
  /**
   * The operator's own @handle (no @). Only a FALLBACK for the notifications
   * sweep, which normally reads the handle straight off the logged-in page —
   * it decides which notifications are "replies to me", so a wrong value would
   * silently harvest nothing. Leave unset unless the DOM read is failing.
   */
  selfHandle?: string;
  caps: { likes: number; comments: number; dms: number }; // daily backstop ceilings (dms inert for X)
  maxWritesPerHour?: number;      // hard ceiling on reply actions per rolling hour (default 8; see x-actuator-plan: 3-4 for X)
  preferWatchlistRatio: number;   // 0..1 share of likes aimed at watchlist authors
  // Engagement mix for feed likes: per-kind relative weights that override the
  // defaults in lib/engagement (default like=100 / bookmark=0 / repost=0 ⇒ ALWAYS
  // a plain Like until the operator opts in). A 0 disables a kind; all-zero ⇒ Like.
  // NOTE: repost is PUBLIC amplification — only raise its weight deliberately.
  engagementWeights?: Partial<Record<EngagementKind, number>>;
  deepNightTaper: boolean;
  ambientReadActions?: boolean;   // expand "…more" + open comments while idle-browsing (default ON; read-only, non-counted)
  // After a successful reply, also like the tweet just replied to (best-effort,
  // uncounted against the like target). DEFAULT OFF — unlike LinkedIn (where the
  // reply-coupled like ships always-on), likes on X are a higher-risk behavioral
  // write with no server cap (docs/x-account-safety.md), so this is opt-in.
  replyAlsoLikes?: boolean;
  drainShortBandProb?: number;    // Drain mode: share of inter-reply gaps drawn from the short 20–60s band vs 60–120s (default 0.55)
  // Lights-out autonomy: auto-start one run per day inside the operating window.
  autonomous?: boolean;
  // Lights-out inbox clearing: whenever the server serves approved replies and
  // nothing is running, auto-start a drain (not once-per-day). Default OFF.
  autoDrain?: boolean;
  // Stalled-run recovery: if a run is "running" but makes no progress for this
  // many minutes while drafts are loaded + comment slots overdue, supersede it
  // with a fresh drain (shouldRecoverStalledRun). Requires autoDrain. Default 20.
  stallRecoverMinutes?: number;
  autoStartHour?: number;         // operating window start hour, local (default 9)
  autoEndHour?: number;           // operating window end hour, local (default 21)
  autoWindowHours?: number;       // run window length in hours (default 8)
  autoTargetComments?: number;    // daily auto-run comment target (default 20)
  autoTargetLikes?: number;       // daily auto-run like target (default 40)
  challengeCooldownDays?: number; // days to skip auto-start after a challenge halt (default 3)
  healthGate?: boolean;           // require server /health status 'ok' before auto-start (default true)
  autoChallengeBackoffDays?: number; // extra post-challenge auto-start backoff, in shouldAutoStart (default undefined/0 = OFF)
  // Chrome Bridge observability sink (docs/chrome-bridge.md). Observability only;
  // never touches the send path. Defaults: bridgeUrl http://127.0.0.1:18792,
  // bridgeSink ON. Set bridgeSink:false to disable log/heartbeat mirroring.
  bridgeUrl?: string;
  bridgeSink?: boolean;
}

export interface RunParams {
  windowHours: number;
  targetComments: number;
  targetLikes: number;
}

export interface PlannedAction {
  kind: ActionKind;
  atMs: number;           // absolute epoch ms to fire
}
