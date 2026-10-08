import { run } from "./platform.js";
import { readEnvFile } from "./env-writer.js";

/**
 * Deploy-failure alerting for the native sync loop.
 *
 * NOELLE_ALERT_CMD names an executable, optionally with leading flags (for
 * example a Pushover wrapper script). On a build, restart, or smoke failure
 * the deploy invokes it as:
 *
 *   <cmd> [configured flags] -c deploy-failure -m "<short message>"
 *
 * Resolution order: process.env first, then ~/.noelle/.env (the launchd
 * agent does not source the env file). Unset means no-op. The send is
 * strictly fail-open and hard-capped at ALERT_TIMEOUT_MS: a hung notifier
 * must never wedge a tick that is holding the deploy lock.
 */

export type AlertResult = "sent" | "failed" | "unconfigured";

/** Hard cap on the notifier runtime; SIGKILL on expiry. */
export const ALERT_TIMEOUT_MS = 10_000;

/** Pick the alert command from the process env, falling back to the .env file. */
export function resolveAlertCmd(
  envFile: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const fromProcess = env.NOELLE_ALERT_CMD?.trim();
  if (fromProcess) return fromProcess;
  const fromFile = readEnvFile(envFile).NOELLE_ALERT_CMD?.trim();
  return fromFile || null;
}

/**
 * Pure: split the configured value into executable + argv. The value may
 * carry flags ("notify.sh --quiet"); spawning the whole string as one path
 * would ENOENT silently.
 */
export function alertInvocation(
  cmdValue: string,
  message: string,
): { cmd: string; args: string[] } | null {
  const parts = cmdValue.split(/\s+/).filter(Boolean);
  const cmd = parts.shift();
  if (!cmd) return null;
  return { cmd, args: [...parts, "-c", "deploy-failure", "-m", message] };
}

/**
 * Fire the alert command if configured. "sent" means it ran and exited 0;
 * "failed" means it was configured but did not (the caller should warn);
 * "unconfigured" means no-op. Never throws.
 */
export async function sendDeployAlert(
  envFile: string,
  message: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs: number = ALERT_TIMEOUT_MS,
): Promise<AlertResult> {
  const value = resolveAlertCmd(envFile, env);
  if (!value) return "unconfigured";
  const invocation = alertInvocation(value, message);
  if (!invocation) return "unconfigured";
  try {
    const r = await run(invocation.cmd, invocation.args, { allowFailure: true, timeoutMs });
    return r.code === 0 ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
