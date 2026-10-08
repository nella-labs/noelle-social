import { shouldSelfReload } from "../lib/autonomy.js";
import { discoveryReadDue } from "./discovery-canary.js";

/** A queued comment is safe to rehydrate only in a persistent comment drain
 * at the ambient receiver read, where the tick is serialized and nothing is
 * being submitted. Timed Runs and queued DMs contain work a resumed drain does
 * not reconstruct. The ordinary autonomy alarm still requires empty pools. */
export function shouldReloadBuildAtReceiver(args: {
  runActive: boolean;
  poolsEmpty: boolean;
  hasResumePath: boolean;
  serializedReceiverSlot: boolean;
  mode?: "scheduled" | "drain";
  dmPoolSize: number;
  embeddedStamp: string | null;
  servedStamp: string | null;
  lastAttemptedStamp: string | null;
}): boolean {
  return shouldSelfReload({
    runActive: args.runActive,
    runResumable: args.hasResumePath && (args.serializedReceiverSlot
      ? args.mode === "drain" && args.dmPoolSize === 0
      : args.poolsEmpty),
    embeddedStamp: args.embeddedStamp,
    servedStamp: args.servedStamp,
    lastAttemptedStamp: args.lastAttemptedStamp,
  });
}

/** A newer build fixes an old content-script receiver without reloading the
 * LinkedIn page. Use the existing bounded page recovery only when no build is
 * waiting. Caller runs inside the serialized ambient tick. */
export async function recoverReceiverWithBuildHandoff(args: {
  isCurrent(): Promise<boolean>;
  checkNewBuild(): Promise<boolean>;
  recoverPage(): Promise<boolean>;
}): Promise<boolean> {
  if (!(await args.isCurrent())) return false;
  if (await args.checkNewBuild()) return true;
  if (!(await args.isCurrent())) return false;
  return args.recoverPage();
}

/** A healthy content receiver also needs a build handoff. Run this only at an
 * existing paced ambient browse in a persistent drain, never during a send. */
export async function handoffBuildAtHealthyBrowse(args: {
  mode?: "scheduled" | "drain";
  ambientBrowseSlot: boolean;
  discoveryEnabled: boolean;
  lastReadMs: number;
  nowMs: number;
  receiverHealthy: boolean;
  isCurrent(): Promise<boolean>;
  checkNewBuild(): Promise<boolean>;
}): Promise<boolean> {
  if (args.mode !== "drain" || !args.ambientBrowseSlot || !args.discoveryEnabled ||
      !discoveryReadDue(args.lastReadMs, args.nowMs) || !args.receiverHealthy ||
      !(await args.isCurrent())) return false;
  return args.checkNewBuild();
}
