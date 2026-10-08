import type { Logger } from "./logger.js";

/**
 * The generic poll-and-sleep worker loop. Every intern worker process runs one
 * of these forever: list the active instances, tick each one (errors isolated
 * per tick), sleep, repeat. Sleeping AFTER the sweep means ticks never overlap
 * and the loop structurally cannot drift into concurrent runs.
 *
 * Generic over the instance shape — each app's ActiveInstance differs (Vega
 * carries policy caps, Nova carries the feeder config), and the loop only
 * needs an `id` for the error log line.
 */
export interface RunWorkerLoopArgs<TInstance extends { id: string }> {
  log: Logger;
  /** Worker kind label ("discovery", "drafter", …). Carried for call-site
   *  self-documentation; the logger already stamps it on every line. */
  kind: string;
  pollMs: number;
  idlePollMs: number;
  listActive: () => Promise<TInstance[]>;
  onTick: (instance: TInstance) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  shouldStop?: () => boolean;
}

export async function runWorkerLoop<TInstance extends { id: string }>(
  args: RunWorkerLoopArgs<TInstance>,
): Promise<void> {
  const sleep = args.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const shouldStop = args.shouldStop ?? (() => false);

  while (!shouldStop()) {
    const instances = await args.listActive();
    if (instances.length === 0) {
      args.log.debug({}, "no active instances; idling");
      await sleep(args.idlePollMs);
      continue;
    }
    for (const inst of instances) {
      try {
        await args.onTick(inst);
      } catch (err) {
        args.log.error({ err: (err as Error).message, instance: inst.id }, "tick failed");
      }
    }
    await sleep(args.pollMs);
  }
}

// Common SIGTERM handler used by every entrypoint.
export function installShutdown(log: Logger): () => boolean {
  let stop = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      log.info({ signal: sig }, "shutdown requested");
      stop = true;
    });
  }
  return () => stop;
}
