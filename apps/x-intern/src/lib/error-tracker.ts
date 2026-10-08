import type { Sql } from "postgres";
import type { Logger } from "./logger.js";

/**
 * In-process consecutive-5xx counter per (agent instance, error window).
 *
 * Drives the `pause_on_5xx` policy column on noelle.agent_instances: when
 * an instance hits PAUSE_THRESHOLD consecutive 5xx Bedrock errors within
 * PAUSE_WINDOW_MS, flip its `status` to `paused` so the drafter stops
 * burning the budget on Bedrock retries until the founder re-enables it
 * from the dashboard.
 *
 * Lifecycle:
 *   - on any successful tick → counter resets to 0
 *   - on a 5xx error → counter increments; if the previous error was
 *     older than PAUSE_WINDOW_MS, the window resets first
 *   - on counter === PAUSE_THRESHOLD AND pause_on_5xx === true → SQL
 *     update to set status='paused' and counter resets so we don't
 *     re-trigger if the worker stays up
 *
 * State is in-memory only — a worker restart effectively resets the
 * counter, which is acceptable for a "3 in 10 min" policy: if Bedrock is
 * really down, the next attempt after restart will produce a new 5xx and
 * the counter walks back up.
 */

const PAUSE_THRESHOLD = 3;
const PAUSE_WINDOW_MS = 10 * 60 * 1000;

interface CounterEntry {
  count: number;
  firstErrorAt: number;
}

const counters = new Map<string, CounterEntry>();

/**
 * Returns true when the error looks like a server-side failure from
 * a model backend (Bedrock 5xx, generic 5xx). Network-layer errors
 * with no status are treated as transient too — they have the same
 * "agent can't reach the upstream" semantics as a real 5xx.
 */
export function isServerSideModelError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: number; name?: string; message?: string };
  if (typeof e.status === "number") return e.status >= 500;
  if (e.name === "BedrockError" || e.name === "PushoverError") {
    return true;
  }
  const msg = typeof e.message === "string" ? e.message : "";
  return /ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed|network error/i.test(msg);
}

export interface RecordErrorArgs {
  sql: Sql;
  log: Logger;
  instanceId: string;
  pauseOn5xx: boolean;
}

/**
 * Call this when a tick fails with a 5xx-shaped error. Bumps the
 * per-instance counter and, on threshold + policy enabled, flips the
 * instance to paused.
 *
 * Returns true if the instance was paused as a result.
 */
export async function recordModelError(args: RecordErrorArgs): Promise<boolean> {
  const { sql, log, instanceId, pauseOn5xx } = args;
  const now = Date.now();
  const existing = counters.get(instanceId);

  let entry: CounterEntry;
  if (!existing || now - existing.firstErrorAt > PAUSE_WINDOW_MS) {
    entry = { count: 1, firstErrorAt: now };
  } else {
    entry = { count: existing.count + 1, firstErrorAt: existing.firstErrorAt };
  }
  counters.set(instanceId, entry);

  if (!pauseOn5xx) {
    log.info(
      { instanceId, count: entry.count },
      "model 5xx recorded; pause_on_5xx disabled, not flipping",
    );
    return false;
  }

  if (entry.count < PAUSE_THRESHOLD) return false;

  try {
    await sql`
      update noelle.agent_instances
      set status = 'paused', updated_at = now()
      where id = ${instanceId}
        and status = 'active'
    `;
    counters.delete(instanceId);
    log.warn(
      { instanceId, threshold: PAUSE_THRESHOLD, windowMs: PAUSE_WINDOW_MS },
      "agent paused after consecutive 5xx errors",
    );
    return true;
  } catch (err) {
    log.error(
      { instanceId, err: (err as Error).message },
      "failed to flip agent to paused after 5xx threshold",
    );
    return false;
  }
}

/** Call after a successful tick. */
export function resetModelErrorCounter(instanceId: string): void {
  counters.delete(instanceId);
}

/** Test-only. */
export function _resetAllForTests(): void {
  counters.clear();
}
