import type { ReactionType } from "./reactions.js";

export type ActionKind = "like" | "comment" | "dm";

export interface ActuatorConfig {
  apiBaseUrl: string;     // e.g. https://<lima-tunnel-host>
  token: string;          // static bearer for Lima
  instanceId: string;     // LinkedIn agent instance id
  caps: { likes: number; comments: number; dms: number }; // daily backstop ceilings
  maxWritesPerHour?: number;      // hard ceiling on comment+DM actions per rolling hour (default 8)
  preferWatchlistRatio: number;   // 0..1 share of likes aimed at watchlist authors
  // Reaction mix for feed likes: per-type relative weights that override the
  // defaults in lib/reactions (default inclines to Like, then Support + applause).
  // Omit to use the defaults; a 0 disables a reaction; all-zero ⇒ always Like.
  reactionWeights?: Partial<Record<ReactionType, number>>;
  deepNightTaper: boolean;
  ambientReadActions?: boolean;   // expand "…more" + open comments while idle-browsing (default ON; read-only, non-counted)
  // Lights-out autonomy: auto-start one run per day inside the operating window.
  autonomous?: boolean;
  // Lights-out inbox clearing: whenever the server serves approved comments and
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
