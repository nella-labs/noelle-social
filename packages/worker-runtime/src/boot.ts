import type { Logger } from "./logger.js";

export const EX_OK = 0;
export const EX_CONFIG = 78;
export const EX_TEMPFAIL = 75;

export type BootCheckKind = "config" | "transient";

export interface BootCheck {
  name: string;
  // `config` = bad/missing token, exit 78. `transient` = network/temporary,
  // exit 75. Under systemd the codes drive backoff policy; native pm2 ignores
  // exit-code semantics (autorestart + max_restarts only) — the taxonomy still
  // matters for the log line and for anything reading the exit status.
  kind?: BootCheckKind;
  run: () => Promise<void>;
}

export type BootResult =
  | { ok: true }
  | { ok: false; exitCode: number; failedCheck: string; error: Error };

export async function runBootChecks(args: {
  log: Logger;
  checks: BootCheck[];
}): Promise<BootResult> {
  for (const check of args.checks) {
    try {
      await check.run();
      args.log.info({ check: check.name }, "boot check ok");
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const exitCode = (check.kind ?? "config") === "transient" ? EX_TEMPFAIL : EX_CONFIG;
      args.log.fatal({ check: check.name, err: error.message, exitCode }, "boot check failed");
      return { ok: false, exitCode, failedCheck: check.name, error };
    }
  }
  return { ok: true };
}
