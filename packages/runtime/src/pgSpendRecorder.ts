import type { Sql } from "postgres";
import type { SpendRecorder } from "./spendRecorder.js";
import { PgSpendRecorderOwner, type SpendRecordingFailure } from "./pgSpendRecorderOwner.js";
export { SpendRecordingError } from "./pgSpendRecorderOwner.js";
export type { SpendRecordingCategory, SpendRecordingFailure } from "./pgSpendRecorderOwner.js";

export interface PgSpendRecorderOptions {
  /** Total time from admission through query completion, including queue wait. */
  deadlineMs?: number;
  /** Maximum admitted receipts, including the receipt currently being written. */
  maxPending?: number;
  /** Close the owned pool after inactivity so it does not hold the process open. */
  idleTimeoutMs?: number;
  onFailure?: (failure: SpendRecordingFailure) => void;
}

const owners = new WeakMap<Sql, PgSpendRecorderOwner>();

function bounded(value: number | undefined, fallback: number, max: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.min(max, Math.max(1, Math.floor(value)))
    : fallback;
}

function defaultFailure(failure: SpendRecordingFailure): void {
  console.warn("Spend receipt could not be recorded", failure);
}

/**
 * Record exact instance attribution; failed writes are observable and never retried.
 * The first recorder sets shared limits for this parent pool; failure callbacks remain per recorder.
 */
export function createPgSpendRecorder(sql: Sql, options: PgSpendRecorderOptions = {}): SpendRecorder {
  let owner = owners.get(sql);
  if (!owner) {
    owner = new PgSpendRecorderOwner(sql, {
      deadlineMs: bounded(options.deadlineMs, 2500, 30_000),
      maxPending: bounded(options.maxPending, 32, 200),
      idleTimeoutMs: bounded(options.idleTimeoutMs, 1000, 30_000),
    });
    owners.set(sql, owner);
  }
  const onFailure = options.onFailure ?? defaultFailure;
  return { record: (row) => owner.record(row, onFailure) };
}
