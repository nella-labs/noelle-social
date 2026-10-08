import { isDiscoveryQuietTime, type DiscoverySchedule } from "@noelle/actuator-cdp";
import { isWriteCurfew } from "./curfew.js";

/** Discovery owns its own optional local-time window; other modes keep the old curfew. */
export function isXWriteQuiet(
  atMs: number,
  discoveryActive: boolean,
  legacyCurfewEnabled: boolean,
  schedule: DiscoverySchedule,
): boolean {
  return discoveryActive
    ? isDiscoveryQuietTime(atMs, schedule)
    : isWriteCurfew(atMs, legacyCurfewEnabled);
}
