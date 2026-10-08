// The stamper itself lives in @noelle/runtime/worker-runs (consolidated from the
// four per-app copies). This file survives ONLY to keep Orion's worker-name union
// narrowed to what he may stamp into noelle.worker_runs — the dashboard reads
// that column, so the union must not widen to the other interns' kinds.
import { recordRun as recordRunAnyKind, type RecordRun } from "@noelle/runtime/worker-runs";

export type { RunHandle } from "@noelle/runtime/worker-runs";

// Orion runs discovery → classifier → drafter. No send worker — it never posts
// to Reddit.
export type WorkerKind =
  | "discovery"
  | "classifier"
  | "drafter";

/** Same function, narrowed to Orion's kinds. Type-only binding, no wrapper. */
export const recordRun: RecordRun<WorkerKind> = recordRunAnyKind;
