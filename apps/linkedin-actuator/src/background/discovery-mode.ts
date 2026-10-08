import { DISCOVERY_CANARY_KEY } from "./discovery-canary.js";
import {
  DISCOVERY_SCHEDULE_KEY, isDiscoveryQuietTime, parseDiscoverySchedule,
} from "@noelle/actuator-cdp";
import { isWriteCurfew } from "../lib/curfew.js";

type Storage = {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
};

/** Discovery's saved window takes precedence over an existing Auto run's curfew. */
export async function discoveryWriteGate(
  storage: Pick<Storage, "get">,
  atMs: number,
  legacyCurfewEnabled: boolean,
): Promise<{ held: boolean; message?: string }> {
  let values: Record<string, unknown>;
  try {
    values = await storage.get([DISCOVERY_CANARY_KEY, DISCOVERY_SCHEDULE_KEY]);
  } catch {
    // An unreadable schedule must not silently bypass a configured quiet window.
    return { held: true, message: "schedule unavailable — holding comments/DMs" };
  }
  if (values[DISCOVERY_CANARY_KEY] === true) {
    const schedule = parseDiscoverySchedule(values[DISCOVERY_SCHEDULE_KEY]);
    return isDiscoveryQuietTime(atMs, schedule)
      ? { held: true, message: `quiet window ${schedule.start}–${schedule.end} — comments/DMs paused (likes still on)` }
      : { held: false };
  }
  return isWriteCurfew(atMs, legacyCurfewEnabled)
    ? { held: true, message: "overnight pause — no comments/DMs 1:00–9:00 (likes still on)" }
    : { held: false };
}

/** Arm the standing Auto run without replacing work already in progress. */
export async function activateBrowserDiscovery(args: {
  storage: Storage;
  keys: { drainIntent: string; stopDay: string; remoteState: string };
  loadStatus(): Promise<"running" | "idle" | null>;
  startDrain(): Promise<void>;
}): Promise<"already-running" | "started"> {
  await args.storage.set({
    [DISCOVERY_CANARY_KEY]: true,
    [args.keys.drainIntent]: { curfew: false },
  });
  await args.storage.remove([args.keys.stopDay, args.keys.remoteState]);
  if ((await args.loadStatus()) === "running") return "already-running";
  await args.startDrain();
  return "started";
}
