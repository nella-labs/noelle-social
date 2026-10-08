import type { DoctorTarget } from "@noelle/contracts";

// Shared target vocabulary + the maps the doctor uses to translate between the
// DoctorTarget lanes and the DB roles / heartbeat sources / pm2 app names.

// The lanes that actually ACTUATE (drive a browser extension that can post).
// The bridge + api-vm are infrastructure, not lanes. Lane-scoped signatures are
// evaluated once per lane (see signatures.ts / matchSignatures).
export const LANE_TARGETS = [
  "x-actuator",
  "linkedin-actuator",
  "reddit-intern",
] as const satisfies readonly DoctorTarget[];

// The lanes whose hands are a Chrome EXTENSION — an armed one keeps the bridge
// "armed" so an ext-disconnect-while-armed can page. reddit-intern is now here
// too: the reddit lane gained a browser extension (reddit-actuator) that drains
// stamped approvals through Chrome and emits a heartbeat via the bridge-sink, so
// an armed reddit lane can legitimately suffer (and page for) an ext-disconnect.
export const BROWSER_LANE_TARGETS = [
  "x-actuator",
  "linkedin-actuator",
  "reddit-intern",
] as const satisfies readonly DoctorTarget[];

export const ALL_TARGETS = [
  "x-actuator",
  "linkedin-actuator",
  "reddit-intern",
  "bridge",
  "api-vm",
] as const satisfies readonly DoctorTarget[];

export type LaneTarget = (typeof LANE_TARGETS)[number];

export function isLaneTarget(t: string): t is LaneTarget {
  return (LANE_TARGETS as readonly string[]).includes(t);
}

// agent_instances.role <-> DoctorTarget. The doctor reads arm state per role and
// maps it onto the lane it drives.
export const ROLE_TO_TARGET: Record<string, DoctorTarget> = {
  x_intern: "x-actuator",
  linkedin_intern: "linkedin-actuator",
  reddit_intern: "reddit-intern",
};

// Heartbeat source slug -> lane target. The browser actuators that emit a
// heartbeat (via their bridge-sink): x-actuator (Vega), linkedin-actuator
// (Lyra), and now reddit-actuator (Orion). Reddit is no longer excluded — the
// reddit lane gained a browser extension whose heartbeat source slug is exactly
// "reddit-actuator", mapped onto the existing reddit-intern LANE target (we do
// NOT mint a new DoctorTarget for it). NOTE: this MUST ship together with the
// reddit bridge-sink that emits the heartbeat (same PR) — otherwise probeHeartbeat
// would expect a heartbeat that never comes and fault the reddit lane.
export const HEARTBEAT_SOURCE_TO_TARGET: Record<string, DoctorTarget> = {
  "x-actuator": "x-actuator",
  "linkedin-actuator": "linkedin-actuator",
  "reddit-actuator": "reddit-intern",
};

// Default pm2 apps to restart for a target when the pm2 probe did not name a
// specific offline app (e.g. restart_worker climbed off a heartbeat fault, not a
// pm2 fault). The always-on brains of each lane; never the cost-gated/manual
// workers (send / feeder / ideation), which are intentionally stopped.
export const DEFAULT_RESTART_APPS: Record<DoctorTarget, string[]> = {
  "x-actuator": ["noelle-drafter", "noelle-classifier", "noelle-discovery"],
  "linkedin-actuator": [
    "noelle-linkedin-drafter",
    "noelle-linkedin-classifier",
    "noelle-linkedin-discovery",
  ],
  "reddit-intern": [
    "noelle-reddit-drafter",
    "noelle-reddit-classifier",
    "noelle-reddit-discovery",
  ],
  // bridge/api-vm restarts resolve to their configured app names in remediate.ts.
  bridge: [],
  "api-vm": [],
};
