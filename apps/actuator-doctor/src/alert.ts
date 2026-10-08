import { execFile } from "node:child_process";
import type { Logger } from "./logger.js";

// A DUMB, un-crashable failure reporter. It shells `${cmd} -c <category> -m <msg>`
// and swallows EVERYTHING. The reporter must never be able to take down the job
// it reports on (designing-loops: the alerter is dumber than the watched job).
//
// - execFile (not exec) => no shell => no quoting/interpolation hazards, no jq.
// - hard 10s timeout so a wedged notify.sh can't stall a tick.
// - every failure path (spawn ENOENT, non-zero exit, timeout, throw) is caught
//   and logged, never rethrown.
// - NOELLE_DOCTOR_DRYRUN routes to a log line instead of firing the command.

export interface AlertDeps {
  cmd: string;
  dryrun: boolean;
  logger: Logger;
}

export type AlertFn = (category: string, message: string) => Promise<void>;

export function makeAlert(deps: AlertDeps): AlertFn {
  return async function alert(category: string, message: string): Promise<void> {
    if (deps.dryrun) {
      deps.logger.warn({ category, message, dryrun: true }, "alert (dry-run, not sent)");
      return;
    }
    if (!deps.cmd.trim()) {
      deps.logger.warn({ category, message }, "alert (command not configured)");
      return;
    }
    try {
      await new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        try {
          const child = execFile(
            deps.cmd,
            ["-c", category, "-m", message],
            { timeout: 10_000 },
            (err) => {
              if (err) {
                deps.logger.warn(
                  { category, err: String(err) },
                  "alert command failed (swallowed)",
                );
              }
              done();
            },
          );
          // ENOENT / spawn errors arrive on the child, not the callback.
          child.on("error", (err) => {
            deps.logger.warn({ category, err: String(err) }, "alert spawn failed (swallowed)");
            done();
          });
        } catch (err) {
          deps.logger.warn({ category, err: String(err) }, "alert threw (swallowed)");
          done();
        }
      });
    } catch {
      // Truly never throw — an alert failure must not surface to the loop.
    }
  };
}
