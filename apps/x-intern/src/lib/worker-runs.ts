// The stamper itself lives in @noelle/runtime/worker-runs (consolidated from the
// four per-app copies). This file survives ONLY to keep Vega's worker-name union
// narrowed to what she may stamp into noelle.worker_runs — the dashboard reads
// that column, so the union must not widen to the other interns' kinds.
import { recordRun as recordRunAnyKind, type RecordRun } from "@noelle/runtime/worker-runs";

export type { RunHandle } from "@noelle/runtime/worker-runs";

export type WorkerKind =
  | "discovery"
  | "classifier"
  | "drafter"
  | "send"
  | "profiler"
  | "ideation"
  | "content-publish";

/** Same function, narrowed to Vega's kinds. Type-only binding, no wrapper. */
export const recordRun: RecordRun<WorkerKind> = recordRunAnyKind;
